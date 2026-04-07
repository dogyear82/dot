# Discord AI Companion MVP Stories

These stories are drafted in dependency order and are intended to be tracker-ready. They are written as independently reviewable vertical slices where possible.

## Story 1: Bootstrap the Discord Bot Service

### Goal

Stand up a runnable Discord bot service with a deployable application skeleton, configuration loading, structured logging, and a basic message event pipeline that can be extended safely.

### Scope Boundaries

In scope:

- application entrypoint
- Discord connection and message intake
- environment/config bootstrap
- structured logging and error handling baseline
- local persistence bootstrap
- containerization baseline for local self-hosting
- Compose-based startup path for Linux

Out of scope:

- full AI behavior
- provider integrations
- owner/non-owner policy beyond placeholders

### Acceptance Criteria

1. The service can start locally and connect to Discord using configured credentials.
2. Incoming DMs and channel messages are normalized into an internal message shape.
3. The service logs startup, shutdown, and message-processing failures in a structured way.
4. Local persistence is initialized automatically for development.
5. The project contains a documented run path for local development.
6. The backend can be started through a Docker Compose workflow on Linux.
7. The local model runtime contract is defined around Ollama so later AI stories do not need to re-decide the integration boundary.

### Dependencies

- None

### Risks / Open Questions

- Runtime and library choices should be finalized before implementation starts.

## Story 2: Implement Owner Identity and Access Boundaries

### Goal

Ensure only the owner can use privileged AI and tool capabilities while non-owner users are restricted to owner-contact workflows.

### Scope Boundaries

In scope:

- deterministic owner identification
- non-owner classification
- authorization gate for privileged actions
- rejection or rerouting of non-owner privileged requests

Out of scope:

- full contact relay experience
- trust classification for outbound communication

### Acceptance Criteria

1. The bot identifies the owner using deterministic configuration rather than LLM inference.
2. Owner messages can proceed to privileged bot workflows.
3. Non-owner users cannot trigger privileged commands, settings changes, or tool execution.
4. Non-owner interactions are routed to a limited contact/interaction flow rather than treated as full bot access.
5. Authorization decisions are testable without model calls.

### Dependencies

- Story 1

### Risks / Open Questions

- The owner identity source should be finalized early to avoid permission drift.

## Story 3: Add Persistent Settings and First-Run Onboarding

### Goal

Give the bot a durable settings model and an initial onboarding conversation that captures required owner configuration values through Discord.

### Scope Boundaries

In scope:

- settings persistence
- first-run detection
- onboarding prompts in Discord
- editable configuration for persona defaults, channel rules, and provider preferences

Out of scope:

- advanced policy editing
- full UX for every future configuration key

### Acceptance Criteria

1. The bot detects when required settings are missing and initiates onboarding with the owner.
2. Onboarding captures and persists the minimum required settings for the bot to function.
3. The owner can review and update stored settings through Discord commands or chat-driven configuration.
4. Channel participation and persona defaults are stored as data, not hard-coded behavior.
5. Settings survive service restarts.

### Dependencies

- Story 1
- Story 2

### Risks / Open Questions

- Discord-native configuration UX can become brittle if multi-step state handling is not designed cleanly.

## Story 4: Deliver Basic Owner Chat With Configurable Persona and Model Routing

### Goal

Enable owner chat in Discord with configurable persona behavior and routing between a preferred local model and a hosted fallback.

### Scope Boundaries

In scope:

- owner chat response generation
- persona profile selection
- sheltered and diagnostic modes
- model adapter abstraction
- local-first model routing with hosted fallback support

Out of scope:

- tool execution
- risk-gated side effects

### Acceptance Criteria

1. The owner can chat with the bot in Discord and receive responses from a configured model backend.
2. The bot supports at least sheltered and diagnostic persona modes.
3. Persona and companion-vs-assistant weighting are configurable settings.
4. The system can prefer a local model and fall back to a hosted provider when configured.
5. Provider failures are surfaced cleanly without crashing the bot.

### Dependencies

- Story 1
- Story 2
- Story 3

### Risks / Open Questions

- Acceptable local model quality for the default deployment remains an open decision.

## Story 5: Build the Internal Inbox and Non-Owner Contact Relay Flow

### Goal

Allow non-owner Discord users to leave messages for the owner while keeping all other bot capabilities owner-only.

### Scope Boundaries

In scope:

- intake flow for non-owner contact requests
- persistent inbox/task records for relayed messages
- owner-facing surfacing of pending contact items
- basic acknowledgement/handled state

Out of scope:

- urgent escalation policy
- SMS/email relay

### Acceptance Criteria

1. A non-owner user can leave a message for the owner through an allowed Discord interaction.
2. The message is persisted as a durable inbox/task item rather than left only in transient chat state.
3. The owner is shown pending contact items prominently in the next relevant conversation.
4. Non-owner users remain unable to access privileged bot capabilities.
5. The owner can mark a relayed contact item as handled.

### Dependencies

- Story 2
- Story 3
- Story 4

### Risks / Open Questions

- Allowed non-owner interaction patterns beyond basic message relay are still open.

