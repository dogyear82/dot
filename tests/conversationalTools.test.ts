import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeConversationalToolCall, renderConversationalToolResult, type ConversationalToolContext } from "../src/conversationalTools.js";
import { initializePersistence } from "../src/persistence.js";

function createPersistence() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-conv-tools-"));
  const sqlitePath = path.join(tempDir, "dot.sqlite");
  const persistence = initializePersistence(tempDir, sqlitePath);

  return {
    persistence,
    cleanup() {
      persistence.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

function createContext(overrides: Partial<ConversationalToolContext> = {}): ConversationalToolContext {
  return {
    calendarClient: {
      async listUpcomingEvents() {
        return [];
      }
    },
    persistence: overrides.persistence!,
    groundedAnswerService: undefined,
    worldLookupAdapters: undefined,
    articleReader: undefined,
    ...overrides
  };
}

test("conversational tool executor returns a common final_text result for reminder.show", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.createReminder("stretch", "2027-04-08T10:00:00.000Z");

    const result = await executeConversationalToolCall({
      call: {
        toolName: "reminder.show",
        args: {},
        userMessage: "show my reminders"
      },
      context: createContext({ persistence })
    });

    assert.equal(result.toolName, "reminder.show");
    assert.equal(result.status, "success");
    assert.equal(result.presentation, "final_text");
    assert.equal(typeof result.payload.text, "string");

    const rendered = await renderConversationalToolResult({
      result,
      userMessage: "show my reminders",
      renderService: {
        async renderToolResult() {
          throw new Error("final_text should not invoke llm rendering");
        }
      }
    });

    assert.match(rendered.reply, /Pending reminders/i);
    assert.equal(rendered.route, undefined);
  } finally {
    cleanup();
  }
});

test("conversational tool executor returns a common llm_render result for calendar.show", async () => {
  const { persistence, cleanup } = createPersistence();
  const capturedRenderCalls: Array<{
    userMessage: string;
    payload: Record<string, unknown>;
    systemPrompt: string;
  }> = [];

  try {
    const result = await executeConversationalToolCall({
      call: {
        toolName: "calendar.show",
        args: {},
        userMessage: "what's on my calendar?"
      },
      context: createContext({
        persistence,
        calendarClient: {
          async listUpcomingEvents() {
            return [
              {
                id: "evt-1",
                subject: "Planning",
                startAt: "2027-04-08T10:00:00.000Z",
                endAt: "2027-04-08T11:00:00.000Z",
                webLink: "https://example.test/planning"
              }
            ];
          }
        }
      })
    });

    assert.equal(result.toolName, "calendar.show");
    assert.equal(result.status, "success");
    assert.equal(result.presentation, "llm_render");
    assert.equal(typeof result.renderInstructions?.systemPrompt, "string");

    const rendered = await renderConversationalToolResult({
      result,
      userMessage: "what's on my calendar?",
      renderService: {
        async renderToolResult(params) {
          capturedRenderCalls.push({
            userMessage: params.userMessage,
            payload: params.payload,
            systemPrompt: params.renderInstructions.systemPrompt
          });
          return {
            route: "hosted",
            powerStatus: "engaged",
            reply: "You have Planning at 10:00."
          };
        }
      }
    });

    assert.equal(capturedRenderCalls.length, 1);
    assert.equal(capturedRenderCalls[0]?.userMessage, "what's on my calendar?");
    assert.equal(capturedRenderCalls[0]?.systemPrompt, result.renderInstructions?.systemPrompt);
    assert.deepEqual(capturedRenderCalls[0]?.payload.events, [
      {
        index: 1,
        subject: "Planning",
        startAt: "2027-04-08T10:00:00.000Z",
        endAt: "2027-04-08T11:00:00.000Z",
        webLink: "https://example.test/planning"
      }
    ]);
    assert.equal(rendered.reply, "You have Planning at 10:00.");
    assert.equal(rendered.route, "hosted");
  } finally {
    cleanup();
  }
});

test("conversational tool executor returns llm_render payloads for news/current-events tools and preserves sessions", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const topicLookup = await executeConversationalToolCall({
      call: {
        toolName: "world.lookup",
        args: { query: "what's happening in Myanmar right now?" },
        userMessage: "what's happening in Myanmar right now?",
        conversationId: "conv-1"
      },
      context: createContext({
        persistence,
        worldLookupAdapters: {
          newsdata: {
            source: "newsdata",
            async lookup({ query }) {
              assert.match(query, /myanmar/i);
              return {
                source: "newsdata",
                evidence: [
                  {
                    source: "newsdata",
                    title: "Myanmar junta extends emergency rule",
                    url: "https://example.test/myanmar",
                    snippet: "Reuters reports the military government extended emergency rule.",
                    publishedAt: "2026-04-13T08:00:00Z",
                    publisher: "Reuters",
                    confidence: "high"
                  }
                ]
              };
            }
          }
        },
        articleReader: {
          async read() {
            return {
              articles: [
                {
                  url: "https://example.test/myanmar",
                  title: "Myanmar junta extends emergency rule",
                  source: "newsdata",
                  publisher: "Reuters",
                  publishedAt: "2026-04-13T08:00:00Z",
                  content: "Article text",
                  excerpt: "Article excerpt"
                }
              ],
              failures: []
            };
          }
        }
      })
    });

    assert.equal(topicLookup.presentation, "llm_render");
    assert.equal(topicLookup.status, "success");
    assert.equal(topicLookup.payload.mode, "world_lookup");
    assert.equal((topicLookup.payload.articles as Array<{ title: string }>).length, 1);
    assert.match(topicLookup.detail ?? "", /topicSessionSaved=yes/);
    assert.equal(persistence.getLatestNewsBrowseSession("conv-1")?.kind, "topic_lookup");

    const followUp = await executeConversationalToolCall({
      call: {
        toolName: "news.follow_up",
        args: { query: "tell me more about the first one" },
        userMessage: "tell me more about the first one",
        conversationId: "conv-1"
      },
      context: createContext({
        persistence,
        articleReader: {
          async read() {
            return {
              articles: [
                {
                  url: "https://example.test/myanmar",
                  title: "Myanmar junta extends emergency rule",
                  source: "newsdata",
                  publisher: "Reuters",
                  publishedAt: "2026-04-13T08:00:00Z",
                  content: "Article text",
                  excerpt: "Article excerpt"
                }
              ],
              failures: []
            };
          }
        }
      })
    });

    assert.equal(followUp.presentation, "llm_render");
    assert.equal(followUp.payload.mode, "news_follow_up");
    assert.equal((followUp.payload.selectedItem as { ordinal: number }).ordinal, 1);
  } finally {
    cleanup();
  }
});
