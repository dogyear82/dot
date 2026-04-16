import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { createSettingsStore, type SettingsStore } from "./settings.js";
import type { DotEvent } from "./events.js";
import type {
  AccessAuditRecord,
  DiagnosticEventRecord,
  ContactAliasRecord,
  ContactEndpointKind,
  ContactEndpointRecord,
  ContactProfile,
  ContactRecord,
  ContactTrustLevel,
  DetectedMailMessageRecord,
  ConversationTurnRecord,
  EmailActionRecord,
  EmailActionStatus,
  IncomingMessage,
  MailTriageDecisionRecord,
  NewsBrowseSessionRecord,
  OAuthDeviceFlowRecord,
  OAuthTokenRecord,
  PendingConversationalToolSessionRecord,
  PendingContactClassificationRecord,
  PersonalityPresetRecord,
  PolicyActionType,
  ReminderEvent,
  ReminderRecord,
  ServiceHealthSnapshotRecord,
  ToolExecutionAuditRecord,
  ConversationParticipantKind
} from "./types.js";

export interface Persistence {
  db: Database.Database;
  settings: SettingsStore;
  saveNormalizedMessage(message: IncomingMessage): void;
  listRecentNormalizedMessages(channelId: string, limit: number): IncomingMessage[];
  getWorkerState(key: string): string | null;
  setWorkerState(key: string, value: string): void;
  clearWorkerState(key: string): void;
  getMailTriageDecision(messageId: string): MailTriageDecisionRecord | null;
  saveMailTriageDecision(record: MailTriageDecisionRecord): void;
  saveConversationTurn(record: {
    conversationId: string;
    role: "user" | "assistant";
    participantActorId?: string | null;
    participantDisplayName?: string | null;
    participantKind?: ConversationParticipantKind;
    content: string;
    sourceMessageId?: string | null;
    createdAt?: string;
  }): void;
  listRecentConversationTurns(conversationId: string, limit: number): ConversationTurnRecord[];
  saveAccessAudit(record: AccessAuditRecord): void;
  saveToolExecutionAudit(record: ToolExecutionAuditRecord): void;
  saveDiagnosticEvent(event: DotEvent): void;
  listRecentDiagnosticEvents(limit: number): DiagnosticEventRecord[];
  upsertServiceHealthSnapshot(record: ServiceHealthSnapshotRecord): void;
  listServiceHealthSnapshots(): ServiceHealthSnapshotRecord[];
  upsertContact(record: {
    canonicalName: string;
    trustLevel: ContactTrustLevel;
    notes?: string | null;
    aliases?: string[];
    endpoints?: Array<{ kind: ContactEndpointKind; value: string; label?: string | null }>;
  }): ContactProfile;
  getContactByNameOrAlias(query: string): ContactProfile | null;
  listContacts(): ContactProfile[];
  createPendingContactClassification(record: {
    actionType: PolicyActionType;
    contactQuery: string;
    conversationId: string;
  }): PendingContactClassificationRecord;
  getPendingConversationalToolSession(conversationId: string): PendingConversationalToolSessionRecord | null;
  savePendingConversationalToolSession(record: PendingConversationalToolSessionRecord): void;
  clearPendingConversationalToolSession(conversationId: string): void;
  listPendingContactClassifications(): PendingContactClassificationRecord[];
  getPendingContactClassification(id: number): PendingContactClassificationRecord | null;
  clearPendingContactClassification(id: number): void;
  enqueueDetectedMailMessage(record: {
    messageId: string;
    message: unknown;
    initialBaseline: boolean;
    detectedAt?: string;
  }): void;
  listDetectedMailMessages(limit?: number): DetectedMailMessageRecord[];
  clearDetectedMailMessage(messageId: string): void;
  getLatestNewsBrowseSession(conversationId: string): NewsBrowseSessionRecord | null;
  saveNewsBrowseSession(record: NewsBrowseSessionRecord): void;
  createEmailAction(record: {
    contactQuery: string;
    contactId?: number | null;
    recipientEmail?: string | null;
    subject: string;
    body: string;
    outlookDraftId?: string | null;
    outlookDraftWebLink?: string | null;
    status: EmailActionStatus;
    riskLevel?: "low" | "high" | null;
    policyReason?: string | null;
    lastError?: string | null;
    createdAt?: string;
    sentAt?: string | null;
  }): EmailActionRecord;
  getEmailAction(id: number): EmailActionRecord | null;
  listEmailActions(limit?: number): EmailActionRecord[];
  updateEmailAction(record: {
    id: number;
    contactId?: number | null;
    recipientEmail?: string | null;
    subject?: string;
    body?: string;
    outlookDraftId?: string | null;
    outlookDraftWebLink?: string | null;
    status?: EmailActionStatus;
    riskLevel?: "low" | "high" | null;
    policyReason?: string | null;
    lastError?: string | null;
    sentAt?: string | null;
  }): EmailActionRecord;
  getPersonalityPreset(name: string): PersonalityPresetRecord | null;
  listPersonalityPresets(): PersonalityPresetRecord[];
  getOAuthToken(provider: string): OAuthTokenRecord | null;
  saveOAuthToken(record: OAuthTokenRecord): void;
  clearOAuthToken(provider: string): void;
  getOAuthDeviceFlow(provider: string): OAuthDeviceFlowRecord | null;
  saveOAuthDeviceFlow(record: OAuthDeviceFlowRecord): void;
  clearOAuthDeviceFlow(provider: string): void;
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