## Story 6: Add the Deterministic Policy Engine and Trusted Contact Directory

### Goal

Implement the deterministic safety layer that classifies action risk, resolves contacts, and gates outbound communication based on stored trust data.

### Scope Boundaries

In scope:

- contact records and aliases
- trust classification persistence
- deterministic low-risk vs high-risk policy checks
- clarification flow when a contact or trust status is unknown

Out of scope:

- actual email sending
- actual SMS sending

### Acceptance Criteria

1. Contacts can be stored with canonical identity, aliases, and communication endpoints.
2. Trust classification is persisted separately from chat history and usable by code.
3. When the owner references an unknown contact for a gated action, the bot asks for classification and stores the answer.
4. Risk decisions are made by deterministic code, not by free-form model output.
5. The policy engine exposes a testable interface that tool workflows can call before any external side effect.

### Dependencies

- Story 3
- Story 4
- Story 5

### Risks / Open Questions

- The exact trust schema and contact-resolution strategy should be finalized before message-sending stories.

## Story 7: Implement the Reminder and Task Scheduling Engine

### Goal

Create durable reminders with acknowledgement and configurable nagging behavior so reminders and follow-ups survive restarts.

### Scope Boundaries

In scope:

- reminder creation and storage
- scheduler execution
- acknowledgement and completion
- repeat follow-ups / nagging states

Out of scope:

- Outlook sync
- SMS escalation

### Acceptance Criteria

1. The owner can create a reminder through Discord.
2. Reminders are persisted and survive service restarts.
3. The bot sends reminder notifications at the scheduled time.
4. Unacknowledged reminders can trigger follow-up notifications according to stored settings.
5. Reminder state transitions are auditable and testable.

### Dependencies

- Story 3
- Story 4

### Risks / Open Questions

- Default escalation cadence still needs a product decision.

## Story 8: Integrate Outlook Calendar With Reminder Workflows

### Goal

Connect Outlook calendar data so calendar-backed reminders and related reminder flows work through the bot.

### Scope Boundaries

In scope:

- Outlook authentication and adapter
- calendar event lookup
- reminder creation from Outlook context
- synchronization needed for reminder workflows

Out of scope:

- full calendar management suite unless needed for reminders

### Acceptance Criteria

1. The bot can access the owner’s Outlook calendar through a configured integration.
2. Calendar-backed reminders can be created or derived from Outlook events.
3. Failures in the Outlook adapter are surfaced without corrupting reminder state.
4. Calendar-related data access respects the same owner-only access controls as the rest of the bot.

### Dependencies

- Story 7

### Risks / Open Questions

- Microsoft authentication flow details need to be chosen for local deployment.

## Story 9: Add SMS Escalation to the Owner

### Goal

Allow the bot to send SMS messages only to the owner, primarily for reminder escalation and owner notification.

### Scope Boundaries

In scope:

- SMS adapter for owner-only delivery
- reminder escalation path to SMS
- delivery result handling

Out of scope:

- group SMS
- general-purpose SMS to arbitrary contacts

### Acceptance Criteria

1. The system can send an SMS to the owner through a configured provider.
2. Reminder escalation can be configured to use SMS after Discord notifications are ignored.
3. SMS delivery attempts and failures are recorded durably.
4. The system cannot use this SMS path to message non-owner recipients in v1.

### Dependencies

- Story 6
- Story 7

### Risks / Open Questions

- SMS provider choice is unresolved and may change implementation effort materially.

## Story 10: Add Email Drafting, Approval, and Send Workflows

### Goal

Support email drafting and controlled send behavior on the owner’s behalf with deterministic approval rules.

### Scope Boundaries

In scope:

- email drafting
- high-risk approval flow
- send execution through an email adapter
- durable pending confirmation records

Out of scope:

- broad messaging channels beyond email
- autonomous email sending without policy checks

### Acceptance Criteria

1. The owner can ask the bot to draft an email through Discord.
2. The policy engine is consulted before any email send attempt.
3. Unknown contact trust status blocks send and triggers a classification prompt.
4. High-risk email requires explicit owner approval before sending.
5. Sent, blocked, and pending email actions are recorded durably.

### Dependencies

- Story 6

### Risks / Open Questions

- The product decision between draft-first and confirm-before-send needs to be finalized.

## Story 11: Expose Tool Invocation and Clarification Rules for Owner Workflows

### Goal

Provide a general owner-only tool invocation pattern so the bot can shift from chat into structured action execution safely.

### Scope Boundaries

In scope:

- structured tool registry
- owner-only invocation path
- clarification prompts for missing arguments
- execution result formatting

Out of scope:

- adding every future tool

### Acceptance Criteria

1. The bot can invoke registered tools through a structured execution path instead of ad hoc command logic.
2. Missing or ambiguous inputs trigger clarification prompts rather than guessed execution.
3. Tool execution results are returned to the owner in a consistent format.
4. Tool execution can be denied or deferred by the policy engine when required.

### Dependencies

- Story 4
- Story 6

### Risks / Open Questions

- Automatic tool invocation thresholds should remain conservative at first release.
