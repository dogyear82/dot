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
- The compose stack now starts `bot`, `ollama`, and `nats`.
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
- After starting Dot, run `!calendar auth start`, complete the Microsoft sign-in in a browser, then run `!calendar auth complete`.
- `!calendar auth status` reports whether Outlook is connected, pending, or needs to be reauthorized.
- `!calendar show` lists upcoming Outlook events from the configured default or named calendar.
- `!calendar remind <index> [lead-time]` creates a Dot reminder from the indexed event returned by `!calendar show`.
