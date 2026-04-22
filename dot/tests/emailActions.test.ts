import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerEmailActionsConsumer } from "../src/emailActions.js";
import { createEmailActionRequestedEvent, type EmailActionCompletedEvent } from "../src/events.js";
import { createInMemoryEventBus } from "../src/eventBus.js";
import { initializePersistence } from "../src/persistence.js";

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-email-actions-"));
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

function createLogger() {
  return {
    info() {},
    warn() {}
  };
}

test("email actions consumer creates an Outlook draft and publishes completion", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const completions: EmailActionCompletedEvent[] = [];

  try {
    persistence.upsertContact({
      canonicalName: "Michelle",
      trustLevel: "trusted",
      endpoints: [{ kind: "email", value: "michelle@example.com" }]
    });

    const created = persistence.createEmailAction({
      contactQuery: "Michelle",
      contactId: 1,
      recipientEmail: "michelle@example.com",
      subject: "Hello",
      body: "Checking in.",
      status: "draft_requested",
      riskLevel: "low",
      policyReason: "Michelle is trusted for email.send."
    });

    bus.subscribe<EmailActionCompletedEvent>("email.action.completed", (event) => {
      completions.push(event);
    });

    const unsubscribe = registerEmailActionsConsumer({
      bus,
      logger: createLogger() as never,
      mailClient: {
        async createDraft(params: { to: string; subject: string; body: string }) {
          assert.equal(params.to, "michelle@example.com");
          return { id: "draft-1", webLink: "https://outlook.example/draft-1" };
        },
        async sendDraft() {
          throw new Error("send should not run during draft creation");
        }
      } as never,
      persistence
    });

    await bus.publish(
      createEmailActionRequestedEvent({
        actionId: created.id,
        operation: "create_draft",
        correlationId: "email-action:1",
        conversationId: "channel-1",
        actorId: "owner-1"
      })
    );

    const action = persistence.getEmailAction(created.id);
    assert(action);
    assert.equal(action.status, "awaiting_approval");
    assert.equal(action.outlookDraftId, "draft-1");
    assert.equal(completions.length, 1);
    assert.match(completions[0]?.payload.reply ?? "", /Created draft email action #1/i);

    unsubscribe();
  } finally {
    cleanup();
  }
});

test("email actions consumer sends an Outlook draft and records sent state", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const completions: EmailActionCompletedEvent[] = [];
  const sendCalls: string[] = [];

  try {
    persistence.upsertContact({
      canonicalName: "Michelle",
      trustLevel: "approval_required",
      endpoints: [{ kind: "email", value: "michelle@example.com" }]
    });

    const created = persistence.createEmailAction({
      contactQuery: "Michelle",
      contactId: 1,
      recipientEmail: "michelle@example.com",
      subject: "Hello",
      body: "Checking in.",
      outlookDraftId: "draft-1",
      outlookDraftWebLink: "https://outlook.example/draft-1",
      status: "send_requested",
      riskLevel: "high",
      policyReason: "Michelle requires approval before email.send."
    });

    bus.subscribe<EmailActionCompletedEvent>("email.action.completed", (event) => {
      completions.push(event);
    });

    const unsubscribe = registerEmailActionsConsumer({
      bus,
      logger: createLogger() as never,
      mailClient: {
        async createDraft() {
          throw new Error("createDraft should not run during send");
        },
        async sendDraft(draftId: string) {
          sendCalls.push(draftId);
        }
      } as never,
      persistence
    });

    await bus.publish(
      createEmailActionRequestedEvent({
        actionId: created.id,
        operation: "send_draft",
        correlationId: "email-action:1",
        conversationId: "channel-1",
        actorId: "owner-1"
      })
    );

    const action = persistence.getEmailAction(created.id);
    assert(action);
    assert.equal(action.status, "sent");
    assert.ok(action.sentAt);
    assert.deepEqual(sendCalls, ["draft-1"]);
    assert.equal(completions.length, 1);
    assert.match(completions[0]?.payload.reply ?? "", /Sent email action #1/i);

    unsubscribe();
  } finally {
    cleanup();
  }
});
