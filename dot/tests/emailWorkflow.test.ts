import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerEmailActionsConsumer } from "../src/emailActions.js";
import { handleEmailCommand } from "../src/emailWorkflow.js";
import { createInMemoryEventBus } from "../src/eventBus.js";
import { initializePersistence } from "../src/persistence.js";

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-email-workflow-"));
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

test("email draft creates a pending contact classification when the contact is unknown", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();

  try {
    const reply = await handleEmailCommand({
      actorId: "owner-1",
      bus,
      content: "!email draft Michelle | Hello | Checking in.",
      conversationId: "channel-1",
      persistence
    });

    assert.match(reply, /waiting on contact classification/i);
    assert.match(reply, /!contact classify 1/i);

    const action = persistence.getEmailAction(1);
    assert(action);
    assert.equal(action.status, "pending_contact_classification");
  } finally {
    cleanup();
  }
});

test("email draft creates an Outlook draft for trusted contacts and awaits approval", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();

  try {
    persistence.upsertContact({
      canonicalName: "Michelle",
      trustLevel: "trusted",
      endpoints: [{ kind: "email", value: "michelle@example.com" }]
    });

    const createDraftCalls: Array<{ to: string; subject: string; body: string }> = [];
    const unregisterConsumer = registerEmailActionsConsumer({
      bus,
      logger: { info() {}, warn() {} } as never,
      mailClient: {
        async createDraft(params: { to: string; subject: string; body: string }) {
          createDraftCalls.push(params);
          return { id: "draft-1", webLink: "https://outlook.example/draft-1" };
        },
        async sendDraft() {
          throw new Error("send should not run during draft");
        }
      } as never,
      persistence
    });

    const reply = await handleEmailCommand({
      actorId: "owner-1",
      bus,
      content: "!email draft Michelle | Hello | Checking in.",
      conversationId: "channel-1",
      persistence
    });

    assert.equal(createDraftCalls.length, 1);
    assert.match(reply, /Created draft email action #1/i);
    assert.match(reply, /!email approve 1/);

    const action = persistence.getEmailAction(1);
    assert(action);
    assert.equal(action.status, "awaiting_approval");
    assert.equal(action.outlookDraftId, "draft-1");
    unregisterConsumer();
  } finally {
    cleanup();
  }
});

test("email approve sends the stored Outlook draft and records sent state", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();

  try {
    persistence.upsertContact({
      canonicalName: "Michelle",
      trustLevel: "approval_required",
      endpoints: [{ kind: "email", value: "michelle@example.com" }]
    });

    persistence.createEmailAction({
      contactQuery: "Michelle",
      contactId: 1,
      recipientEmail: "michelle@example.com",
      subject: "Hello",
      body: "Checking in.",
      outlookDraftId: "draft-1",
      outlookDraftWebLink: "https://outlook.example/draft-1",
      status: "awaiting_approval",
      riskLevel: "high",
      policyReason: "Michelle requires explicit approval before email.send."
    });

    const sendCalls: string[] = [];
    const unregisterConsumer = registerEmailActionsConsumer({
      bus,
      logger: { info() {}, warn() {} } as never,
      mailClient: {
        async createDraft() {
          throw new Error("createDraft should not run during approval");
        },
        async sendDraft(messageId: string) {
          sendCalls.push(messageId);
        }
      } as never,
      persistence
    });

    const reply = await handleEmailCommand({
      actorId: "owner-1",
      bus,
      content: "!email approve 1",
      conversationId: "channel-1",
      persistence
    });

    assert.deepEqual(sendCalls, ["draft-1"]);
    assert.match(reply, /Sent email action #1/i);

    const action = persistence.getEmailAction(1);
    assert(action);
    assert.equal(action.status, "sent");
    assert.ok(action.sentAt);
    unregisterConsumer();
  } finally {
    cleanup();
  }
});
