import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { initializePersistence } from "../src/persistence.js";

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-persistence-"));
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

test("access audit persists transport and conversation id", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.saveAccessAudit({
      messageId: "msg-1",
      actorRole: "owner",
      canUsePrivilegedFeatures: true,
      decision: "owner-allowed",
      addressed: true,
      addressedReason: "explicit_command",
      transport: "discord",
      conversationId: "channel-123"
    });

    const row = persistence.db
      .prepare(
        "SELECT transport, conversation_id AS conversationId, addressed, addressed_reason AS addressedReason FROM access_audit WHERE message_id = ?"
      )
      .get("msg-1") as { transport: string; conversationId: string; addressed: number; addressedReason: string } | undefined;

    assert.deepEqual(row, {
      transport: "discord",
      conversationId: "channel-123",
      addressed: 1,
      addressedReason: "explicit_command"
    });
  } finally {
    cleanup();
  }
});

test("mail triage audit persists outcome and destination metadata", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.saveMailTriageDecision({
      messageId: "mail-1",
      senderEmail: "trusted@example.com",
      outcome: "dot_approved",
      source: "whitelist",
      reason: "Trusted sender whitelist match",
      route: "deterministic",
      sourceFolderId: "inbox",
      destinationFolderId: "folder-approved",
      triagedAt: "2026-04-11T00:00:00.000Z",
      movedAt: "2026-04-11T00:00:01.000Z"
    });

    assert.deepEqual(persistence.getMailTriageDecision("mail-1"), {
      messageId: "mail-1",
      senderEmail: "trusted@example.com",
      outcome: "dot_approved",
      source: "whitelist",
      reason: "Trusted sender whitelist match",
      route: "deterministic",
      sourceFolderId: "inbox",
      destinationFolderId: "folder-approved",
      triagedAt: "2026-04-11T00:00:00.000Z",
      movedAt: "2026-04-11T00:00:01.000Z"
    });
  } finally {
    cleanup();
  }
});

test("email actions persist draft and send state durably", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const created = persistence.createEmailAction({
      contactQuery: "Michelle",
      recipientEmail: "michelle@example.com",
      subject: "Hello",
      body: "Checking in.",
      outlookDraftId: "draft-1",
      outlookDraftWebLink: "https://outlook.example/draft-1",
      status: "awaiting_approval",
      riskLevel: "low",
      policyReason: "Michelle is classified as trusted for email.send."
    });

    const updated = persistence.updateEmailAction({
      id: created.id,
      status: "sent",
      sentAt: "2026-04-11T00:00:00.000Z"
    });

    assert.equal(updated.status, "sent");
    assert.equal(updated.sentAt, "2026-04-11T00:00:00.000Z");

    const fetched = persistence.getEmailAction(created.id);
    assert(fetched);
    assert.equal(fetched.outlookDraftId, "draft-1");
    assert.equal(fetched.status, "sent");
    assert.equal(persistence.listEmailActions(5)[0]?.id, created.id);
  } finally {
    cleanup();
  }
});

test("news browse sessions persist the latest briefing per conversation", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.saveNewsBrowseSession({
      kind: "briefing",
      conversationId: "channel-123",
      query: "give me the latest headlines",
      savedAt: "2026-04-13T00:00:00Z",
      items: [
        {
          ordinal: 1,
          title: "Myanmar junta extends emergency rule",
          url: "https://example.test/myanmar",
          source: "newsdata",
          publisher: "Reuters",
          snippet: "Reuters reports the military government extended emergency rule.",
          publishedAt: "2026-04-13T01:00:00Z"
        }
      ]
    });

    const session = persistence.getLatestNewsBrowseSession("channel-123");
    assert.equal(session?.kind, "briefing");
    assert.equal(session?.items[0]?.ordinal, 1);
    assert.equal(session?.items[0]?.publisher, "Reuters");
  } finally {
    cleanup();
  }
});

test("listRecentNormalizedMessages preserves millisecond ordering within the same second", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.saveNormalizedMessage({
      id: "msg-older",
      channelId: "chan-1",
      guildId: "guild-1",
      authorId: "owner-1",
      authorUsername: "owner",
      content: "first",
      isDirectMessage: false,
      mentionedBot: false,
      createdAt: "2026-04-09T00:00:00.100Z"
    });
    persistence.saveNormalizedMessage({
      id: "msg-newer",
      channelId: "chan-1",
      guildId: "guild-1",
      authorId: "owner-1",
      authorUsername: "owner",
      content: "second",
      isDirectMessage: false,
      mentionedBot: false,
      createdAt: "2026-04-09T00:00:00.900Z"
    });

    const recentMessages = persistence.listRecentNormalizedMessages("chan-1", 2);
    assert.equal(recentMessages[0]?.id, "msg-newer");
    assert.equal(recentMessages[1]?.id, "msg-older");
  } finally {
    cleanup();
  }
});

test("initializePersistence migrates legacy access_audit tables with transport metadata columns", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-persistence-legacy-"));
  const sqlitePath = path.join(dataDir, "dot.sqlite");
  const db = new Database(sqlitePath);

  try {
    db.exec(`
      CREATE TABLE access_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        can_use_privileged_features INTEGER NOT NULL,
        decision TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } finally {
    db.close();
  }

  const persistence = initializePersistence(dataDir, sqlitePath);

  try {
    const columns = persistence.db.prepare("PRAGMA table_info(access_audit)").all() as Array<{ name: string }>;
    assert(columns.some((column) => column.name === "addressed"));
    assert(columns.some((column) => column.name === "addressed_reason"));
    assert(columns.some((column) => column.name === "transport"));
    assert(columns.some((column) => column.name === "conversation_id"));
  } finally {
    persistence.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
