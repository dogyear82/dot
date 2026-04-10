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
- Until `DOT-22` lands, hosted routing is still controlled by the existing `models.primary` setting rather than `llm.mode`.

The compose stack bind-mounts `${HOME}/ollama` into the Ollama container so downloaded models are reused directly.

For Outlook OAuth:

- set `OUTLOOK_CLIENT_ID`
- optionally set `OUTLOOK_TENANT_ID` and `OUTLOOK_OAUTH_SCOPES`
- if you want the background Outlook mail worker, keep `Mail.ReadWrite` in `OUTLOOK_OAUTH_SCOPES`
- optionally set `OUTLOOK_MAIL_SYNC_INTERVAL_MS` and `OUTLOOK_MAIL_APPROVED_FOLDER`
- start the bot
- run `!calendar auth start`
- complete the Microsoft device-code sign-in in a browser
- run `!calendar auth complete`
- verify with `!calendar auth status`

For the Outlook mail sync worker:

- the first pass stays single-process inside the bot runtime
- it uses Microsoft Graph delta sync rather than rescanning the whole mailbox each cycle
- it ensures the approved folder exists before future triage stories move mail into it

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
podman compose up -d
```

Expected backend services:

- `bot`
- `ollama`

Additional services may be included later if specific integrations require them.

### 5. Verify the stack is healthy

Typical checks:

```bash
podman compose ps
podman compose logs -f bot
```

You should confirm:

- the bot container starts successfully
- the bot connects to Discord
- the bot can reach Ollama
- the bot loads required configuration without fatal errors

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
4. run `podman compose up -d`
5. DM the bot

## Operational Notes

- Ollama is the default local model runtime.
- 1minAI is the hosted fallback when configured.
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
