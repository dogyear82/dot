import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initializePersistence } from "../src/persistence.js";
import { executeToolDecision, inferDeterministicToolDecision, parseToolDecision } from "../src/toolInvocation.js";

function createPersistence() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-tool-invoke-"));
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

test("parseToolDecision accepts execute and clarify responses", () => {
  assert.deepEqual(parseToolDecision('{"decision":"none","reason":"just chatting"}'), {
    decision: "none",
    reason: "just chatting"
  });

  assert.deepEqual(
    parseToolDecision('{"decision":"clarify","toolName":"reminder.add","reason":"missing duration","question":"When should I remind you?"}'),
    {
      decision: "clarify",
      toolName: "reminder.add",
      reason: "missing duration",
      question: "When should I remind you?"
    }
  );
});

test("inferDeterministicToolDecision catches obvious calendar-view requests", () => {
  assert.deepEqual(inferDeterministicToolDecision("what's my calendar looking like this week?"), {
    decision: "execute",
    toolName: "calendar.show",
    reason: "clear calendar-view intent from deterministic phrase matching",
    args: {}
  });

  assert.deepEqual(inferDeterministicToolDecision("Do I have any meetings or appointments today?"), {
    decision: "execute",
    toolName: "calendar.show",
    reason: "clear calendar-view intent from deterministic phrase matching",
    args: {}
  });

  assert.equal(inferDeterministicToolDecision("how's your day going?"), null);
});

test("executeToolDecision runs deterministic reminder and calendar handlers", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reminderReply = await executeToolDecision({
      calendarClient: {
        async listUpcomingEvents() {
          return [];
        }
      },
      decision: {
        decision: "execute",
        toolName: "reminder.add",
        reason: "owner asked to remember something",
        args: {
          duration: "10m",
          message: "stretch"
        }
      },
      persistence
    });

    assert.match(reminderReply, /Saved reminder #1/);

    const calendarReply = await executeToolDecision({
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
      },
      decision: {
        decision: "execute",
        toolName: "calendar.remind",
        reason: "owner wants a pre-meeting reminder",
        args: {
          index: 1,
          leadTime: "15m"
        }
      },
      persistence
    });

    assert.match(calendarReply, /Saved reminder #2/);
  } finally {
    cleanup();
  }
});
