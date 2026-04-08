import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { createSettingsStore, type SettingsStore } from "./settings.js";
import type { AccessAuditRecord, IncomingMessage, ReminderEvent, ReminderRecord } from "./types.js";

export interface Persistence {
  db: Database.Database;
  settings: SettingsStore;
  saveNormalizedMessage(message: IncomingMessage): void;
  saveAccessAudit(record: AccessAuditRecord): void;
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