    CREATE TABLE IF NOT EXISTS worker_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mail_triage_audit (
      message_id TEXT PRIMARY KEY,
      sender_email TEXT,
      outcome TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL,
      route TEXT NOT NULL,
      source_folder_id TEXT,
      destination_folder_id TEXT,
      triaged_at TEXT NOT NULL,
      moved_at TEXT
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
      replied_to_message_id TEXT,
      replied_to_bot INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversation_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      participant_actor_id TEXT,
      participant_display_name TEXT,
      participant_kind TEXT NOT NULL DEFAULT 'unknown',
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
      addressed INTEGER NOT NULL DEFAULT 0,
      addressed_reason TEXT NOT NULL DEFAULT '',
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

    CREATE TABLE IF NOT EXISTS diagnostic_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      producer_service TEXT NOT NULL,
      correlation_id TEXT,
      causation_id TEXT,
      conversation_id TEXT,
      actor_id TEXT,
      severity TEXT NOT NULL,
      category TEXT,
      occurred_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_health_snapshots (
      service TEXT NOT NULL,
      check_name TEXT NOT NULL,
      status TEXT NOT NULL,
      state TEXT,
      detail TEXT,
      observed_latency_ms REAL,
      source_event_id TEXT,
      last_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (service, check_name)
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

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_name TEXT NOT NULL,
      canonical_name_normalized TEXT NOT NULL UNIQUE,
      trust_level TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contact_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      alias TEXT NOT NULL,
      alias_normalized TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contact_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      value_normalized TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(contact_id, kind, value_normalized),
      FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pending_contact_classifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      contact_query TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TEXT NOT NULL,
      scope TEXT,
      token_type TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS oauth_device_flows (
      provider TEXT PRIMARY KEY,
      device_code TEXT NOT NULL,
      user_code TEXT NOT NULL,
      verification_uri TEXT NOT NULL,
      verification_uri_complete TEXT,
      expires_at TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL,
      message TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS email_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_query TEXT NOT NULL,
      contact_id INTEGER,
      recipient_email TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      outlook_draft_id TEXT,
      outlook_draft_web_link TEXT,
      status TEXT NOT NULL,
      risk_level TEXT,
      policy_reason TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT,
      FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS detected_mail_messages (
      message_id TEXT PRIMARY KEY,
      message_json TEXT NOT NULL,
      initial_baseline INTEGER NOT NULL,
      detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  ensureColumn(db, "conversation_turns", "participant_actor_id", "TEXT");
  ensureColumn(db, "conversation_turns", "participant_display_name", "TEXT");
  ensureColumn(db, "conversation_turns", "participant_kind", "TEXT NOT NULL DEFAULT 'unknown'");
  backfillConversationTurnParticipantIdentity(db);
  ensureColumn(db, "access_audit", "addressed", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "access_audit", "addressed_reason", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "access_audit", "transport", "TEXT NOT NULL DEFAULT 'discord'");
  ensureColumn(db, "access_audit", "conversation_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "normalized_messages", "replied_to_message_id", "TEXT");
  ensureColumn(db, "normalized_messages", "replied_to_bot", "INTEGER NOT NULL DEFAULT 0");

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
      replied_to_message_id,
      replied_to_bot,
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
      @repliedToMessageId,
      @repliedToBot,
      @createdAt
    )
  `);

  const listRecentNormalizedMessagesStatement = db.prepare<
    [string, number],
    Omit<IncomingMessage, "isDirectMessage" | "mentionedBot" | "repliedToBot"> & {
      isDirectMessage: number;
      mentionedBot: number;
      repliedToBot: number;
    }
  >(`
    SELECT
      id,
      channel_id AS channelId,
      guild_id AS guildId,
      author_id AS authorId,
      author_username AS authorUsername,
      content,
      is_direct_message AS isDirectMessage,
      mentioned_bot AS mentionedBot,
      replied_to_message_id AS repliedToMessageId,
      replied_to_bot AS repliedToBot,
      created_at AS createdAt
    FROM normalized_messages
    WHERE channel_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);

  const getWorkerStateStatement = db.prepare<[string], { value: string }>(`
    SELECT value
    FROM worker_state
    WHERE key = ?
  `);

  const upsertWorkerStateStatement = db.prepare(`
    INSERT INTO worker_state (
      key,
      value,
      updated_at
    ) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `);

  const clearWorkerStateStatement = db.prepare(`
    DELETE FROM worker_state
    WHERE key = ?
  `);

  const getMailTriageDecisionStatement = db.prepare<[string], MailTriageDecisionRecord>(`
    SELECT
      message_id AS messageId,
      sender_email AS senderEmail,
      outcome,
      source,
      reason,
      route,
      source_folder_id AS sourceFolderId,
      destination_folder_id AS destinationFolderId,
      triaged_at AS triagedAt,
      moved_at AS movedAt
    FROM mail_triage_audit
    WHERE message_id = ?
  `);

  const saveMailTriageDecisionStatement = db.prepare(`
    INSERT INTO mail_triage_audit (
      message_id,
      sender_email,
      outcome,
      source,
      reason,
      route,
      source_folder_id,
      destination_folder_id,
      triaged_at,
      moved_at
    ) VALUES (
      @messageId,
      @senderEmail,
      @outcome,
      @source,
      @reason,
      @route,
      @sourceFolderId,
      @destinationFolderId,
      @triagedAt,
      @movedAt
    )
    ON CONFLICT(message_id) DO UPDATE SET
      sender_email = excluded.sender_email,
      outcome = excluded.outcome,
      source = excluded.source,
      reason = excluded.reason,
      route = excluded.route,
      source_folder_id = excluded.source_folder_id,
      destination_folder_id = excluded.destination_folder_id,
      triaged_at = excluded.triaged_at,
      moved_at = excluded.moved_at
  `);

  const accessAuditStatement = db.prepare(`
    INSERT INTO access_audit (
      message_id,
      actor_role,
      can_use_privileged_features,
      decision,
      addressed,
      addressed_reason,
      transport,
      conversation_id
    ) VALUES (
      @messageId,
      @actorRole,
      @canUsePrivilegedFeatures,
      @decision,
      @addressed,
      @addressedReason,
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

  const saveDiagnosticEventStatement = db.prepare(`
    INSERT OR REPLACE INTO diagnostic_events (
      event_id,
      event_type,
      producer_service,
      correlation_id,
      causation_id,
      conversation_id,
      actor_id,
      severity,
      category,
      occurred_at
    ) VALUES (
      @eventId,
      @eventType,
      @producerService,
      @correlationId,
      @causationId,
      @conversationId,
      @actorId,
      @severity,
      @category,
      @occurredAt
    )
  `);

  const listRecentDiagnosticEventsStatement = db.prepare<[{ limit: number }], DiagnosticEventRecord>(`
    SELECT
      event_id AS eventId,
      event_type AS eventType,
      producer_service AS producerService,
      correlation_id AS correlationId,
      causation_id AS causationId,
      conversation_id AS conversationId,
      actor_id AS actorId,
      severity,
      category,
      occurred_at AS occurredAt
    FROM diagnostic_events
    ORDER BY datetime(occurred_at) DESC, event_id DESC
    LIMIT @limit
  `);

  const upsertServiceHealthSnapshotStatement = db.prepare(`
    INSERT INTO service_health_snapshots (
      service,
      check_name,
      status,
      state,
      detail,
      observed_latency_ms,
      source_event_id,
      last_event_id,
      updated_at
    ) VALUES (
      @service,
      @checkName,
      @status,
      @state,
      @detail,
      @observedLatencyMs,
      @sourceEventId,
      @lastEventId,
      @updatedAt
    )
    ON CONFLICT(service, check_name) DO UPDATE SET
      status = excluded.status,
      state = excluded.state,
      detail = excluded.detail,
      observed_latency_ms = excluded.observed_latency_ms,
      source_event_id = excluded.source_event_id,
      last_event_id = excluded.last_event_id,
      updated_at = excluded.updated_at
  `);

  const listServiceHealthSnapshotsStatement = db.prepare<[], ServiceHealthSnapshotRecord>(`
    SELECT
      service,
      check_name AS checkName,
      status,
      state,
      detail,
      observed_latency_ms AS observedLatencyMs,
      source_event_id AS sourceEventId,
      last_event_id AS lastEventId,
      updated_at AS updatedAt
    FROM service_health_snapshots
    ORDER BY service ASC, check_name ASC
  `);

  const saveConversationTurnStatement = db.prepare(`
    INSERT INTO conversation_turns (
      conversation_id,
      role,
      participant_actor_id,
      participant_display_name,
      participant_kind,
      content,
      source_message_id,
      created_at
    ) VALUES (
      @conversationId,
      @role,
      @participantActorId,
      @participantDisplayName,
      @participantKind,
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
      participant_actor_id AS participantActorId,
      participant_display_name AS participantDisplayName,
      participant_kind AS participantKind,
      content,
      source_message_id AS sourceMessageId,
      created_at AS createdAt
    FROM (
      SELECT
        id,
        conversation_id,
        role,
        participant_actor_id,
        participant_display_name,
        participant_kind,
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

  const getOAuthTokenStatement = db.prepare<[string], {
    provider: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: string;
    scope: string | null;
    tokenType: string;
  }>(`
    SELECT
      provider,
      access_token AS accessToken,
      refresh_token AS refreshToken,
      expires_at AS expiresAt,
      scope,
      token_type AS tokenType
    FROM oauth_tokens
    WHERE provider = ?
  `);

  const upsertOAuthTokenStatement = db.prepare(`
    INSERT INTO oauth_tokens (
      provider,
      access_token,
      refresh_token,
      expires_at,
      scope,
      token_type,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      scope = excluded.scope,
      token_type = excluded.token_type,
      updated_at = CURRENT_TIMESTAMP
  `);

  const clearOAuthTokenStatement = db.prepare(`
    DELETE FROM oauth_tokens
    WHERE provider = ?
  `);

  const getOAuthDeviceFlowStatement = db.prepare<[string], {
    provider: string;
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string | null;
    expiresAt: string;
    intervalSeconds: number;
    message: string;
  }>(`
    SELECT
      provider,
      device_code AS deviceCode,
      user_code AS userCode,
      verification_uri AS verificationUri,
      verification_uri_complete AS verificationUriComplete,
      expires_at AS expiresAt,
      interval_seconds AS intervalSeconds,
      message
    FROM oauth_device_flows
    WHERE provider = ?
  `);

  const upsertOAuthDeviceFlowStatement = db.prepare(`
    INSERT INTO oauth_device_flows (
      provider,
      device_code,
      user_code,
      verification_uri,
      verification_uri_complete,
      expires_at,
      interval_seconds,
      message,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider) DO UPDATE SET
      device_code = excluded.device_code,
      user_code = excluded.user_code,
      verification_uri = excluded.verification_uri,
      verification_uri_complete = excluded.verification_uri_complete,
      expires_at = excluded.expires_at,
      interval_seconds = excluded.interval_seconds,
      message = excluded.message,
      updated_at = CURRENT_TIMESTAMP
  `);

  const clearOAuthDeviceFlowStatement = db.prepare(`
    DELETE FROM oauth_device_flows
    WHERE provider = ?
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

  const getContactByCanonicalNameStatement = db.prepare<[string], ContactRecord>(`
    SELECT
      id,
      canonical_name AS canonicalName,
      trust_level AS trustLevel,
      notes,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM contacts
    WHERE canonical_name_normalized = ?
  `);

  const getContactByAliasStatement = db.prepare<[string], ContactRecord>(`
    SELECT
      c.id,
      c.canonical_name AS canonicalName,
      c.trust_level AS trustLevel,
      c.notes,
      c.created_at AS createdAt,
      c.updated_at AS updatedAt
    FROM contact_aliases a
    JOIN contacts c ON c.id = a.contact_id
    WHERE a.alias_normalized = ?
  `);

  const listContactsStatement = db.prepare<[], ContactRecord>(`
    SELECT
      id,
      canonical_name AS canonicalName,
      trust_level AS trustLevel,
      notes,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM contacts
    ORDER BY canonical_name_normalized ASC
  `);

  const insertContactStatement = db.prepare(`
    INSERT INTO contacts (
      canonical_name,
      canonical_name_normalized,
      trust_level,
      notes
    ) VALUES (?, ?, ?, ?)
  `);

  const updateContactStatement = db.prepare(`
    UPDATE contacts
    SET canonical_name = ?,
        canonical_name_normalized = ?,
        trust_level = ?,
        notes = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const deleteContactAliasesStatement = db.prepare(`
    DELETE FROM contact_aliases
    WHERE contact_id = ?
  `);

  const insertContactAliasStatement = db.prepare(`
    INSERT INTO contact_aliases (
      contact_id,
      alias,
      alias_normalized
    ) VALUES (?, ?, ?)
  `);

  const listContactAliasesStatement = db.prepare<[number], ContactAliasRecord>(`
    SELECT
      id,
      contact_id AS contactId,
      alias,
      created_at AS createdAt
    FROM contact_aliases
    WHERE contact_id = ?
    ORDER BY alias_normalized ASC
  `);

  const deleteContactEndpointsStatement = db.prepare(`
    DELETE FROM contact_endpoints
    WHERE contact_id = ?
  `);

  const insertContactEndpointStatement = db.prepare(`
    INSERT INTO contact_endpoints (
      contact_id,
      kind,
      value,
      value_normalized,
      label
    ) VALUES (?, ?, ?, ?, ?)
  `);

  const listContactEndpointsStatement = db.prepare<[number], ContactEndpointRecord>(`
    SELECT
      id,
      contact_id AS contactId,
      kind,
      value,
      label,
      created_at AS createdAt
    FROM contact_endpoints
    WHERE contact_id = ?
    ORDER BY kind ASC, value_normalized ASC
  `);

  const insertPendingContactClassificationStatement = db.prepare(`
    INSERT INTO pending_contact_classifications (
      action_type,
      contact_query,
      conversation_id
    ) VALUES (?, ?, ?)
  `);

  const getPendingContactClassificationStatement = db.prepare<[number], PendingContactClassificationRecord>(`
    SELECT
      id,
      action_type AS actionType,
      contact_query AS contactQuery,
      conversation_id AS conversationId,
      created_at AS createdAt
    FROM pending_contact_classifications
    WHERE id = ?
  `);

  const listPendingContactClassificationsStatement = db.prepare<[], PendingContactClassificationRecord>(`
    SELECT
      id,
      action_type AS actionType,
      contact_query AS contactQuery,
      conversation_id AS conversationId,
      created_at AS createdAt
    FROM pending_contact_classifications
    ORDER BY id ASC
  `);

  const deletePendingContactClassificationStatement = db.prepare(`
    DELETE FROM pending_contact_classifications
    WHERE id = ?
  `);

  const createEmailActionStatement = db.prepare(`
    INSERT INTO email_actions (
      contact_query,
      contact_id,
      recipient_email,
      subject,
      body,
      outlook_draft_id,
      outlook_draft_web_link,
      status,
      risk_level,
      policy_reason,
      last_error,
      created_at,
      updated_at,
      sent_at
    ) VALUES (
      @contactQuery,
      @contactId,
      @recipientEmail,
      @subject,
      @body,
      @outlookDraftId,
      @outlookDraftWebLink,
      @status,
      @riskLevel,
      @policyReason,
      @lastError,
      COALESCE(@createdAt, CURRENT_TIMESTAMP),
      COALESCE(@createdAt, CURRENT_TIMESTAMP),
      @sentAt
    )
  `);

  const getEmailActionStatement = db.prepare<[number], EmailActionRecord>(`
    SELECT
      id,
      contact_query AS contactQuery,
      contact_id AS contactId,
      recipient_email AS recipientEmail,
      subject,
      body,
      outlook_draft_id AS outlookDraftId,
      outlook_draft_web_link AS outlookDraftWebLink,
      status,
      risk_level AS riskLevel,
      policy_reason AS policyReason,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt,
      sent_at AS sentAt
    FROM email_actions
    WHERE id = ?
  `);

  const listEmailActionsStatement = db.prepare<[number], EmailActionRecord>(`
    SELECT
      id,
      contact_query AS contactQuery,
      contact_id AS contactId,
      recipient_email AS recipientEmail,
      subject,
      body,
      outlook_draft_id AS outlookDraftId,
      outlook_draft_web_link AS outlookDraftWebLink,
      status,
      risk_level AS riskLevel,
      policy_reason AS policyReason,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt,
      sent_at AS sentAt
    FROM email_actions
    ORDER BY id DESC
    LIMIT ?
  `);

  const updateEmailActionStatement = db.prepare(`
    UPDATE email_actions
    SET contact_id = COALESCE(@contactId, contact_id),
        recipient_email = COALESCE(@recipientEmail, recipient_email),
        subject = COALESCE(@subject, subject),
        body = COALESCE(@body, body),
        outlook_draft_id = COALESCE(@outlookDraftId, outlook_draft_id),
        outlook_draft_web_link = COALESCE(@outlookDraftWebLink, outlook_draft_web_link),
        status = COALESCE(@status, status),
        risk_level = COALESCE(@riskLevel, risk_level),
        policy_reason = COALESCE(@policyReason, policy_reason),
        last_error = CASE
          WHEN @lastError IS NOT NULL THEN @lastError
          ELSE last_error
        END,
        sent_at = CASE
          WHEN @sentAt IS NOT NULL THEN @sentAt
          ELSE sent_at
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);

  const enqueueDetectedMailMessageStatement = db.prepare(`
    INSERT OR IGNORE INTO detected_mail_messages (
      message_id,
      message_json,
      initial_baseline,
      detected_at
    ) VALUES (
      @messageId,
      @messageJson,
      @initialBaseline,
      COALESCE(@detectedAt, CURRENT_TIMESTAMP)
    )
  `);

  const listDetectedMailMessagesStatement = db.prepare<[number], {
    messageId: string;
    messageJson: string;
    initialBaseline: number;
    detectedAt: string;
  }>(`
    SELECT
      message_id AS messageId,
      message_json AS messageJson,
      initial_baseline AS initialBaseline,
      detected_at AS detectedAt
    FROM detected_mail_messages
    ORDER BY datetime(detected_at) ASC, message_id ASC
    LIMIT ?
  `);

  const clearDetectedMailMessageStatement = db.prepare(`
    DELETE FROM detected_mail_messages
    WHERE message_id = ?
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
        mentionedBot: message.mentionedBot ? 1 : 0,
        repliedToMessageId: message.repliedToMessageId ?? null,
        repliedToBot: message.repliedToBot ? 1 : 0
      });
    },
    listRecentNormalizedMessages(channelId, limit) {
      return listRecentNormalizedMessagesStatement.all(channelId, limit).map((message) => ({
        ...message,
        isDirectMessage: Boolean(message.isDirectMessage),
        mentionedBot: Boolean(message.mentionedBot),
        repliedToBot: Boolean(message.repliedToBot)
      }));
    },
    getWorkerState(key) {
      return getWorkerStateStatement.get(key)?.value ?? null;
    },
    setWorkerState(key, value) {
      upsertWorkerStateStatement.run(key, value);
    },
    clearWorkerState(key) {
      clearWorkerStateStatement.run(key);
    },
    getLatestNewsBrowseSession(conversationId) {
      const raw = getWorkerStateStatement.get(newsBrowseSessionKey(conversationId))?.value ?? null;
      if (!raw) {
        return null;
      }

      try {
        return JSON.parse(raw) as NewsBrowseSessionRecord;
      } catch {
        return null;
      }
    },
    saveNewsBrowseSession(record) {
      upsertWorkerStateStatement.run(newsBrowseSessionKey(record.conversationId), JSON.stringify(record));
    },
    getPendingConversationalToolSession(conversationId) {
      const raw = getWorkerStateStatement.get(pendingConversationalToolSessionKey(conversationId))?.value ?? null;
      if (!raw) {
        return null;
      }

      try {
        const parsed = JSON.parse(raw) as PendingConversationalToolSessionRecord & {
          clarificationQuestion?: string;
          pendingPrompt?: string;
          pendingStatus?: "clarify" | "requires_confirmation";
        };
        return {
          ...parsed,
          pendingStatus: parsed.pendingStatus ?? "clarify",
          pendingPrompt: parsed.pendingPrompt ?? parsed.clarificationQuestion ?? ""
        };
      } catch {
        return null;
      }
    },
    savePendingConversationalToolSession(record) {
      upsertWorkerStateStatement.run(pendingConversationalToolSessionKey(record.conversationId), JSON.stringify(record));
    },
    clearPendingConversationalToolSession(conversationId) {
      clearWorkerStateStatement.run(pendingConversationalToolSessionKey(conversationId));
    },
    getMailTriageDecision(messageId) {
      return getMailTriageDecisionStatement.get(messageId) ?? null;
    },
    saveMailTriageDecision(record) {
      saveMailTriageDecisionStatement.run(record);
    },
    saveConversationTurn(record) {
      saveConversationTurnStatement.run({
        conversationId: record.conversationId,
        role: record.role,
        participantActorId: record.participantActorId ?? null,
        participantDisplayName: record.participantDisplayName ?? null,
        participantKind: record.participantKind ?? "unknown",
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
        canUsePrivilegedFeatures: record.canUsePrivilegedFeatures ? 1 : 0,
        addressed: record.addressed ? 1 : 0
      });
    },
    saveToolExecutionAudit(record) {
      toolExecutionAuditStatement.run(record);
    },
    saveDiagnosticEvent(event) {
      saveDiagnosticEventStatement.run({
        eventId: event.eventId,
        eventType: event.eventType,
        producerService: event.producer.service,
        correlationId: event.correlation.correlationId,
        causationId: event.correlation.causationId,
        conversationId: event.correlation.conversationId,
        actorId: event.correlation.actorId,
        severity: event.diagnostics.severity,
        category: event.diagnostics.category,
        occurredAt: event.occurredAt
      });
    },
    listRecentDiagnosticEvents(limit) {
      return listRecentDiagnosticEventsStatement.all({ limit });
    },
    upsertServiceHealthSnapshot(record) {
      upsertServiceHealthSnapshotStatement.run(record);
    },
    listServiceHealthSnapshots() {
      return listServiceHealthSnapshotsStatement.all();
    },
    upsertContact(record) {
      const transaction = db.transaction((input: {
        canonicalName: string;
        trustLevel: ContactTrustLevel;
        notes?: string | null;
        aliases?: string[];
        endpoints?: Array<{ kind: ContactEndpointKind; value: string; label?: string | null }>;
      }) => {
        const normalizedCanonicalName = normalizeContactValue(input.canonicalName);
        const existing = getContactByCanonicalNameStatement.get(normalizedCanonicalName);
        const aliases = Array.from(
          new Map(
            (input.aliases ?? [])
              .map((alias) => ({ value: alias.trim(), normalized: normalizeContactValue(alias) }))
              .filter((alias) => alias.normalized.length > 0)
              .map((alias) => [alias.normalized, alias])
          ).values()
        );
        const endpoints = Array.from(
          new Map(
            (input.endpoints ?? [])
              .map((endpoint) => ({
                kind: endpoint.kind,
                value: endpoint.value.trim(),
                valueNormalized: normalizeContactValue(endpoint.value),
                label: endpoint.label?.trim() || null
              }))
              .filter((endpoint) => endpoint.valueNormalized.length > 0)
              .map((endpoint) => [`${endpoint.kind}:${endpoint.valueNormalized}`, endpoint])
          ).values()
        );

        let contactId: number;
        if (existing) {
          contactId = existing.id;
          updateContactStatement.run(input.canonicalName.trim(), normalizedCanonicalName, input.trustLevel, input.notes ?? null, contactId);
        } else {
          const result = insertContactStatement.run(
            input.canonicalName.trim(),
            normalizedCanonicalName,
            input.trustLevel,
            input.notes ?? null
          );
          contactId = Number(result.lastInsertRowid);
        }

        deleteContactAliasesStatement.run(contactId);
        for (const alias of aliases) {
          if (alias.normalized !== normalizedCanonicalName) {
            insertContactAliasStatement.run(contactId, alias.value, alias.normalized);
          }
        }

        deleteContactEndpointsStatement.run(contactId);
        for (const endpoint of endpoints) {
          insertContactEndpointStatement.run(contactId, endpoint.kind, endpoint.value, endpoint.valueNormalized, endpoint.label);
        }

        return loadContactProfile(contactId);
      });

      return transaction(record);
    },
    getContactByNameOrAlias(query) {
      const normalizedQuery = normalizeContactValue(query);
      if (!normalizedQuery) {
        return null;
      }

      const contact = getContactByCanonicalNameStatement.get(normalizedQuery) ?? getContactByAliasStatement.get(normalizedQuery);
      return contact ? loadContactProfile(contact.id) : null;
    },
    listContacts() {
      return listContactsStatement.all().map((contact) => loadContactProfile(contact.id));
    },
    createPendingContactClassification(record) {
      const result = insertPendingContactClassificationStatement.run(
        record.actionType,
        record.contactQuery.trim(),
        record.conversationId
      );
      return getPendingContactClassificationStatement.get(Number(result.lastInsertRowid)) as PendingContactClassificationRecord;
    },
    listPendingContactClassifications() {
      return listPendingContactClassificationsStatement.all();
    },
    getPendingContactClassification(id) {
      return getPendingContactClassificationStatement.get(id) ?? null;
    },
    clearPendingContactClassification(id) {
      deletePendingContactClassificationStatement.run(id);
    },
    enqueueDetectedMailMessage(record) {
      enqueueDetectedMailMessageStatement.run({
        messageId: record.messageId,
        messageJson: JSON.stringify(record.message),
        initialBaseline: record.initialBaseline ? 1 : 0,
        detectedAt: record.detectedAt ?? null
      });
    },
    listDetectedMailMessages(limit = 100) {
      return listDetectedMailMessagesStatement.all(limit).map((row) => ({
        messageId: row.messageId,
        message: JSON.parse(row.messageJson),
        initialBaseline: row.initialBaseline === 1,
        detectedAt: row.detectedAt
      }));
    },
    clearDetectedMailMessage(messageId) {
      clearDetectedMailMessageStatement.run(messageId);
    },
    createEmailAction(record) {
      const result = createEmailActionStatement.run({
        contactQuery: record.contactQuery,
        contactId: record.contactId ?? null,
        recipientEmail: record.recipientEmail ?? null,
        subject: record.subject,
        body: record.body,
        outlookDraftId: record.outlookDraftId ?? null,
        outlookDraftWebLink: record.outlookDraftWebLink ?? null,
        status: record.status,
        riskLevel: record.riskLevel ?? null,
        policyReason: record.policyReason ?? null,
        lastError: record.lastError ?? null,
        createdAt: record.createdAt ?? null,
        sentAt: record.sentAt ?? null
      });
      return getEmailActionStatement.get(Number(result.lastInsertRowid)) as EmailActionRecord;
    },
    getEmailAction(id) {
      return getEmailActionStatement.get(id) ?? null;
    },
    listEmailActions(limit = 20) {
      return listEmailActionsStatement.all(limit);
    },
    updateEmailAction(record) {
      updateEmailActionStatement.run({
        id: record.id,
        contactId: record.contactId ?? null,
        recipientEmail: record.recipientEmail ?? null,
        subject: record.subject ?? null,
        body: record.body ?? null,
        outlookDraftId: record.outlookDraftId ?? null,
        outlookDraftWebLink: record.outlookDraftWebLink ?? null,
        status: record.status ?? null,
        riskLevel: record.riskLevel ?? null,
        policyReason: record.policyReason ?? null,
        lastError: record.lastError ?? null,
        sentAt: record.sentAt ?? null
      });

      return getEmailActionStatement.get(record.id) as EmailActionRecord;
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
    getOAuthToken(provider) {
      const row = getOAuthTokenStatement.get(provider);
      return row
        ? {
            provider: row.provider,
            accessToken: row.accessToken,
            refreshToken: row.refreshToken,
            expiresAt: row.expiresAt,
            scope: row.scope,
            tokenType: row.tokenType
          }
        : null;
    },
    saveOAuthToken(record) {
      upsertOAuthTokenStatement.run(
        record.provider,
        record.accessToken,
        record.refreshToken,
        record.expiresAt,
        record.scope,
        record.tokenType
      );
    },
    clearOAuthToken(provider) {
      clearOAuthTokenStatement.run(provider);
    },
    getOAuthDeviceFlow(provider) {
      const row = getOAuthDeviceFlowStatement.get(provider);
      return row
        ? {
            provider: row.provider,
            deviceCode: row.deviceCode,
            userCode: row.userCode,
            verificationUri: row.verificationUri,
            verificationUriComplete: row.verificationUriComplete,
            expiresAt: row.expiresAt,
            intervalSeconds: row.intervalSeconds,
            message: row.message
          }
        : null;
    },
    saveOAuthDeviceFlow(record) {
      upsertOAuthDeviceFlowStatement.run(
        record.provider,
        record.deviceCode,
        record.userCode,
        record.verificationUri,
        record.verificationUriComplete,
        record.expiresAt,
        record.intervalSeconds,
        record.message
      );
    },
    clearOAuthDeviceFlow(provider) {
      clearOAuthDeviceFlowStatement.run(provider);
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

  function loadContactProfile(contactId: number): ContactProfile {
    const contact = db.prepare<[number], ContactRecord>(`
      SELECT
        id,
        canonical_name AS canonicalName,
        trust_level AS trustLevel,
        notes,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM contacts
      WHERE id = ?
    `).get(contactId);

    if (!contact) {
      throw new Error(`Unknown contact id ${contactId}`);
    }

    return {
      contact,
      aliases: listContactAliasesStatement.all(contactId),
      endpoints: listContactEndpointsStatement.all(contactId)
    };
  }
}

function ensureColumn(db: Database.Database, tableName: string, columnName: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function backfillConversationTurnParticipantIdentity(db: Database.Database) {
  db.prepare(`
    UPDATE conversation_turns
    SET
      participant_actor_id = NULL,
      participant_display_name = COALESCE(NULLIF(participant_display_name, ''), 'Dot'),
      participant_kind = 'assistant'
    WHERE role = 'assistant'
      AND (participant_kind IS NULL OR participant_kind = '' OR participant_kind = 'unknown')
  `).run();
}

function newsBrowseSessionKey(conversationId: string): string {
  return `newsBrowseSession:${conversationId}`;
}

function pendingConversationalToolSessionKey(conversationId: string): string {
  return `pendingConversationalTool:${conversationId}`;
}

function normalizeContactValue(value: string): string {
  return value.trim().toLowerCase();
}
