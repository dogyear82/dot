# Dot

Bootstrap for a Discord-native AI companion.

## Quick Start

1. Copy `.env.example` to `.env` and fill in the required values.
2. Start the backend stack:

```bash
docker compose up --build
```

3. For local development without Docker:

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
