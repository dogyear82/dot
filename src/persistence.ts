import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { createSettingsStore, type SettingsStore } from "./settings.js";
import type { AccessAuditRecord, IncomingMessage } from "./types.js";

export interface Persistence {
  db: Database.Database;
  settings: SettingsStore;
  saveNormalizedMessage(message: IncomingMessage): void;
  saveAccessAudit(record: AccessAuditRecord): void;
  close(): void;
}

export function initializePersistence(dataDir: string, sqlitePath: string): Persistence {
  fs.mkdirSync(path.resolve(dataDir), { recursive: true });

  const db = new Database(path.resolve(sqlitePath));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS normalized_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      guild_id TEXT,
      author_id TEXT NOT NULL,
      author_username TEXT NOT NULL,
      content TEXT NOT NULL,
      is_direct_message INTEGER NOT NULL,
      mentioned_bot INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS access_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      can_use_privileged_features INTEGER NOT NULL,
      decision TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const saveStatement = db.prepare(`
    INSERT OR REPLACE INTO normalized_messages (
      id,
      channel_id,
      guild_id,
      author_id,
      author_username,
      content,
      is_direct_message,
      mentioned_bot,
      created_at
    ) VALUES (
      @id,
      @channelId,
      @guildId,
      @authorId,
      @authorUsername,
      @content,
      @isDirectMessage,
      @mentionedBot,
      @createdAt
    )
  `);

  const accessAuditStatement = db.prepare(`
    INSERT INTO access_audit (
      message_id,
      actor_role,
      can_use_privileged_features,
      decision
    ) VALUES (
      @messageId,
      @actorRole,
      @canUsePrivilegedFeatures,
      @decision
    )
  `);

  const settings = createSettingsStore(db);

  return {
    db,
    settings,
    saveNormalizedMessage(message) {
      saveStatement.run({
        ...message,
        isDirectMessage: message.isDirectMessage ? 1 : 0,
        mentionedBot: message.mentionedBot ? 1 : 0
      });
    },
    saveAccessAudit(record) {
      accessAuditStatement.run({
        ...record,
        canUsePrivilegedFeatures: record.canUsePrivilegedFeatures ? 1 : 0
      });
    },
    close() {
      db.close();
    }
  };
}
