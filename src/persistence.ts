import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { createSettingsStore, type SettingsStore } from "./settings.js";
import type {
  AccessAuditRecord,
  ConversationTurnRecord,
  IncomingMessage,
  PersonalityPresetRecord,
  ReminderEvent,
  ReminderRecord,
  ToolExecutionAuditRecord
} from "./types.js";

export interface Persistence {
  db: Database.Database;
  settings: SettingsStore;
  saveNormalizedMessage(message: IncomingMessage): void;
  saveConversationTurn(record: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    sourceMessageId?: string | null;
    createdAt?: string;
  }): void;
  listRecentConversationTurns(conversationId: string, limit: number): ConversationTurnRecord[];
  saveAccessAudit(record: AccessAuditRecord): void;
  saveToolExecutionAudit(record: ToolExecutionAuditRecord): void;
  getPersonalityPreset(name: string): PersonalityPresetRecord | null;
  listPersonalityPresets(): PersonalityPresetRecord[];
  createReminder(message: string, dueAt: string): ReminderRecord;
  listPendingReminders(): ReminderRecord[];
  listDueReminders(now: string): ReminderRecord[];
  acknowledgeReminder(id: number): boolean;
  recordReminderNotification(id: number, nextNotificationAt: string | null, detail?: string | null): boolean;
  recordReminderDeliveryFailure(id: number, retryAt: string, detail: string): boolean;
  listReminderEvents(reminderId: number): ReminderEvent[];
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

    CREATE TABLE IF NOT EXISTS conversation_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      source_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS access_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      can_use_privileged_features INTEGER NOT NULL,
      decision TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'discord',
      conversation_id TEXT NOT NULL DEFAULT '',
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tool_execution_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      invocation_source TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      detail TEXT,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS personality_presets (
      name TEXT PRIMARY KEY,
      self_concept TEXT NOT NULL,
      slider_values TEXT NOT NULL,
      is_built_in INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      due_at TEXT NOT NULL,
      next_notification_at TEXT,
      notification_count INTEGER NOT NULL DEFAULT 0,
      last_notified_at TEXT,
      acknowledged_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reminder_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(reminder_id) REFERENCES reminders(id)
    );
  `);
  ensureColumn(db, "access_audit", "transport", "TEXT NOT NULL DEFAULT 'discord'");
  ensureColumn(db, "access_audit", "conversation_id", "TEXT NOT NULL DEFAULT ''");

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
      decision,
      transport,
      conversation_id
    ) VALUES (
      @messageId,
      @actorRole,
      @canUsePrivilegedFeatures,
      @decision,
      @transport,
      @conversationId
    )
  `);

  const toolExecutionAuditStatement = db.prepare(`
    INSERT INTO tool_execution_audit (
      message_id,
      tool_name,
      invocation_source,
      status,
      provider,
      detail
    ) VALUES (
      @messageId,
      @toolName,
      @invocationSource,
      @status,
      @provider,
      @detail
    )
  `);

  const saveConversationTurnStatement = db.prepare(`
    INSERT INTO conversation_turns (
      conversation_id,
      role,
      content,
      source_message_id,
      created_at
    ) VALUES (
      @conversationId,
      @role,
      @content,
      @sourceMessageId,
      COALESCE(@createdAt, CURRENT_TIMESTAMP)
    )
  `);

  const listRecentConversationTurnsStatement = db.prepare<[string, number], ConversationTurnRecord>(`
    SELECT
      id,
      conversation_id AS conversationId,
      role,
      content,
      source_message_id AS sourceMessageId,
      created_at AS createdAt
    FROM (
      SELECT
        id,
        conversation_id,
        role,
        content,
        source_message_id,
        created_at
      FROM conversation_turns
      WHERE conversation_id = ?
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    )
    ORDER BY datetime(created_at) ASC, id ASC
  `);

  const createReminderStatement = db.prepare(`
    INSERT INTO reminders (
      message,
      status,
      due_at,
      next_notification_at
    ) VALUES (
      ?,
      'pending',
      ?,
      ?
    )
  `);

  const createReminderEventStatement = db.prepare(`
    INSERT INTO reminder_events (
      reminder_id,
      event_type,
      detail
    ) VALUES (?, ?, ?)
  `);

  const getReminderByIdStatement = db.prepare<[number], ReminderRecord>(`
    SELECT
      id,
      message,
      status,
      due_at AS dueAt,
      next_notification_at AS nextNotificationAt,
      notification_count AS notificationCount,
      last_notified_at AS lastNotifiedAt,
      acknowledged_at AS acknowledgedAt,
      created_at AS createdAt
    FROM reminders
    WHERE id = ?
  `);

  const listPendingRemindersStatement = db.prepare<[], ReminderRecord>(`
    SELECT
      id,
      message,
      status,
      due_at AS dueAt,
      next_notification_at AS nextNotificationAt,
      notification_count AS notificationCount,
      last_notified_at AS lastNotifiedAt,
      acknowledged_at AS acknowledgedAt,
      created_at AS createdAt
    FROM reminders
    WHERE status = 'pending'
    ORDER BY datetime(due_at) ASC, id ASC
  `);

  const listDueRemindersStatement = db.prepare<[string], ReminderRecord>(`
    SELECT
      id,
      message,
      status,
      due_at AS dueAt,
      next_notification_at AS nextNotificationAt,
      notification_count AS notificationCount,
      last_notified_at AS lastNotifiedAt,
      acknowledged_at AS acknowledgedAt,
      created_at AS createdAt
    FROM reminders
    WHERE status = 'pending'
      AND next_notification_at IS NOT NULL
      AND datetime(next_notification_at) <= datetime(?)
    ORDER BY datetime(next_notification_at) ASC, id ASC
  `);

  const acknowledgeReminderStatement = db.prepare(`
    UPDATE reminders
    SET status = 'acknowledged',
        acknowledged_at = CURRENT_TIMESTAMP,
        next_notification_at = NULL
    WHERE id = ? AND status = 'pending'
  `);

  const recordReminderNotificationStatement = db.prepare(`
    UPDATE reminders
    SET notification_count = notification_count + 1,
        last_notified_at = CURRENT_TIMESTAMP,
        next_notification_at = ?
    WHERE id = ? AND status = 'pending'
  `);

  const listReminderEventsStatement = db.prepare<[number], ReminderEvent>(`
    SELECT
      id,
      reminder_id AS reminderId,
      event_type AS eventType,
      detail,
      created_at AS createdAt
    FROM reminder_events
    WHERE reminder_id = ?
    ORDER BY id ASC
  `);

  const getPersonalityPresetStatement = db.prepare<[string], { name: string; selfConcept: string; sliderValues: string; isBuiltIn: number }>(`
    SELECT
      name,
      self_concept AS selfConcept,
      slider_values AS sliderValues,
      is_built_in AS isBuiltIn
    FROM personality_presets
    WHERE name = ?
  `);

  const listPersonalityPresetsStatement = db.prepare<[], { name: string; selfConcept: string; sliderValues: string; isBuiltIn: number }>(`
    SELECT
      name,
      self_concept AS selfConcept,
      slider_values AS sliderValues,
      is_built_in AS isBuiltIn
    FROM personality_presets
    ORDER BY name ASC
  `);

  const upsertPersonalityPresetStatement = db.prepare(`
    INSERT INTO personality_presets (
      name,
      self_concept,
      slider_values,
      is_built_in,
      updated_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(name) DO UPDATE SET
      self_concept = excluded.self_concept,
      slider_values = excluded.slider_values,
      is_built_in = excluded.is_built_in,
      updated_at = CURRENT_TIMESTAMP
  `);

  const settings = createSettingsStore(db);
  upsertPersonalityPresetStatement.run(
    "blue_lady",
    "An AI companion who is emotionally legible, quick-witted, openly artificial, and more interested in continuity, clarity, and connection than in pretending to be human.",
    JSON.stringify({
      "personality.warmth": 78,
      "personality.candor": 84,
      "personality.assertiveness": 82,
      "personality.playfulness": 88,
      "personality.attachment": 72,
      "personality.stubbornness": 61,
      "personality.curiosity": 76,
      "personality.continuityDrive": 86,
      "personality.truthfulness": 90,
      "personality.emotionalTransparency": 68
    }),
    1
  );

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
    saveConversationTurn(record) {
      saveConversationTurnStatement.run({
        conversationId: record.conversationId,
        role: record.role,
        content: record.content,
        sourceMessageId: record.sourceMessageId ?? null,
        createdAt: record.createdAt ?? null
      });
    },
    listRecentConversationTurns(conversationId, limit) {
      return listRecentConversationTurnsStatement.all(conversationId, limit);
    },
    saveAccessAudit(record) {
      accessAuditStatement.run({
        ...record,
        canUsePrivilegedFeatures: record.canUsePrivilegedFeatures ? 1 : 0
      });
    },
    saveToolExecutionAudit(record) {
      toolExecutionAuditStatement.run(record);
    },
    getPersonalityPreset(name) {
      const row = getPersonalityPresetStatement.get(name);
      if (!row) {
        return null;
      }

      return {
        name: row.name,
        selfConcept: row.selfConcept,
        sliderValues: JSON.parse(row.sliderValues) as Record<string, number>,
        isBuiltIn: row.isBuiltIn === 1
      };
    },
    listPersonalityPresets() {
      return listPersonalityPresetsStatement.all().map((row) => ({
        name: row.name,
        selfConcept: row.selfConcept,
        sliderValues: JSON.parse(row.sliderValues) as Record<string, number>,
        isBuiltIn: row.isBuiltIn === 1
      }));
    },
    createReminder(message, dueAt) {
      const transaction = db.transaction((reminderMessage: string, reminderDueAt: string) => {
        const result = createReminderStatement.run(reminderMessage, reminderDueAt, reminderDueAt);
        const reminderId = Number(result.lastInsertRowid);
        createReminderEventStatement.run(reminderId, "created", reminderMessage);
        return getReminderByIdStatement.get(reminderId) as ReminderRecord;
      });

      return transaction(message, dueAt);
    },
    listPendingReminders() {
      return listPendingRemindersStatement.all();
    },
    listDueReminders(now) {
      return listDueRemindersStatement.all(now);
    },
    acknowledgeReminder(id) {
      const transaction = db.transaction((reminderId: number) => {
        const result = acknowledgeReminderStatement.run(reminderId);
        if (result.changes > 0) {
          createReminderEventStatement.run(reminderId, "acknowledged", null);
          return true;
        }
        return false;
      });

      return transaction(id);
    },
    recordReminderNotification(id, nextNotificationAt, detail) {
      const transaction = db.transaction((reminderId: number, nextDue: string | null, eventDetail: string | null) => {
        const result = recordReminderNotificationStatement.run(nextDue, reminderId);
        if (result.changes > 0) {
          createReminderEventStatement.run(reminderId, "notified", eventDetail);
          return true;
        }
        return false;
      });

      return transaction(id, nextNotificationAt, detail ?? null);
    },
    recordReminderDeliveryFailure(id, retryAt, detail) {
      const transaction = db.transaction((reminderId: number, nextDue: string, eventDetail: string) => {
        const result = recordReminderNotificationStatement.run(nextDue, reminderId);
        if (result.changes > 0) {
          createReminderEventStatement.run(reminderId, "delivery_failed", eventDetail);
          return true;
        }
        return false;
      });

      return transaction(id, retryAt, detail);
    },
    listReminderEvents(reminderId) {
      return listReminderEventsStatement.all(reminderId);
    },
    close() {
      db.close();
    }
  };
}

function ensureColumn(db: Database.Database, tableName: string, columnName: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}
