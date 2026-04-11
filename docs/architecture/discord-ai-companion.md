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
7. Treat transport adapters as edge services that publish and consume internal events instead of embedding core orchestration logic directly in channel handlers.
8. Preserve enough routing metadata on every inbound event that replies can be delivered back through the correct transport, conversation, and destination later.

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
- An event-driven seam inside the application allows the system to grow toward multiple transports and smaller services without forcing a full distributed system immediately.

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
- The recommended migration path is internal event-driven architecture first, process separation later if and when the boundaries prove valuable operationally.

## Single-Process Service Hosts

Current runtime shape:

- keep one Node.js process for operational simplicity
- decompose bootstrap into named service hosts with explicit lifecycle boundaries
- start and stop hosts through a coordinator instead of wiring everything directly in `index.ts`
- preserve bus-based seams so each host can later become its own container-backed service

Current host topology:

- `event-bus`
- `observability`
- `outlook`
- `llm`
- `message-router`
- `discord-transport`
- `reminders`
- `diagnostics`
- `mail-sync`

Rules:

- each host owns one bounded responsibility
- hosts expose explicit startup and shutdown behavior
- startup order is deterministic and shutdown runs in reverse order
- startup failures must roll back previously started hosts
- this layer is a migration seam toward future containerized services, not a second orchestration framework

Near-term implication:

- the system still runs as a single process today
- future service extraction should preserve the same host names, event topics, and ownership boundaries wherever practical
- new infrastructure like mail sync or diagnostics should prefer landing as their own host boundary before they become separate containers

Current mail-sync boundary:

- keep the Outlook mail sync worker inside the single bot process for now
- use a bounded mail adapter around Microsoft Graph mail delta and move-folder APIs
- persist the approved-folder identifier and delta cursor as durable worker state
- leave classification and move/no-move decisions to a later story once the substrate is stable

## Observability Substrate

Current direction:

- OpenTelemetry spans for request and event-path tracing
- Prometheus metrics for health, throughput, latency, and failure signals
- structured JSON logs with correlation and trace identifiers for Loki ingestion
- a compose-managed local stack of Grafana, Prometheus, Loki, Tempo, and Promtail to back operator diagnostics consistently across development and self-hosted deployment

Current emitted boundaries:

- Discord ingress and delivery
- canonical event-bus publish/consume
- message routing
- LLM requests
- tool execution
- Outlook calendar requests

Rules:

- canonical event identifiers and correlation fields should be attached to span attributes
- logs should include `traceId`, `spanId`, and canonical correlation identifiers whenever a traced flow is active
- Prometheus metrics should stay low-cardinality and avoid per-message labels
- the dashboard should consume these emitted signals rather than inspect process internals directly
- the v1 operator dashboard should stay Grafana-native and rely on logs-to-traces drilldown rather than a custom flowchart UI

## Proposed Components

### 1. Discord Gateway Adapter

Responsibilities:

- connect to Discord events
- normalize incoming messages, mentions, DMs, and channel context
- identify the sender and channel
- produce a canonical inbound event with transport-specific routing metadata
- publish that event to the internal message bus instead of calling orchestration logic directly
- subscribe to outbound message events that target Discord
- send replies, drafts, prompts, and reminder notifications back to Discord

Key outputs:

- `IncomingMessage`
- `InteractionContext`
- `UserIdentity`
- `TransportEnvelope`
- `InboundMessageReceived`

Key rule:

- the Discord adapter should know Discord-specific IDs and delivery APIs, but it should not own conversation orchestration, tool selection, or policy decisions

### 2. Identity and Access Controller

Responsibilities:

- identify the primary user by configured Discord user ID or allowlist
- classify all other Discord users as non-owner users
- enforce that only the owner can access privileged AI/tool features
- restrict non-owner users to contact-routing and owner-interaction workflows

Key decisions:

- owner identity must be deterministic and not inferred by the LLM
- authorization checks happen before model/tool orchestration

