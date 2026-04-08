# Dot

Bootstrap for a Discord-native AI companion.

## Quick Start

1. Copy `.env.example` to `.env` and fill in the required values.
2. Start the backend stack with Podman:

```bash
podman compose up --build
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
- hosted fallback: OpenAI-compatible endpoint when `ONEMINAI_*` settings are configured
- active persona is driven by persisted settings

## Podman Notes

- The bot image is built from `Containerfile`.
- The Ollama service bind-mounts `${HOME}/ollama` into the container so existing local models are reused.
- Set `OLLAMA_MODEL` in `.env` to a model you already have locally, such as `openhermes`.

## Current owner commands

- first DM message starts onboarding if setup is incomplete
- `settings show`
- `settings set <key> <value>`
- `reminder add <duration> <message>`
- `remind <duration> <message>`
- `reminder show`
- `reminder ack <id>`

## Reminder Notes

- Reminder notifications are sent through Discord.
- `nag-only` enables repeated Discord follow-ups.
- `discord-then-sms` is stored as a setting now, but SMS escalation is deferred until the later SMS story is implemented.
