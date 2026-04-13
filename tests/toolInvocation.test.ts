import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initializePersistence } from "../src/persistence.js";
import { executeToolDecision, inferDeterministicToolDecision, parseExplicitToolDecision, parseToolDecision } from "../src/toolInvocation.js";

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

test("parseExplicitToolDecision turns incomplete tool commands into clarification prompts", () => {
  assert.deepEqual(parseExplicitToolDecision("!reminder add"), {
    decision: "clarify",
    toolName: "reminder.add",
    reason: "owner used reminder add without both duration and message",
    question: "When should I remind you, and what should I remind you about?"
  });

  assert.deepEqual(parseExplicitToolDecision("!calendar remind"), {
    decision: "clarify",
    toolName: "calendar.remind",
    reason: "owner used calendar remind without an event index",
    question: "Which calendar event should I create a reminder for? Use the index from `!calendar show`."
  });
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

    assert.equal(reminderReply.status, "executed");
    assert.match(reminderReply.reply, /Saved reminder #1/);

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

    assert.equal(calendarReply.status, "executed");
    assert.match(calendarReply.reply, /Saved reminder #2/);
  } finally {
    cleanup();
  }
});

test("executeToolDecision can defer or block a registered tool through the policy engine", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.upsertContact({
      canonicalName: "Michelle Smith",
      trustLevel: "approval_required",
      aliases: ["Shelly"]
    });

    const requiresConfirmation = await executeToolDecision({
      calendarClient: {
        async listUpcomingEvents() {
          return [];
        }
      },
      decision: {
        decision: "execute",
        toolName: "reminder.show",
        reason: "test policy hook",
        args: {
          contact: "Shelly"
        }
      },
      persistence,
      registry: {
        "reminder.show": {
          toolName: "reminder.show",
          policy: {
            actionType: "message.send",
            getContactQuery(args) {
              return typeof args.contact === "string" ? args.contact : null;
            }
          },
          execute() {
            return "should not execute";
          }
        }
      }
    });

    assert.equal(requiresConfirmation.status, "requires_confirmation");
    assert.match(requiresConfirmation.reply, /requires explicit approval/i);

    persistence.upsertContact({
      canonicalName: "Mallory",
      trustLevel: "untrusted"
    });

    const blocked = await executeToolDecision({
      calendarClient: {
        async listUpcomingEvents() {
          return [];
        }
      },
      decision: {
        decision: "execute",
        toolName: "reminder.show",
        reason: "test policy hook",
        args: {
          contact: "Mallory"
        }
      },
      persistence,
      registry: {
        "reminder.show": {
          toolName: "reminder.show",
          policy: {
            actionType: "message.send",
            getContactQuery(args) {
              return typeof args.contact === "string" ? args.contact : null;
            }
          },
          execute() {
            return "should not execute";
          }
        }
      }
    });

    assert.equal(blocked.status, "blocked");
    assert.match(blocked.reply, /execution blocked/i);
  } finally {
    cleanup();
  }
});

test("executeToolDecision executes world.lookup and returns grounded reply metadata", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const result = await executeToolDecision({
      calendarClient: {
        async listUpcomingEvents() {
          return [];
        }
      },
      decision: {
        decision: "execute",
        toolName: "world.lookup",
        reason: "owner wants public facts",
        args: {
          query: "When is zebra mating season?"
        }
      },
      persistence,
      groundedAnswerService: {
        async generateGroundedReply(params) {
          assert.equal(params.bucket, "reference");
          assert.equal(params.selectedSources[0], "wikipedia");
          assert.equal(params.evidence[0]?.title, "Zebra");
          return {
            route: "local",
            powerStatus: "standby",
            reply: "According to Wikipedia, zebras breed seasonally.\n\nLinks:\n- https://en.wikipedia.org/wiki/Zebra"
          };
        }
      },
      worldLookupAdapters: {
        wikipedia: {
          source: "wikipedia",
          async lookup() {
            return {
              source: "wikipedia",
              evidence: [
                {
                  source: "wikipedia",
                  title: "Zebra",
                  url: "https://en.wikipedia.org/wiki/Zebra",
                  snippet: "Zebras breed seasonally.",
                  publishedAt: null,
                  confidence: "high"
                }
              ]
            };
          }
        }
      }
    });

    assert.equal(result.status, "executed");
    assert.equal(result.route, "local");
    assert.match(result.reply, /According to Wikipedia/i);
    assert.match(result.detail ?? "", /selectedSources=wikipedia/);
    assert.match(result.detail ?? "", /outcome=success/);
  } finally {
    cleanup();
  }
});
