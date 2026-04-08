# Discord AI Companion Architecture

## Overview

This document proposes a first-release architecture for a personal Discord-native AI companion that can chat, manage reminders, mediate contact from other Discord users, and execute bounded tools with deterministic safety controls.

The design optimizes for:

- single-user ownership
- Discord as the only primary UI
- configurable behavior and persona
- local-model preference with hosted fallback
- durable task/reminder state
- deterministic outbound-communication safety
- portable self-hosting through containerized backend services

## Architectural Principles

1. Keep conversation generation separate from policy enforcement.
2. Treat the owner and all non-owner users as different trust domains.
3. Persist tasks, reminders, trust classifications, and settings outside model context.
4. Route all external side effects through deterministic tool adapters.
5. Prefer simple infrastructure that can run on one machine for v1.
6. Prefer containerized infrastructure that can be started on another Linux machine with Podman Compose.

## Recommended Technology Direction

Recommended baseline stack for v1:

- Runtime: `TypeScript` on `Node.js`
- Discord adapter: `discord.js`
- Persistence: `SQLite` with a lightweight ORM or query layer
- Scheduler: in-process scheduler backed by persistent task records
- Local model adapter: `Ollama`
- Hosted model adapter: `1minAI`
- Outlook integration: Microsoft Graph adapter
- Email adapter: Microsoft Graph mail or SMTP-backed adapter, to be finalized
- SMS adapter: provider TBD
- Deployment: `Podman Compose`

Rationale:

- Discord and integration support are strong in Node.
- A single-process service with SQLite is enough for a single-user bot and keeps operations simple.
- Adapter boundaries allow model and messaging providers to change without rewriting the conversation layer.
- Podman Compose aligns with the portability requirement for bringing the stack up quickly on another Linux machine.

## Deployment Shape

Recommended v1 deployment:

- `bot` container for the Node.js Discord application
- `ollama` container for local model serving
- optional additional container only if a chosen adapter requires it later
- bind-mounted or named-volume persistence for SQLite and Ollama model data
- `.env`-driven secrets/configuration for Discord, Outlook, email, SMS, and hosted model fallback

Recommended operational target:

- clone the repository on a Linux machine
- provide environment configuration and any required secrets
- run `podman compose up -d`

Notes:

- The simplest version keeps SQLite inside the bot container with a mounted volume.
- If Discord connectivity works cleanly in Podman, the bot itself should be containerized too.
- Only split services further if a real operational constraint appears.

## Proposed Components

### 1. Discord Gateway Adapter

Responsibilities:

- connect to Discord events
- normalize incoming messages, mentions, DMs, and channel context
- identify the sender and channel
- hand normalized events to the application layer
- send replies, drafts, prompts, and reminder notifications back to Discord

Key outputs:

- `IncomingMessage`
- `InteractionContext`
- `UserIdentity`

### 2. Identity and Access Controller

Responsibilities:

- identify the primary user by configured Discord user ID or allowlist
- classify all other Discord users as non-owner users
- enforce that only the owner can access privileged AI/tool features
- restrict non-owner users to contact-routing and owner-interaction workflows

Key decisions:

- owner identity must be deterministic and not inferred by the LLM
- authorization checks happen before model/tool orchestration

### 3. Conversation Orchestrator

Responsibilities:

- decide how to handle each incoming event
- assemble the right context for a model call
- choose between chat-only response, clarification, tool proposal, or tool execution
- pull pending inbox/tasks that should be surfaced to the owner
- switch between regular companion mode and diagnostic mode

The orchestrator should not call providers directly. It should delegate to:

- model router
- policy engine
- tool executor
- task/inbox service

### 4. Persona and Settings Service

Responsibilities:

- store configurable behavior values
- define persona profiles such as `sheltered` and `diagnostic`
- store channel participation rules
- store reminder escalation preferences
- store assistant-vs-companion weighting
- support first-run onboarding and later edits through Discord

Recommended design:

