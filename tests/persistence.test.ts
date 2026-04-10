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
