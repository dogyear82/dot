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
