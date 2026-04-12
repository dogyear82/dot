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
      transport: "discord",
      conversationId: "channel-123"
    });

    const row = persistence.db
      .prepare("SELECT transport, conversation_id AS conversationId FROM access_audit WHERE message_id = ?")
      .get("msg-1") as { transport: string; conversationId: string } | undefined;

    assert.deepEqual(row, {
      transport: "discord",
      conversationId: "channel-123"
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
    assert(columns.some((column) => column.name === "transport"));
    assert(columns.some((column) => column.name === "conversation_id"));
  } finally {
    persistence.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