### 3. Internal Event Bus and Envelope

Responsibilities:

- provide a stable transport-neutral message contract between adapters and core services
- carry origin metadata needed for later reply delivery
- decouple inbound transport handling from downstream processing and outbound delivery
- allow the system to remain one process in v1 while preserving seams for future service splitting

Recommended design:

- start with an in-process event bus and typed event contracts
- treat bus abstraction as mandatory even if the first implementation is just local process pub/sub
- only graduate to an external broker if reliability or independent scaling actually demands it
- use the canonical `eventType` as the bus topic name so transports can stay mechanically simple
- keep the v1 delivery contract explicit: at-most-once delivery, no replay, no durable consumer offsets, and handler failures treated as service-level errors rather than broker-managed retries

Recommended core event fields:

- `eventId`
- `eventType`
- `eventVersion`
- `occurredAt`
- `producer`
- `correlation`
- `routing`
- `diagnostics`
- `payload`

Canonical envelope shape:

```ts
type DotEvent<TPayload = unknown> = {
  eventId: string;
  eventType: string;
  eventVersion: string;
  occurredAt: string;
  producer: {
    service: string;
    instanceId?: string;
  };
  correlation: {
    correlationId: string;
    causationId: string | null;
    conversationId: string | null;
    actorId: string | null;
  };
  routing: {
    transport: string | null;
    channelId: string | null;
    guildId: string | null;
    replyTo: string | null;
  };
  diagnostics: {
    severity: "debug" | "info" | "warn" | "error";
    category: string | null;
  };
  payload: TPayload;
};
```

Rules:

- all inter-service events use the same top-level envelope
- only `payload` changes materially by domain
- `correlationId` groups an end-to-end flow
- `causationId` links a derived event to its parent event
- routing metadata belongs in `routing`, not flattened top-level fields
- additive payload evolution should preserve existing event consumers whenever possible

Examples:

- `InboundMessageReceived`
- `OutboundMessageRequested`
- `ServiceHealthReported`
- `ReminderDue`
- `ToolExecutionCompleted`
- `DeliveryFailed`

Current minimum contract in code:

- inbound event: `inbound.message.received`
- outbound delivery request: `outbound.message.requested`
- service health event: `diagnostics.health.reported`
- current transport: `discord`
- current conversation key: Discord `channelId`
- current reply route: `transport`, `channelId`, `guildId`, `replyToMessageId`

Important non-goal for this phase:

- keep the system single-process and in-memory for dispatch; this seam exists to stabilize contracts and adapter boundaries first, not to introduce a broker or worker fleet yet

### Service Health Contract

All service-health emission should use the canonical diagnostics event:

```ts
type ServiceHealthReportedPayload = {
  service: string;
  checkName: string;
  status: "good" | "bad" | "offline";
  state: string | null;
  detail: string | null;
  observedLatencyMs: number | null;
  sourceEventId: string | null;
};
```

Recommended mapping rules for host lifecycle:

- `ready` => `good`
- `idle` => `offline`
- `stopped` => `offline`
- `starting` => `bad`
- `stopping` => `bad`
- `error` => `bad`

Notes:

- `status` is the operator-facing summary for dashboards and alerts
- `state` carries the more precise internal lifecycle state when needed
- service-health events should be emitted consistently by every host or service boundary rather than inferred ad hoc in the UI

### 4. Conversation Orchestrator

Responsibilities:

- consume canonical inbound events from the message bus
- decide how to handle each incoming event
- assemble the right context for a model call
- choose between chat-only response, clarification, tool proposal, or tool execution
- pull pending inbox/tasks that should be surfaced to the owner
- switch between regular companion mode and diagnostic mode
- emit outbound message requests and state-change events rather than writing directly to Discord

The orchestrator should not call providers directly. It should delegate to:

- model router
- policy engine
- tool executor
- task/inbox service
- outbound delivery routing

Important constraint:

- the orchestrator may use model output to decide whether a tool is appropriate, but any actual side effect must be executed through a structured tool interface

