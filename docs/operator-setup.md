# Dot Operator Setup

## Goal

Bring the backend up on a Linux machine and talk to the bot in Discord with the smallest possible setup path.

## Prerequisites

- Linux machine with Podman and `podman compose`
- Access to the Discord Developer Portal
- A Discord server where you can invite the bot, or willingness to use DMs only
- Required credentials for any enabled integrations

Minimum expected credentials:

- Discord bot token
- Discord owner user ID

Optional credentials depending on enabled features:

- 1minAI API credentials
- Microsoft app registration / client ID for Outlook integration
- Email provider credentials
- SMS provider credentials

## First-Time Setup

### 1. Clone the repository

```bash
git clone git@github.com:dogyear82/dot.git
cd dot
```

### 2. Configure environment and secrets

Create the runtime environment file expected by the app and compose stack.

Expected categories of configuration:

- Discord bot token
- Discord owner user ID
- local model runtime settings for Ollama
- hosted fallback settings for 1minAI
- Outlook configuration
- email adapter configuration
- SMS adapter configuration
- persistence paths or volume settings if needed

Minimum required values for basic Discord chat:

- `DISCORD_BOT_TOKEN`
- `DISCORD_OWNER_USER_ID`

Recommended additional values:

- `EVENT_BUS_ADAPTER`
- `NATS_URL` if you want to run against a NATS broker instead of the in-memory bus
- `OTEL_SERVICE_NAME`
- `OTEL_EXPORTER_OTLP_ENDPOINT` if you want traces exported to Tempo or another OTLP endpoint
- `METRICS_HOST`
- `METRICS_PORT`
- `LOG_FILE_PATH`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
- `ONEMINAI_API_KEY`
- `ONEMINAI_BASE_URL`
- `ONEMINAI_MODEL`
- `OUTLOOK_CLIENT_ID` if you want Outlook calendar support
- `OUTLOOK_TENANT_ID` if you want to target a specific Microsoft tenant instead of `common`

For local Ollama testing with existing models:

- `OLLAMA_BASE_URL=http://ollama:11434`
- `OLLAMA_MODEL=<an installed local model such as openhermes>`

For 1minAI chat:

- `ONEMINAI_BASE_URL=https://api.1min.ai`
- `ONEMINAI_API_KEY=<your 1minAI API key>`
- `ONEMINAI_MODEL=<a valid 1minAI chat model>`

Current implementation note:

- Dot currently posts to `https://api.1min.ai/api/chat-with-ai` and sends credentials with the `API-KEY` header.
- Hosted routing is controlled by the persisted `llm.mode` setting:
  `lite` keeps Dot local-only, `normal` allows hosted fallback on hard failures, and `power` allows hosted usage as a first-class route.
- Replies now include a simple mode indicator such as `[mode: lite]`, `[mode: normal]`, or `[mode: power]`.

For the event bus:

- leave `EVENT_BUS_ADAPTER=in-memory` for local single-process runs outside compose
- set `EVENT_BUS_ADAPTER=nats` and `NATS_URL=<broker-url>` when you want Dot to publish and subscribe through NATS
- the bundled `compose.yaml` now includes a `nats` service and defaults the bot container to `EVENT_BUS_ADAPTER=nats` with `NATS_URL=nats://nats:4222`
- current transport semantics are intentionally simple: canonical Dot events are serialized as JSON, topics map directly to `eventType`, and v1 does not add replay or durable consumer management yet

For observability:

- `OTEL_SERVICE_NAME=dot` is the default logical service name
- `OTEL_EXPORTER_OTLP_ENDPOINT` should be a full OTLP HTTP traces endpoint such as `http://tempo:4318/v1/traces`
- `METRICS_HOST=0.0.0.0` and `METRICS_PORT=9464` expose Prometheus metrics from the bot process and standalone service containers
- `LOG_FILE_PATH=/app/data/logs/dot.log` lets Dot tee JSON logs to a shared file for Promtail ingestion under compose
- logs now include active `traceId`, `spanId`, and canonical event correlation fields when a traced flow is active
- Prometheus should scrape `http://<bot-host>:<METRICS_PORT>/metrics`
- the compose stack provisions Prometheus, Loki, Tempo, Promtail, and Grafana for a basic local/self-hosted run
- Grafana datasources are provisioned automatically; no manual datasource setup is required

The compose stack bind-mounts `${HOME}/ollama` into the Ollama container so downloaded models are reused directly.

For Outlook OAuth:

- set `OUTLOOK_CLIENT_ID`
- optionally set `OUTLOOK_TENANT_ID` and `OUTLOOK_OAUTH_SCOPES`
- keep `Mail.ReadWrite` in `OUTLOOK_OAUTH_SCOPES` if you want the Outlook mail sync substrate to run under the same durable token
- start the bot
- run `!calendar auth start`
- complete the Microsoft device-code sign-in in a browser
- run `!calendar auth complete`
- verify with `!calendar auth status`

For Outlook mail sync:

