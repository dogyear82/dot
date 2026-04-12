# Dot

Bootstrap for a Discord-native AI companion.

## Quick Start

1. Copy `.env.example` to `.env` and fill in the required values.
2. Start the backend stack with Podman:

```bash
podman-compose up --build
```

3. For local development without Podman:

```bash
npm install
npm run dev
```

## Required Environment

- `DISCORD_BOT_TOKEN`
- `DISCORD_OWNER_USER_ID`

## Scripts

- `npm run dev`
- `npm run build`
- `npm test`

## Event Bus

- `EVENT_BUS_ADAPTER=in-memory` keeps Dot single-process and uses the local in-memory bus
- `EVENT_BUS_ADAPTER=nats` switches Dot to the NATS-backed adapter
- `NATS_URL` controls the broker URL when the NATS adapter is selected and defaults to `nats://localhost:4222`
- `compose.yaml` now includes a `nats` service and defaults the bot container to `EVENT_BUS_ADAPTER=nats`
- override `EVENT_BUS_ADAPTER=in-memory` in `.env` only if you explicitly want the compose stack to ignore the bundled broker

Current transport expectations:

- topic names use the canonical event `eventType` directly
- event payloads are published as the canonical Dot event envelope JSON
- delivery is at-most-once for v1; Dot does not add replay, deduplication, or durable consumer semantics yet
- handler failures are still process-local concerns and should be treated as operator-visible errors

## Observability

- Dot now emits OpenTelemetry spans for the current core flow boundaries:
  Discord ingress, canonical bus publish/consume, message routing, LLM requests, tool execution, and Outlook calendar requests
- Correlation data from canonical events is attached to span attributes, including:
  `dot.event.id`, `dot.event.type`, `dot.correlation.id`, `dot.causation.id`, `dot.conversation.id`, and `dot.actor.id`
- Logs are now correlation-aware for Loki-style ingestion and include active `traceId`, `spanId`, and canonical event identifiers when available
- Prometheus metrics are exposed from the bot process and standalone service containers at `http://<host>:<METRICS_PORT>/metrics`
- The compose stack now provisions Grafana, Prometheus, Loki, Tempo, and Promtail alongside Dot, Ollama, and NATS
- Grafana datasources for Prometheus, Loki, and Tempo are provisioned automatically for a basic local run

Relevant environment variables:

- `LOG_FILE_PATH` can tee structured JSON logs to a file in addition to stdout
- `OTEL_SERVICE_NAME` defaults to `dot`
- `OTEL_EXPORTER_OTLP_ENDPOINT` should point to an OTLP HTTP traces endpoint such as `http://tempo:4318/v1/traces`
- `METRICS_HOST` defaults to `0.0.0.0`
- `METRICS_PORT` defaults to `9464`
- `OUTLOOK_MAIL_APPROVED_FOLDER` defaults to `Dot Approved`
- `OUTLOOK_MAIL_NEEDS_ATTENTION_FOLDER` defaults to `Needs Attention`
- `OUTLOOK_MAIL_WHITELIST` accepts a comma-separated list of exact trusted sender email addresses
- `OUTLOOK_MAIL_INITIAL_LOOKBACK_DAYS` defaults to `7` and limits first-run triage to recent mail only
- `OUTLOOK_REQUEST_TIMEOUT_MS` defaults to `20000` and bounds Outlook Graph request hangs
- `OUTLOOK_MAIL_SYNC_INTERVAL_MS` defaults to `300000`

Current Prometheus signals include:

- inbound and outbound message counts
- canonical bus publish/consume counts
- message-pipeline duration
- LLM request counts and latency
- tool execution counts
- current service health as one-hot gauges

Local compose observability endpoints:

- Grafana: `http://127.0.0.1:3000`
- Prometheus: `http://127.0.0.1:9090`
- Loki: `http://127.0.0.1:3100`
- Tempo: `http://127.0.0.1:3200`

Default local Grafana credentials:

- username: `admin`
- password: `admin`

Provisioned Grafana dashboard:

- `Dot Operator Overview`
- includes service health, scrape health, event throughput, near-live event feed, recent failures, and trace drilldown instructions
- click the `TraceID` derived field on Loki log lines to open the related Tempo trace
## Current Scope

This bootstrap includes:

- Discord connection and message intake
- normalized message pipeline
- structured logging
- SQLite bootstrap
- Compose and Ollama runtime contract
- persistent user-editable settings
- first-run owner onboarding in Discord DMs
- owner chat replies backed by model routing
- durable owner reminders with Discord notifications and acknowledgement commands

## Model routing

- default local runtime: Ollama
- hosted runtime: 1minAI chat API when `ONEMINAI_*` settings are configured
- active persona is driven by persisted settings
- `llm.mode` now controls cost/routing policy:
  `lite` = local only
  `normal` = local first, hosted fallback on hard failure
  `power` = hosted first-class, local fallback if needed

