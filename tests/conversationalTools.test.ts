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

test("conversational tool executor handles confirmed reminder mutations and calendar.remind through the common final_text contract", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const addResult = await executeConversationalToolCall({
      call: {
        toolName: "reminder.add",
        args: {
          duration: "10m",
          message: "stretch",
          confirmed: "yes"
        },
        userMessage: "remind me to stretch in 10 minutes"
      },
      context: createContext({ persistence })
    });
    assert.equal(addResult.presentation, "final_text");
    assert.match(String(addResult.payload.text), /Saved reminder #1/i);

    const ackResult = await executeConversationalToolCall({
      call: {
        toolName: "reminder.ack",
        args: {
          id: 1
        },
        userMessage: "acknowledge reminder 1"
      },
      context: createContext({ persistence })
    });
    assert.equal(ackResult.presentation, "final_text");
    assert.match(String(ackResult.payload.text), /Acknowledged reminder #1/i);

    const calendarRemind = await executeConversationalToolCall({
      call: {
        toolName: "calendar.remind",
        args: {
          index: 1,
          leadTime: "15m"
        },
        userMessage: "remind me about the first event 15 minutes early"
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
                webLink: null
              }
            ];
          }
        }
      })
    });

    assert.equal(calendarRemind.presentation, "final_text");
    assert.match(String(calendarRemind.payload.text), /Saved reminder #2/i);
  } finally {
    cleanup();
  }
});

test("conversational reminder tool returns clarify when required args are missing", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const missingDuration = await executeConversationalToolCall({
      call: {
        toolName: "reminder.add",
        args: {
          message: "stretch"
        },
        userMessage: "set a reminder to stretch"
      },
      context: createContext({ persistence })
    });
    assert.equal(missingDuration.status, "clarify");
    assert.equal(missingDuration.presentation, "final_text");
    assert.match(String(missingDuration.payload.text), /What duration from now/i);

    const missingMessage = await executeConversationalToolCall({
      call: {
        toolName: "reminder.add",
        args: {
          duration: "10m"
        },
        userMessage: "set a reminder in 10 minutes"
      },
      context: createContext({ persistence })
    });
    assert.equal(missingMessage.status, "clarify");
    assert.equal(missingMessage.presentation, "final_text");
    assert.match(String(missingMessage.payload.text), /What should the reminder say/i);
  } finally {
    cleanup();
  }
});

test("conversational reminder tool requires confirmation before saving", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const confirmation = await executeConversationalToolCall({
      call: {
        toolName: "reminder.add",
        args: {
          duration: "15 hours",
          message: "stretch"
        },
        userMessage: "set a reminder in 15 hours to stretch"
      },
      context: createContext({ persistence })
    });

    assert.equal(confirmation.status, "requires_confirmation");
    assert.equal(confirmation.presentation, "final_text");
    assert.match(String(confirmation.payload.text), /Want me to save it\?/i);

    const reminders = persistence.listPendingReminders();
    assert.equal(reminders.length, 0);
  } finally {
    cleanup();
  }
});

test("conversational reminder tool accepts time aliases and natural duration phrases", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const confirmation = await executeConversationalToolCall({
      call: {
        toolName: "reminder.add",
        args: {
          time: "14 hours",
          message: "stretch"
        },
        userMessage: "set a reminder in 14 hours to stretch"
      },
      context: createContext({ persistence })
    });

    assert.equal(confirmation.status, "requires_confirmation");
    assert.match(String(confirmation.payload.text), /14 hours/i);
  } finally {
    cleanup();
  }
});

test("conversational reminder tool rejects unsupported absolute datetime phrasing for now", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const clarification = await executeConversationalToolCall({
      call: {
        toolName: "reminder.add",
        args: {
          time: "9am tomorrow",
          message: "stretch"
        },
        userMessage: "set a reminder for 9am tomorrow to stretch"
      },
      context: createContext({ persistence })
    });

    assert.equal(clarification.status, "clarify");
    assert.match(String(clarification.payload.text), /duration from now/i);
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
