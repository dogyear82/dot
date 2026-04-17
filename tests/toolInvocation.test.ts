import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initializePersistence } from "../src/persistence.js";
import {
  buildAddressedToolInferencePrompt,
  buildPendingToolResolutionPrompt,
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
  const prompt = buildAddressedToolInferencePrompt(false);

  assert.match(prompt, /Your name is Dot, and you are a neutral intent classifier/i);
  assert.match(prompt, /If the latest message is not addressed to you, reply with:/i);
  assert.match(prompt, /If the latest message is requesting a tool or needs a tool to formulate a reponse, reply with:/i);
  assert.match(prompt, /If the latest message is requesting a tool but is missing some or all of the required information to execute the tool, reply with:/i);
  assert.match(prompt, /"addressed":false/i);
  assert.match(prompt, /"addressed":true,"decision":"execute_tool"/i);
  assert.match(prompt, /"toolName":"news\.briefing".*"Ukraine today"/i);
  assert.match(prompt, /toolName":"prompt_injection\.alert"/i);
  assert.match(prompt, /- weather\.lookup: optional location, optional city, optional admin1, optional country/i);
});

test("buildAddressedToolInferencePrompt can force addressed true for deterministic fast paths", () => {
  const prompt = buildAddressedToolInferencePrompt(true);

  assert.match(prompt, /always set 'addressed' to true/i);
  assert.doesNotMatch(prompt, /"addressed":false/);
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
