import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initializePersistence } from "../src/persistence.js";
import { createPolicyEngine } from "../src/policyEngine.js";
import { handleContactCommand, handlePolicyCommand } from "../src/contacts.js";

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-policy-"));
  const sqlitePath = path.join(dataDir, "dot.sqlite");
  const persistence = initializePersistence(dataDir, sqlitePath);

  return {
    persistence,
    cleanup() {
      persistence.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

test("contact command stores canonical name aliases endpoints and trust separately from chat history", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reply = handleContactCommand({
      content: "!contact add Michelle Smith trusted alias=Shelly email=michelle@example.com phone=15551234567",
      conversationId: "channel-1",
      persistence
    });

    assert.match(reply, /Saved contact/);

    const profile = persistence.getContactByNameOrAlias("Shelly");
    assert(profile);
    assert.equal(profile.contact.canonicalName, "Michelle Smith");
    assert.equal(profile.contact.trustLevel, "trusted");
    assert.equal(profile.aliases[0]?.alias, "Shelly");
    assert.equal(profile.endpoints.map((endpoint) => `${endpoint.kind}:${endpoint.value}`).join(","), "email:michelle@example.com,phone:15551234567");
    assert.equal(persistence.listRecentConversationTurns("channel-1", 10).length, 0);
  } finally {
    cleanup();
  }
});

test("policy engine allows trusted contacts and blocks untrusted contacts deterministically", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.upsertContact({
      canonicalName: "Michelle",
      trustLevel: "trusted",
      aliases: ["Shelly"],
      endpoints: [{ kind: "email", value: "michelle@example.com" }]
    });
    persistence.upsertContact({
      canonicalName: "Mallory",
      trustLevel: "untrusted",
      endpoints: [{ kind: "email", value: "mallory@example.com" }]
    });

    const policyEngine = createPolicyEngine(persistence);
    const allow = policyEngine.evaluateOutboundAction({ actionType: "email.send", contactQuery: "Shelly" });
    assert.equal(allow.decision, "allow");
    assert.equal(allow.riskLevel, "low");

    const block = policyEngine.evaluateOutboundAction({ actionType: "email.send", contactQuery: "Mallory" });
    assert.equal(block.decision, "block");
    assert.equal(block.riskLevel, "high");
  } finally {
    cleanup();
  }
});

test("policy command creates a pending classification when a gated action references an unknown contact", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reply = handlePolicyCommand({
      content: "!policy check email.send Michelle",
      conversationId: "channel-1",
      persistence
    });

    assert.match(reply, /contact classification required/i);
    assert.match(reply, /!contact classify 1/i);

    const pending = persistence.getPendingContactClassification(1);
    assert(pending);
    assert.equal(pending.actionType, "email.send");
    assert.equal(pending.contactQuery, "Michelle");
  } finally {
    cleanup();
  }
});

test("contact classify stores the answer for a pending policy request and re-evaluates deterministically", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    handlePolicyCommand({
      content: "!policy check email.send Michelle",
      conversationId: "channel-1",
      persistence
    });

    const reply = handleContactCommand({
      content: "!contact classify 1 trusted email=michelle@example.com alias=Shelly",
      conversationId: "channel-1",
      persistence
    });

    assert.match(reply, /Stored contact classification/);
    assert.match(reply, /Policy check for email.send: allow/i);
    assert.equal(persistence.getPendingContactClassification(1), null);

    const profile = persistence.getContactByNameOrAlias("Michelle");
    assert(profile);
    assert.equal(profile.contact.trustLevel, "trusted");
  } finally {
    cleanup();
  }
});