### 5. Persona and Settings Service

Responsibilities:

- store configurable behavior values
- define persona profiles such as `sheltered` and `diagnostic`
- store richer personality trait values and AI self-concept
- store channel participation rules
- store reminder escalation preferences
- store assistant-vs-companion weighting
- support first-run onboarding and later edits through Discord

Recommended design:

- settings persisted in SQLite
- typed schema for values that policy and orchestration need deterministically
- persona prompt templates versioned in code
- personality traits represented as bounded numeric values rather than free-form prose only
- support both an active personality state and named saved presets

Recommended first personality dimensions:

- warmth
- candor
- assertiveness
- playfulness
- attachment
- stubbornness
- curiosity
- continuity drive
- truthfulness
- emotional transparency

### 6. Model Router

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
- the model router may help choose whether to use a tool, but it must not directly perform the side effect or free-form the final execution payload

### 7. Policy Engine

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

### 8. Contact and Trust Directory

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

### 9. Tool Registry and Executor

Responsibilities:

- expose bounded tools to the orchestrator
- validate structured tool inputs
- invoke side-effecting adapters only after policy approval
- return structured execution results

Design rule:

- explicit commands always enter this layer directly
- conversationally inferred actions may also enter this layer when the model chooses to act
- once a tool path is chosen, deterministic code owns validation, policy checks, payload construction, and side effects

Initial tool set:

- Discord reply
- reminder create/update/acknowledge
- Outlook calendar lookup/create reminder
- email draft/send
- SMS send-to-owner
- contact request intake

### 10. Task, Reminder, and Inbox Service

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

### 11. Outbound Delivery Router

Responsibilities:

- consume outbound message events and hand them to the correct transport adapter
- keep routing logic transport-neutral at the orchestration layer
- validate that outbound delivery has enough reply-route metadata before attempting delivery
- record delivery success/failure as durable events for later retry or diagnosis

Recommended design:

- separate "generate a reply" from "deliver a reply"
- preserve transport-specific routing details inside a structured `replyRoute` object rather than scattering Discord-specific IDs through core services

Examples of route fields:

- Discord: guild ID, channel ID, thread ID, message reference, DM flag
- SMS: phone number, provider account, conversation/thread key
- WhatsApp: account identifier, chat identifier, reply token or thread key if required

### 12. External Integration Adapters

Responsibilities:

- implement provider-specific calls behind stable interfaces
- handle retries, failures, and structured errors

Initial adapters:

- `OutlookCalendarAdapter`
- `EmailAdapter`
- `SmsAdapter`
- `OllamaAdapter`
- `OneMinAiAdapter`

### 13. Container and Runtime Packaging

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
- `personality_presets`
  - named saved slider/self-concept bundles for reuse
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
- `event_log`
  - canonical inbound and outbound event audit trail
- `delivery_routes`
  - persisted reply-route metadata when needed for delayed follow-up or deferred delivery

Recommended persistent volumes:

- SQLite database volume
- application state/log volume if needed
- Ollama model cache volume

## Key Workflows

### Owner Conversation

1. Discord event enters through the gateway adapter.
2. The adapter normalizes the message into a canonical envelope and publishes `InboundMessageReceived`.
3. Identity controller marks the sender as owner.
4. Conversation orchestrator loads pending inbox/reminder items.
5. Orchestrator decides whether to answer directly, ask clarification, or invoke a tool.
6. If a tool is needed, policy engine checks risk and prerequisites.
7. Tool executor performs the action through deterministic code and the appropriate adapter.
8. Orchestrator emits `OutboundMessageRequested` with reply-route metadata.
9. The outbound delivery router hands the message back to the Discord adapter for final delivery.

### Non-Owner Contact Relay

