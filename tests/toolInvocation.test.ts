import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initializePersistence } from "../src/persistence.js";
import {
  buildAddressedToolInferencePrompt,
  buildPendingToolResolutionPrompt,
  buildToolInferencePrompt,
  executeToolDecision,
  parseExplicitToolDecision,
  parseAddressedToolDecision,
  parseToolDecision
} from "../src/toolInvocation.js";

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

test("parseToolDecision accepts respond and execute_tool responses", () => {
  assert.deepEqual(parseToolDecision('{"decision":"respond","reason":"just chatting","response":"Hey there."}'), {
    decision: "respond",
    reason: "just chatting",
    response: "Hey there."
  });

  assert.deepEqual(
    parseToolDecision(
      '{"decision":"execute_tool","toolName":"reminder.add","reason":"clear reminder intent","confidence":"high","args":{"duration":"10m","message":"stretch"}}'
    ),
    {
      decision: "execute_tool",
      toolName: "reminder.add",
      reason: "clear reminder intent",
      confidence: "high",
      args: {
        duration: "10m",
        message: "stretch"
      }
    }
  );

  assert.deepEqual(
    parseToolDecision(
      '{"decision":"execute_tool","toolName":"reminder.add","reason":"owner supplied a specific reminder time","confidence":"high","args":{"message":"return the lens protector","dueAt":"2026-04-16T01:00:00.000Z"}}'
    ),
    {
      decision: "execute_tool",
      toolName: "reminder.add",
      reason: "owner supplied a specific reminder time",
      confidence: "high",
      args: {
        message: "return the lens protector",
        dueAt: "2026-04-16T01:00:00.000Z"
      }
    }
  );

  assert.deepEqual(
    parseToolDecision(
      '{"decision":"execute_tool","toolName":"weather.lookup","reason":"owner is asking for weather information","confidence":"high","args":{"location":"Phoenix, AZ"}}'
    ),
    {
      decision: "execute_tool",
      toolName: "weather.lookup",
      reason: "owner is asking for weather information",
      confidence: "high",
      args: {
        location: "Phoenix, AZ"
      }
    }
  );
});

test("buildToolInferencePrompt documents dueAt for specific reminder times", () => {
  const prompt = buildToolInferencePrompt("set a reminder for tomorrow at 6pm to return the package");

  assert.match(prompt, /prefer args\.dueAt as an ISO 8601 timestamp/i);
  assert.match(prompt, /Decide whether you should respond directly or execute one of the available tools\./i);
  assert.match(prompt, /If the latest owner message is an identifiable request for an available tool, return execute_tool even when some required arguments are missing\./i);
  assert.match(prompt, /If the latest owner message is ordinary conversation, commentary, thanks, correction/i);
  assert.match(prompt, /Respond is a non-operational conversation path only\./i);
  assert.match(prompt, /do not claim or imply that you sent, set, scheduled, created, updated, granted, deleted, changed, or otherwise performed a real side-effecting action\./i);
  assert.match(prompt, /Any reply that says you already performed a real action must come from execute_tool, not respond\./i);
  assert.match(prompt, /Use only the exact tool names and arg keys listed below\./i);
  assert.match(prompt, /Interpret relative reminder phrases like `today`, `tomorrow`/i);
  assert.match(prompt, /do not let earlier turns override a clear latest request\./i);
  assert.match(prompt, /"toolName":"reminder\.add".*"args":\{\}/i);
  assert.match(prompt, /"toolName":"calendar\.remind".*"args":\{\}/i);
  assert.match(prompt, /- reminder\.add: message, optional duration, optional dueAt/i);
  assert.match(prompt, /- weather\.lookup: optional location, optional city, optional admin1, optional country/i);
  assert.match(prompt, /Use weather\.lookup for weather questions/i);
  assert.match(prompt, /structured args\.city, args\.admin1, and args\.country/i);
  assert.match(prompt, /"dueAt":"2026-04-16T01:00:00\.000Z"/i);
  assert.match(prompt, /"toolName":"weather\.lookup".*"location":"Phoenix, AZ"/i);
  assert.match(prompt, /"toolName":"weather\.lookup".*"city":"San Gabriel".*"admin1":"California".*"country":"United States"/i);
  assert.match(prompt, /execute_tool weather lookup/i);
  assert.match(prompt, /execute_tool weather clarification follow-up/i);
  assert.match(prompt, /execute_tool incomplete reminder/i);
  assert.match(prompt, /execute_tool complete reminder/i);
  assert.match(prompt, /repaired current-events lookup/i);
  assert.match(prompt, /respond: .*I'm right here\./i);
  assert.match(prompt, /disallowed respond: .*I set that reminder for tomorrow\./i);
});

test("parseAddressedToolDecision accepts addressed false and addressed true decisions", () => {
  assert.deepEqual(parseAddressedToolDecision('{"addressed":false,"reason":"message is general channel chatter"}'), {
    addressed: false,
    reason: "message is general channel chatter"
  });

  assert.deepEqual(
    parseAddressedToolDecision(
      '{"addressed":true,"decision":"execute_tool","toolName":"reminder.add","reason":"the user is asking Dot to create a reminder but did not provide full details","confidence":"high","args":{}}'
    ),
    {
      addressed: true,
      decision: "execute_tool",
      toolName: "reminder.add",
      reason: "the user is asking Dot to create a reminder but did not provide full details",
      confidence: "high",
      args: {}
    }
  );
});

test("buildAddressedToolInferencePrompt documents the addressedness contract", () => {
  const prompt = buildAddressedToolInferencePrompt("I want another reminder set");

  assert.match(prompt, /neutral classifier for ambiguous Discord messages involving Dot/i);
  assert.match(prompt, /deterministic fast paths are already handled before this step/i);
  assert.match(prompt, /If the latest message is not directed to Dot, return addressed false/i);
  assert.match(prompt, /Incomplete tool requests still use execute_tool/i);
  assert.match(prompt, /A respond output is conversation only/i);
  assert.match(prompt, /Return exactly one of these JSON shapes:/i);
  assert.match(prompt, /"addressed":false/i);
  assert.match(prompt, /"addressed":true,"decision":"execute_tool"/i);
  assert.match(prompt, /Latest message: "I want another reminder set"/i);
  assert.match(prompt, /Use weather\.lookup when the user wants current weather or a forecast/i);
  assert.match(prompt, /Latest message: "what is the weather in Phoenix, AZ tomorrow\?"/i);
  assert.match(prompt, /Latest message: "San Gabriel California"/i);
});

test("buildPendingToolResolutionPrompt keeps respond non-operational", () => {
  const prompt = buildPendingToolResolutionPrompt({
    userMessage: "never mind",
    toolName: "reminder.add",
    existingArgs: {
      message: "walk the dog"
    },
    originalUserMessage: "set a reminder to walk the dog",
    pendingStatus: "clarify",
    pendingPrompt: "When should I set it?"
  });

  assert.match(prompt, /Respond is a non-operational conversation path only\./i);
  assert.match(prompt, /do not claim or imply that you already performed a real side-effecting action\./i);
  assert.match(prompt, /must come from execute_tool, not respond\./i);
  assert.match(prompt, /Use only the exact tool name already provided and only the exact arg keys that tool supports, except that the reserved meta-arg `confirmed` may be returned during pending confirmation\./i);
  assert.match(prompt, /owner cancelled the pending tool flow/i);
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
