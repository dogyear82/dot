import { Pool } from "pg";

import { createSettingsStore, getSettingDefinitions, type SettingKey, type SettingsStore } from "./settings.js";
import type { DotEvent } from "./events.js";
import type {
  AccessAuditRecord,
  ConversationTurnRecord,
  DiagnosticEventRecord,
  IncomingMessage,
  ServiceHealthSnapshotRecord,
  ConversationParticipantKind
} from "./types.js";

export interface Persistence {
  settings: SettingsStore;
  saveNormalizedMessage(message: IncomingMessage): Promise<void>;
  saveConversationTurn(record: {
    conversationId: string;
    role: "user" | "assistant";
    participantActorId?: string | null;
    participantDisplayName?: string | null;
    participantKind?: ConversationParticipantKind;
    content: string;
    sourceMessageId?: string | null;
    createdAt?: string;
  }): Promise<void>;
  listRecentConversationTurns(conversationId: string, limit: number): Promise<ConversationTurnRecord[]>;
  saveAccessAudit(record: AccessAuditRecord): Promise<void>;
  saveDiagnosticEvent(event: DotEvent): Promise<void>;
  upsertServiceHealthSnapshot(record: ServiceHealthSnapshotRecord): Promise<void>;
  close(): Promise<void>;
}

export async function initializePersistence(_dataDir: string, databaseUrl: string): Promise<Persistence> {
  const pool = new Pool({
    connectionString: databaseUrl
  });

  await pool.query("SELECT 1");
  await ensureSchema(pool);

  const loadedSettings = await loadSettings(pool);
  const settings = createSettingsStore({
    initialValues: loadedSettings,
    onSet: async (key, value) => {
      await upsertSetting(pool, key, value);
    }
  });

  await seedBootstrapSettings(pool, settings);

  return {
    settings,
    async saveNormalizedMessage(message) {
      await pool.query(
        `
          INSERT INTO normalized_messages (
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
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11::timestamptz
          )
          ON CONFLICT (id) DO UPDATE SET
            channel_id = EXCLUDED.channel_id,
            guild_id = EXCLUDED.guild_id,
            author_id = EXCLUDED.author_id,
            author_username = EXCLUDED.author_username,
            content = EXCLUDED.content,
            is_direct_message = EXCLUDED.is_direct_message,
            mentioned_bot = EXCLUDED.mentioned_bot,
            replied_to_message_id = EXCLUDED.replied_to_message_id,
            replied_to_bot = EXCLUDED.replied_to_bot,
            created_at = EXCLUDED.created_at
        `,
        [
          message.id,
          message.channelId,
          message.guildId ?? null,
          message.authorId,
          message.authorUsername,
          message.content,
          message.isDirectMessage,
          message.mentionedBot,
          message.repliedToMessageId ?? null,
          message.repliedToBot ?? false,
          message.createdAt
        ]
      );
    },

    async saveConversationTurn(record) {
      await pool.query(
        `
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
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            COALESCE($8::timestamptz, CURRENT_TIMESTAMP)
          )
        `,
        [
          record.conversationId,
          record.role,
          record.participantActorId ?? null,
          record.participantDisplayName ?? null,
          record.participantKind ?? "unknown",
          record.content,
          record.sourceMessageId ?? null,
          record.createdAt ?? null
        ]
      );
    },

    async listRecentConversationTurns(conversationId, limit) {
      const result = await pool.query<ConversationTurnRecord>(
        `
          SELECT
            id,
            conversation_id AS "conversationId",
            role,
            participant_actor_id AS "participantActorId",
            participant_display_name AS "participantDisplayName",
            participant_kind AS "participantKind",
            content,
            source_message_id AS "sourceMessageId",
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
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
            WHERE conversation_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT $2
          ) recent
          ORDER BY created_at ASC, id ASC
        `,
        [conversationId, limit]
      );

      return result.rows;
    },

    async saveAccessAudit(record) {
      await pool.query(
        `
          INSERT INTO access_audit (
            message_id,
            actor_role,
            can_use_privileged_features,
            decision,
            addressed,
            addressed_reason,
            transport,
            conversation_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          record.messageId,
          record.actorRole,
          record.canUsePrivilegedFeatures,
          record.decision,
          record.addressed ?? false,
          record.addressedReason ?? "",
          record.transport ?? "discord",
          record.conversationId ?? ""
        ]
      );
    },

    async saveDiagnosticEvent(event) {
      await pool.query(
        `
          INSERT INTO diagnostic_events (
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
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10::timestamptz
          )
          ON CONFLICT (event_id) DO UPDATE SET
            event_type = EXCLUDED.event_type,
            producer_service = EXCLUDED.producer_service,
            correlation_id = EXCLUDED.correlation_id,
            causation_id = EXCLUDED.causation_id,
            conversation_id = EXCLUDED.conversation_id,
            actor_id = EXCLUDED.actor_id,
            severity = EXCLUDED.severity,
            category = EXCLUDED.category,
            occurred_at = EXCLUDED.occurred_at
        `,
        [
          event.eventId,
          event.eventType,
          event.producer.service,
          event.correlation.correlationId ?? null,
          event.correlation.causationId ?? null,
          event.correlation.conversationId ?? null,
          null,
          "info",
          null,
          event.occurredAt
        ]
      );
    },

    async upsertServiceHealthSnapshot(record) {
      await pool.query(
        `
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
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
          ON CONFLICT (service, check_name) DO UPDATE SET
            status = EXCLUDED.status,
            state = EXCLUDED.state,
            detail = EXCLUDED.detail,
            observed_latency_ms = EXCLUDED.observed_latency_ms,
            source_event_id = EXCLUDED.source_event_id,
            last_event_id = EXCLUDED.last_event_id,
            updated_at = EXCLUDED.updated_at
        `,
        [
          record.service,
          record.checkName,
          record.status,
          record.state ?? null,
          record.detail ?? null,
          record.observedLatencyMs ?? null,
          record.sourceEventId ?? null,
          record.lastEventId,
          record.updatedAt
        ]
      );
    },

    async close() {
      await pool.end();
    }
  };
}

async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS normalized_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      guild_id TEXT,
      author_id TEXT NOT NULL,
      author_username TEXT NOT NULL,
      content TEXT NOT NULL,
      is_direct_message BOOLEAN NOT NULL,
      mentioned_bot BOOLEAN NOT NULL,
      replied_to_message_id TEXT,
      replied_to_bot BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversation_turns (
      id BIGSERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      participant_actor_id TEXT,
      participant_display_name TEXT,
      participant_kind TEXT NOT NULL DEFAULT 'unknown',
      content TEXT NOT NULL,
      source_message_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_turns_lookup
      ON conversation_turns (conversation_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS access_audit (
      id BIGSERIAL PRIMARY KEY,
      message_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      can_use_privileged_features BOOLEAN NOT NULL,
      decision TEXT NOT NULL,
      addressed BOOLEAN NOT NULL DEFAULT FALSE,
      addressed_reason TEXT NOT NULL DEFAULT '',
      transport TEXT NOT NULL DEFAULT 'discord',
      conversation_id TEXT NOT NULL DEFAULT '',
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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
      occurred_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_health_snapshots (
      service TEXT NOT NULL,
      check_name TEXT NOT NULL,
      status TEXT NOT NULL,
      state TEXT,
      detail TEXT,
      observed_latency_ms DOUBLE PRECISION,
      source_event_id TEXT,
      last_event_id TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (service, check_name)
    );
  `);
}

async function loadSettings(pool: Pool): Promise<Partial<Record<SettingKey, string>>> {
  const result = await pool.query<{ key: SettingKey; value: string }>(
    "SELECT key, value FROM settings"
  );

  return Object.fromEntries(result.rows.map((row: { key: SettingKey; value: string }) => [row.key, row.value])) as Partial<
    Record<SettingKey, string>
  >;
}

async function upsertSetting(pool: Pool, key: SettingKey, value: string): Promise<void> {
  await pool.query(
    `
      INSERT INTO settings (key, value, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = CURRENT_TIMESTAMP
    `,
    [key, value]
  );
}

async function seedBootstrapSettings(pool: Pool, settings: SettingsStore): Promise<void> {
  const bootstrapKeys: SettingKey[] = [
    "onboarding.completed",
    "personality.activeProfile",
    "personality.quirkOverrides"
  ];
  const definitions = new Map(getSettingDefinitions().map((definition) => [definition.key, definition]));

  for (const key of bootstrapKeys) {
    if (!settings.isConfigured(key)) {
      const defaultValue = settings.get(key) ?? definitions.get(key)?.defaultValue;
      if (defaultValue != null) {
        await upsertSetting(pool, key, defaultValue);
      }
    }
  }
}