- optionally set `OUTLOOK_MAIL_APPROVED_FOLDER`, `OUTLOOK_MAIL_NEEDS_ATTENTION_FOLDER`, `OUTLOOK_MAIL_WHITELIST`, `OUTLOOK_MAIL_INITIAL_LOOKBACK_DAYS`, `OUTLOOK_REQUEST_TIMEOUT_MS`, and `OUTLOOK_MAIL_SYNC_INTERVAL_MS`
- the compose stack now includes dedicated `mail-sync` and `mail-triage` service containers
- the mail-sync service uses Microsoft Graph delta sync rather than rescanning the whole inbox every cycle
- it persists the delta cursor for future runs and publishes canonical detected-mail events onto the bus
- the mail-triage service consumes those events and performs triage and folder moves
- on the initial baseline, only mail from the last `OUTLOOK_MAIL_INITIAL_LOOKBACK_DAYS` days is eligible for triage; older inbox backlog is left alone while the cursor is seeded
- Outlook Graph mail requests are bounded by `OUTLOOK_REQUEST_TIMEOUT_MS` so a slow delta sync fails visibly instead of hanging the worker indefinitely
- whitelist sender matches go directly to `Dot Approved`
- suspicious or ambiguous mail is biased toward `Needs Attention`
- clear marketing or newsletter mail is ignored in place

### 3. Create the Discord application

In the Discord Developer Portal:

1. Create a new application.
2. Add a bot user to the application.
3. Copy the bot token into your environment configuration.
4. Enable the intents required by the implementation.
5. Generate an invite URL with the permissions the bot needs.
6. Invite the bot to your server.

Recommended initial scope:

- direct messages with the owner
- one private or controlled server channel for testing

### 4. Start the backend stack

The intended deployment model is Podman Compose-based.

Target operator flow:

```bash
podman-compose up -d --build
```

Expected backend services:

- `bot`
- `mail-sync`
- `mail-triage`
- `ollama`
- `nats`
- `prometheus`
- `loki`
- `promtail`
- `tempo`
- `grafana`

Additional services may be included later if specific integrations require them.

### 5. Verify the stack is healthy

Typical checks:

```bash
podman-compose ps
podman-compose logs -f bot
```

You should confirm:

- the bot container starts successfully
- the bot connects to Discord
- the bot can reach Ollama
- the bot can reach NATS when the compose stack uses the bundled broker
- the bot loads required configuration without fatal errors
- the bot starts the metrics endpoint if observability is enabled

Optional observability checks:

```bash
curl http://127.0.0.1:9464/metrics | head
curl http://127.0.0.1:9090/-/ready
curl http://127.0.0.1:3100/ready
curl http://127.0.0.1:3200/ready
```

If OTLP export is configured, you should also confirm:

- traces are accepted by Tempo or the configured OTLP endpoint
- logs include `traceId` and `spanId` fields for traced request paths

Grafana local access:

- URL: `http://127.0.0.1:3000`
- default username: `admin`
- default password: `admin`
- override with `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD` if needed

Provisioned dashboard:

- title: `Dot Operator Overview`
- location: Grafana `Dashboards` -> `Dot`
- purpose: service health, live event feed, recent failures, throughput, and trace drilldown

Dashboard semantics:

- `good` means the service reported `ready`
- `bad` means the service reported `starting`, `stopping`, or `error`
- `offline` means the service reported `idle` or `stopped`

Trace drilldown:

- use the Loki-backed event or failure panels on the dashboard
- click the `TraceID` derived field on a log line
- Grafana will open the related Tempo trace view

## Talking to the Bot

### Initial interaction

Once the stack is running and the bot is online:

1. Open Discord.
2. Send the bot a DM, or mention it in an allowed channel.
3. The bot should detect missing required settings and begin first-run onboarding.

### What onboarding should collect

The onboarding flow is expected to gather:

- owner confirmation
- persona defaults
- assistant-vs-companion balance
- allowed channel participation rules
- model preferences
- reminder and escalation defaults
- contact/risk policy defaults as needed

### Normal usage after onboarding

- DM the bot for direct conversation and assistant tasks
- mention it in allowed server channels
- use Discord commands or conversational configuration to update settings later

### Contact and policy commands

- `!contact list`
- `!contact show <name>`
- `!contact add <name> <trusted|approval_required|untrusted> [alias=...] [email=...] [phone=...] [discord=...]`
- `!policy check <email.send|sms.send|message.send> <contact>`
- `!policy pending`

When a gated action references an unknown contact, Dot creates a pending classification and tells you to finish it with:

- `!contact classify <pendingId> <trusted|approval_required|untrusted> [name=...] [alias=...] [email=...] [phone=...] [discord=...]`

### Non-owner behavior

Other users in shared channels should only be able to:

- leave a message for you
- interact with you through the constrained contact-relay workflow

They should not be able to use privileged AI or tool features.

## Minimum Path To First Conversation

If the implementation is complete, the shortest path to talking to the bot is:

1. clone the repo
2. set `DISCORD_BOT_TOKEN` and `DISCORD_OWNER_USER_ID`
3. invite the bot to Discord
4. run `podman-compose up -d --build`
5. DM the bot

## Operational Notes

- Ollama is the default local model runtime.
- 1minAI is the hosted fallback when configured.
- NATS is included in the compose stack for the DOT-38 event-bus path.
- OpenTelemetry traces, Prometheus metrics, and correlation-aware structured logs are now emitted by the bot process.
- The compose stack now bundles the full local observability substrate: Prometheus, Loki, Promtail, Tempo, and Grafana.
- Backend services are intended to be containerized so the stack can be started and stopped cleanly.
- Persistent state should survive container restarts via mounted volumes.

## Open Implementation Items

This document describes the intended operator experience. The repository still needs implementation work to fully support it, including:

- Compose file and container definitions
- environment file template
- bot runtime
- onboarding flow
- Discord integration
- Ollama integration
- optional provider integrations