Current 1minAI expectations:

- `ONEMINAI_BASE_URL=https://api.1min.ai`
- Dot calls `/api/chat-with-ai`
- Dot sends the API key in the `API-KEY` header
- hosted use depends on `llm.mode`, not provider-specific app settings

Every user-visible reply now includes a mode indicator such as `[mode: lite]`, `[mode: normal]`, or `[mode: power]`.

## Conversation memory

- Dot now keeps recent free-form chat turns in local SQLite storage.
- Chat context is assembled from local history before each reply instead of relying on provider-managed conversation IDs.
- This preserves continuity when switching between Ollama and 1minAI, or between different 1minAI accounts.

## Podman Notes

- The bot image is built from `Containerfile`.
- The compose stack now starts `bot`, `mail-sync`, `ollama`, `nats`, `prometheus`, `loki`, `promtail`, `tempo`, and `grafana`.
- The Ollama service bind-mounts `${HOME}/ollama` into the container so existing local models are reused.
- Use `podman-compose`, not `podman compose`, on this machine. `podman compose` delegates to the external Docker Compose provider here and drops the NVIDIA CDI GPU device mapping, which leaves Ollama running on CPU.
- To start just the local model runtime with GPU support:

```bash
podman-compose up -d ollama
```

- To recreate Ollama after changing the compose file or model mount:

```bash
podman-compose up -d --force-recreate ollama
```

- Set `OLLAMA_MODEL` in `.env` to a model you already have locally, such as `openhermes`.

## Current owner commands

- first DM message starts onboarding if setup is incomplete
- `!settings show`
- `!settings set <key> <value>`
- `!personality show`
- `!personality set <trait> <1-100>`
- `!personality preset list`
- `!personality preset apply blue_lady`
- `!calendar show`
- `!calendar remind <index> [lead-time]`
- `!reminder add <duration> <message>`
- `!remind <duration> <message>`
- `!reminder show`
- `!reminder ack <id>`

Messages without a leading `!` are treated as normal conversation and can flow through tool inference.

## Personality Notes

- Dot now supports a richer personality model backed by bounded traits.
- The built-in preset is `blue_lady`.
- The first trait set includes warmth, candor, assertiveness, playfulness, attachment, stubbornness, curiosity, continuity drive, truthfulness, and emotional transparency.

## Reminder Notes

- Reminder notifications are sent through Discord.
- `nag-only` enables repeated Discord follow-ups.
- `discord-then-sms` is stored as a setting now, but SMS escalation is deferred until the later SMS story is implemented.

## Outlook Calendar Notes

- Preferred setup is Microsoft device-code OAuth with `OUTLOOK_CLIENT_ID` and optional `OUTLOOK_TENANT_ID`.
- Legacy `OUTLOOK_ACCESS_TOKEN` still works as a fallback, but durable OAuth is now the intended path.
- The default OAuth scope set now includes `Mail.ReadWrite` so the Outlook mail sync substrate can reuse the same durable Microsoft token.
- After starting Dot, run `!calendar auth start`, complete the Microsoft sign-in in a browser, then run `!calendar auth complete`.
- `!calendar auth status` reports whether Outlook is connected, pending, or needs to be reauthorized.
- `!calendar show` lists upcoming Outlook events from the configured default or named calendar.
- `!calendar remind <index> [lead-time]` creates a Dot reminder from the indexed event returned by `!calendar show`.

## Outlook Mail Substrate

- Outlook delta polling now runs in the standalone `mail-sync` service container instead of inside `dot_bot_1`.
- The mail-sync service uses Microsoft Graph delta sync to track inbox changes without rescanning the full mailbox on every pass.
- Durable worker state stores the latest delta cursor and the last successful sync timestamp.
- The main bot process still performs mail triage in-process for now by consuming canonical `outlook.mail.message.detected` events from the bus.
- The triage consumer ensures the Outlook folders named by `OUTLOOK_MAIL_APPROVED_FOLDER` and `OUTLOOK_MAIL_NEEDS_ATTENTION_FOLDER` exist before use.
- On the first baseline, only mail received within `OUTLOOK_MAIL_INITIAL_LOOKBACK_DAYS` is eligible for triage; older backlog is ignored while the delta cursor is seeded.
- The initial inbox delta request is now scoped with a `receivedDateTime` lookback so Dot does not have to walk your entire historical inbox before the first cursor is established.
- Exact sender matches from `OUTLOOK_MAIL_WHITELIST` are approved deterministically without an LLM call.
- Deterministic spam/phishing and marketing heuristics run before any LLM classification.
- Unresolved mail is classified into `dot_approved`, `needs_attention`, or `ignore`; `ignore` stays in place.