- settings persisted in SQLite
- typed schema for values that policy and orchestration need deterministically
- persona prompt templates versioned in code

### 5. Model Router

Responsibilities:

- choose a model provider for each request
- prefer local models when configured and healthy
- fail over to `1minAI` when allowed
- record provider choice and failure reasons for diagnostics

Recommended interface:

- `generateReply(context, profile)`
- `classifyIntent(context)` only if needed and bounded
- `summarize(content)`
- `draftMessage(request)`

Important constraint:

- risk approval decisions must not be delegated to the model router

### 6. Policy Engine

Responsibilities:

- classify requested actions as low-risk or high-risk
- validate recipient trust status from persistent storage
- require confirmation for high-risk actions
- block execution when policy preconditions are missing
- ask for classification or clarification when needed

Recommended design:

- deterministic rules implemented in code
- no policy branch should depend on free-form model output alone

Policy inputs:

- actor identity
- action type
- recipient identity mapping
- trust classification
- channel/context
- current configuration

### 7. Contact and Trust Directory

Responsibilities:

- store people, aliases, and communication endpoints
- store trust classifications such as family / close friend / unknown / untrusted
- resolve names like `Michelle` into stable contact records
- support user confirmation when identity or trust status is unknown

Recommended minimum schema:

- `contacts`
- `contact_aliases`
- `contact_channels` for email, phone, Discord handle
- `trust_classifications`

### 8. Tool Registry and Executor

Responsibilities:

- expose bounded tools to the orchestrator
- validate structured tool inputs
- invoke side-effecting adapters only after policy approval
- return structured execution results

Initial tool set:

- Discord reply
- reminder create/update/acknowledge
- Outlook calendar lookup/create reminder
- email draft/send
- SMS send-to-owner
- contact request intake

### 9. Task, Reminder, and Inbox Service

Responsibilities:

- persist deferred work items
- maintain reminder schedules and escalation state
- store non-owner contact requests for owner review
- surface pending items at the start of owner conversations
- track delivery attempts and acknowledgement state

Recommended minimum task types:

- `reminder`
- `pending_contact_request`
- `pending_high_risk_confirmation`
- `deferred_follow_up`

Important note:

- this subsystem is required, not optional, because reminders and relayed messages must survive restarts

### 10. External Integration Adapters

Responsibilities:

- implement provider-specific calls behind stable interfaces
- handle retries, failures, and structured errors

Initial adapters:

- `OutlookCalendarAdapter`
- `EmailAdapter`
- `SmsAdapter`
- `OllamaAdapter`
- `OneMinAiAdapter`

### 11. Container and Runtime Packaging

Responsibilities:

- define the container images and runtime contracts for local self-hosting
- package the bot for reproducible deployment across Linux machines
- manage mounted storage paths for SQLite state, logs, and Ollama models
- provide a Compose topology that starts the backend stack with minimal manual steps

Recommended design:

- one `Containerfile` for the bot service
- one `compose.yaml` at repo root
- explicit healthchecks where practical
- restart policies suitable for a personal always-on bot

## Data Model Outline

Recommended initial tables:

- `users`
  - owner record and any non-owner Discord identities seen by the system
- `settings`
  - keyed owner configuration values
- `persona_profiles`
  - prompt/profile metadata if stored dynamically
- `contacts`
  - canonical contact records
- `contact_aliases`
  - alternate names for contacts
- `contact_endpoints`
  - email addresses, phone numbers, Discord handles
- `trust_relationships`
  - trust category and notes
- `tasks`
  - task type, status, priority, due time
- `task_events`
  - audit/history for reminders, escalations, and deliveries
- `messages`
  - normalized interaction history references as needed
- `pending_confirmations`
  - approval requests waiting on owner input
- `tool_executions`
  - structured audit record of tool calls and outcomes

Recommended persistent volumes:

- SQLite database volume
- application state/log volume if needed
- Ollama model cache volume

## Key Workflows

### Owner Conversation