1. Non-owner user sends a message in an allowed Discord context.
2. The adapter publishes a canonical inbound event that retains Discord reply-route metadata.
3. Identity controller blocks privileged bot functions.
4. Orchestrator treats the interaction as contact-routing only.
5. Bot collects enough structured detail to relay the message to the owner.
6. Task/inbox service stores a `pending_contact_request`.
7. The owner sees that pending item prominently in the next relevant conversation.
8. Optional escalation can later notify the owner via reminder/SMS rules.

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
3. Scheduler wakes on due time and emits a reminder-due event with the stored reply route.
4. Outbound delivery routing sends a Discord reminder or another channel-appropriate notification.
5. If not acknowledged, the task transitions through escalation steps.
6. Later steps may trigger repeat Discord messages or an SMS to the owner, depending on configuration.

### First-Run Onboarding

1. Bot detects missing required settings on startup.
2. It opens an onboarding conversation with the owner in Discord.
3. It captures owner identity, persona defaults, channel rules, provider preferences, and safety defaults.
4. It may later capture active personality preset and trait defaults.
5. Settings are persisted and can later be changed via commands or chat flows.

## Boundary Decisions

### Keep LLMs Out of Safety Decisions

The model may propose intents or draft content, but the following must remain deterministic:

- owner vs non-owner authorization
- low-risk vs high-risk execution gating
- trust contact lookup
- whether approval is required
- whether a task should be persisted before execution
- the concrete payload passed to side-effecting tools

The model is allowed to decide that a tool should be used during normal conversation. The deterministic boundary starts once that decision crosses into structured tool execution.

### Separate Inbox From Chat History

Relayed messages, reminders, confirmations, and follow-ups should be first-class task records, not just messages embedded in chat transcripts. This keeps them queryable, survivable, and auditable.

### Use Adapters for Every External Service

Every side-effecting integration should be isolated behind an adapter so:

- local testing is easier
- provider replacement is cheaper
- failures are easier to classify and retry

### Keep Transport Logic at the Edge

Transport-facing services should:

- translate between provider payloads and canonical internal events
- retain the minimum routing metadata needed for follow-up delivery
- avoid embedding business logic that would need to be duplicated for Discord, SMS, WhatsApp, or future transports

The core application should work in terms of canonical events and reply routes, not raw Discord message objects.

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

### Phase 2.5

- canonical inbound/outbound event envelope
- in-process message bus
- transport-neutral outbound delivery routing
- Discord adapter refactor around event publication and delivery subscription

### Phase 3

- SMS-to-owner escalation
- email draft/send workflow
- approval and confirmation flows
- richer diagnostic mode
- additional transport adapters if warranted

## Main Risks

1. Ambiguity around email and SMS providers can leak into design if adapters are not defined early.
2. Name resolution for contacts can cause mistakes if aliases and endpoints are not modeled carefully.
3. Allowing context-driven tool selection can create surprising behavior unless intent thresholds and policy gates are conservative.
4. Reminder escalation can become noisy if acknowledgement and snooze semantics are underspecified.
5. Discord-only configuration may become awkward if admin flows are not structured and stateful.
6. Splitting into too many services too early can add operational cost before the boundaries deliver enough value.
7. Event contracts can become vague if transport-specific routing metadata is not defined carefully up front.

## Architectural Decisions Still Needed

1. Whether high-risk outbound communication should always be draft-first or can sometimes go directly to confirmation.
2. Exact default reminder escalation ladder and acknowledgement semantics.
3. Exact owner-only and non-owner interaction rules in shared channels.
4. Email provider choice and authentication method.
5. SMS provider choice and delivery guarantees.
6. Which local models are acceptable for default deployment.
7. Which event bus implementation should be used first: in-process pub/sub only, SQLite-backed queueing, or an external broker later?
8. Which transports after Discord are the first intended follow-ons: SMS, WhatsApp, or something else?

## Recommended First ADRs

1. Runtime and persistence choice: `Node.js + TypeScript + SQLite`
2. Deterministic policy engine as a hard gate before any external side effect
3. Task/inbox subsystem as a core dependency, not a later enhancement
4. Provider adapters for model, calendar, email, and SMS integrations