1. Discord event enters through the gateway adapter.
2. Identity controller marks the sender as owner.
3. Conversation orchestrator loads pending inbox/reminder items.
4. Orchestrator decides whether to answer directly, ask clarification, or invoke a tool.
5. If a tool is needed, policy engine checks risk and prerequisites.
6. Tool executor performs the action through the appropriate adapter.
7. Result and any durable state changes are persisted.

### Non-Owner Contact Relay

1. Non-owner user sends a message in an allowed Discord context.
2. Identity controller blocks privileged bot functions.
3. Orchestrator treats the interaction as contact-routing only.
4. Bot collects enough structured detail to relay the message to the owner.
5. Task/inbox service stores a `pending_contact_request`.
6. The owner sees that pending item prominently in the next relevant conversation.
7. Optional escalation can later notify the owner via reminder/SMS rules.

### High-Risk Outbound Communication

1. Owner asks the bot to send an email or message.
2. Tool executor resolves the target contact.
3. Policy engine checks trust classification.
4. If trust classification is unknown, the bot asks and stores the answer.
5. If action is high-risk, the bot creates a confirmation or draft task instead of sending immediately.
6. Only after explicit approval does the send adapter execute.

### Reminder Escalation

1. Owner creates a reminder or the bot creates one from context.
2. Task service stores the reminder and escalation policy.
3. Scheduler wakes on due time and sends a Discord reminder.
4. If not acknowledged, the task transitions through escalation steps.
5. Later steps may trigger repeat Discord messages or an SMS to the owner, depending on configuration.

### First-Run Onboarding

1. Bot detects missing required settings on startup.
2. It opens an onboarding conversation with the owner in Discord.
3. It captures owner identity, persona defaults, channel rules, provider preferences, and safety defaults.
4. Settings are persisted and can later be changed via commands or chat flows.

## Boundary Decisions

### Keep LLMs Out of Safety Decisions

The model may propose intents or draft content, but the following must remain deterministic:

- owner vs non-owner authorization
- low-risk vs high-risk execution gating
- trust contact lookup
- whether approval is required
- whether a task should be persisted before execution

### Separate Inbox From Chat History

Relayed messages, reminders, confirmations, and follow-ups should be first-class task records, not just messages embedded in chat transcripts. This keeps them queryable, survivable, and auditable.

### Use Adapters for Every External Service

Every side-effecting integration should be isolated behind an adapter so:

- local testing is easier
- provider replacement is cheaper
- failures are easier to classify and retry

## Phased Delivery Recommendation

### Phase 1

- Discord bot connection
- owner authentication
- configurable settings store
- basic chat with model routing
- non-owner contact relay restrictions
- internal inbox/task persistence

### Phase 2

- deterministic policy engine
- contact/trust directory
- reminder engine
- Outlook calendar integration

### Phase 3

- SMS-to-owner escalation
- email draft/send workflow
- approval and confirmation flows
- richer diagnostic mode

## Main Risks

1. Ambiguity around email and SMS providers can leak into design if adapters are not defined early.
2. Name resolution for contacts can cause mistakes if aliases and endpoints are not modeled carefully.
3. Allowing context-driven tool execution can create surprising behavior unless intent thresholds and policy gates are conservative.
4. Reminder escalation can become noisy if acknowledgement and snooze semantics are underspecified.
5. Discord-only configuration may become awkward if admin flows are not structured and stateful.

## Architectural Decisions Still Needed

1. Whether high-risk outbound communication should always be draft-first or can sometimes go directly to confirmation.
2. Exact default reminder escalation ladder and acknowledgement semantics.
3. Exact owner-only and non-owner interaction rules in shared channels.
4. Email provider choice and authentication method.
5. SMS provider choice and delivery guarantees.
6. Which local models are acceptable for default deployment.

## Recommended First ADRs

1. Runtime and persistence choice: `Node.js + TypeScript + SQLite`
2. Deterministic policy engine as a hard gate before any external side effect
3. Task/inbox subsystem as a core dependency, not a later enhancement
4. Provider adapters for model, calendar, email, and SMS integrations
