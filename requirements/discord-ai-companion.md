# Discord AI Companion Requirements

## Problem Statement

The user wants a personal AI companion that lives inside Discord instead of requiring a custom UI. The companion should support natural conversation, light banter, and useful assistant behaviors such as reminders and messaging-related tasks. It should also be able to invoke bounded skills or tools, similar in spirit to coding assistants that can call tools, but this product is not primarily a coding bot.

The product must reduce accidental outbound communication risk as close to zero as practical. High-impact actions such as messaging or emailing non-trusted contacts must not rely on LLM judgment alone. Risk gating must be enforced by deterministic application logic with persistent user-managed trust data.

The user strongly prefers local model execution when possible. The local model runtime should use Ollama. The user also has access to 1minAI and is open to using that as a hosted model option when local quality or availability is insufficient.

## User Personas

### Primary Persona

- Single primary user: the repository owner / operator
- Uses Discord as the main interaction surface
- Wants a companion that is both useful and fun to talk to
- Prefers configurable behavior rather than hard-coded personality or policies

### Secondary Persona

- Other Discord users in shared channels who may need to reach the primary user through the bot
- These users are not operators or administrators of the bot
- Their allowed interaction scope is limited to contacting or interacting with the primary user through the bot

## Core Use Cases

1. The user chats with the bot in Discord DMs or approved Discord channels for casual conversation, questions, and banter.
2. The bot participates in Discord servers and/or text channels according to configurable behavior rules rather than hard-coded reply rules.
3. The user instructs the bot to perform bounded actions such as drafting an email, sending an email, sending the user an SMS, or creating reminders.
4. The bot decides a skill may be useful during conversation and either executes it or asks for clarification based on the configured autonomy and risk rules.
5. The bot creates Outlook-backed calendar reminders and escalates follow-up reminders if the user does not acknowledge them in time.
6. The bot asks the user to classify a person as trusted or untrusted when that classification is needed for deterministic risk gating and stores that classification for later reuse.
7. The user updates behavior, tone, trust classifications, and other settings through Discord commands and/or chat-driven configuration flows.
8. On first startup, the bot walks the user through initial configuration of key settings instead of requiring manual file editing.
9. Another Discord user leaves a message for the primary user through the bot when the primary user is unavailable.
10. The bot stores that contact request as an internal task or pending delivery item and surfaces it prominently to the primary user during the next relevant interaction.
11. The bot helps mediate contact between other users and the primary user without granting those other users access to privileged bot capabilities.

## Functional Requirements

1. The system must use Discord as the primary user interface for conversation and command execution.
2. The system must support conversational interaction in direct messages and configurable Discord server/text-channel contexts.
3. Channel participation behavior must be configurable rather than hard-coded.
4. The system must support at least two configurable interaction modes:
- A default naive / sheltered companion mode
- A colder, more detached diagnostic mode for self-debugging or technical introspection
5. The balance between companion behavior and practical assistant behavior must be configurable.
6. The system must support both explicit command-driven skill invocation and context-driven skill use when the bot believes a skill is necessary.
7. When the owner explicitly invokes a command or tool path, the system must execute that structured path rather than answering in free-form chat.
8. When the owner speaks conversationally, the model may decide that a structured tool is the right next step, but the eventual side effect must still run through deterministic application code.
9. If the user intent or execution target is unclear, the system must ask clarifying questions before taking action.
10. The system must support a deterministic risk-classification layer outside the LLM.
11. The deterministic layer must classify actions into at least low-risk and high-risk categories.
12. Low-risk actions must be eligible for automatic execution.
13. High-risk actions must require user confirmation before execution.
14. Low-risk actions for v1 include:
- Reminders
- Drafting content
- Summarization
- Replies inside Discord
- Banter / conversational responses
15. High-risk actions for v1 include outbound messages or emails to anyone who is not already classified as family or close friend.
16. The system must maintain persistent trust/contact metadata that can be used by deterministic policy code.
17. If the bot is asked to message or email a person whose trust classification is unknown, the system must ask the user to classify that person before proceeding.
18. The answer to a trust-classification prompt must be stored persistently for later policy decisions.
19. The stored classification must be reusable by whichever subsystem actually sends email or SMS so risk enforcement does not depend on LLM memory.
20. The system must support email actions on the user’s behalf.
21. The system must support SMS actions directed only to the user in v1.
22. The system must not support group SMS participation in v1.
23. The system must support Outlook as the calendar source for reminders.
24. The system must support reminder escalation when reminders are ignored.
25. Reminder escalation behavior must be configurable.
26. The bot must be able to nag or follow up multiple times if the user does not respond to a reminder, subject to configurable escalation rules.
27. The system must provide a first-run onboarding flow that asks the user for initial configurable values.
28. The user must be able to update settings later through Discord commands and/or conversational configuration.
29. The system should support a model-routing strategy that prefers local models and can use 1minAI as a hosted option when configured.
30. The system should support fallback between model providers without changing the Discord interaction model.
31. The system must distinguish between the primary user and non-owner Discord users.
32. Only the primary user may access general bot commands, AI tasking, configuration, and privileged tool execution.
33. Non-owner Discord users must be restricted to interactions that help them contact, leave a message for, or otherwise interact with the primary user.
34. The system must not execute arbitrary commands or privileged actions on behalf of non-owner users.
35. The system must support intake of contact requests or messages from non-owner Discord users for delivery to the primary user.
36. The system must persist those requests as internal tasks, notifications, inbox items, or an equivalent durable work queue.
37. The system must surface pending third-party contact items prominently when the primary user next interacts with the bot.
38. The system should prioritize newly received third-party contact items early in the next conversation with the primary user.
39. The system should support internal task/state tracking for reminders, pending deliveries, follow-ups, and other deferred bot obligations.
40. The system must support a containerized backend deployment model suitable for local self-hosting.
41. The local model backend must support Ollama running in a containerized deployment.
42. The repository should support starting the backend stack through a Podman Compose workflow on Linux.
43. The system should be operable by cloning the repository onto another Linux machine and starting the stack with minimal manual setup beyond secrets/configuration.

## Non-Functional Requirements

1. Safety for outbound communications is a primary requirement.
2. Deterministic policy enforcement must be used for message/email approval decisions rather than relying solely on LLM reasoning.
3. The product should minimize the chance of accidental outbound messages as close to zero as practical.
4. Configuration should be easy to adjust without code changes.
5. The system should preserve conversation quality for casual chat and companion-like interaction.
6. The architecture should allow adding new skills/tools over time without rewriting the core Discord chat loop.
7. The architecture should allow multiple model backends, including local models and hosted providers.
8. The system should persist user-specific state such as settings, trust/contact classifications, and reminder-related preferences.
9. The system should remain operable for a single-user deployment without requiring a heavy admin interface.
10. The system should separate LLM behavior from deterministic execution policy so safety logic is inspectable and testable.
11. Model-driven tool selection and deterministic tool execution should be separated so the assistant can act conversationally without free-form side effects.
12. Deferred work items such as reminders and contact requests must survive restarts and not rely on transient model context.
13. Backend services should be containerized so they can be started and stopped predictably.
14. Deployment should prioritize portability across Linux machines owned by the user.
15. Local development and self-hosting should be achievable through a documented Podman Compose workflow.

## Constraints

1. First release is for a single user only.
2. Discord is the only required primary interface for v1.
3. No separate custom interface is desired for v1.
4. The solution should strongly prefer local models when practical.
5. 1minAI is available and acceptable as a hosted model option.
6. The product is intended to be fun and companion-like, not purely utilitarian.
7. SMS scope for v1 is limited to sending messages to the user, not participating in group SMS threads.
8. Calendar integration for v1 must use Outlook.
9. Configuration should be managed through Discord interactions rather than manual source edits as the primary UX.
10. Privileged bot use is reserved for the primary user only, even when the bot is present in shared Discord channels.
11. Backend services should be designed to run in containers by default.
12. The user wants to be able to clone the repository onto another Linux machine and bring the backend up via Podman Compose.

## Open Questions

1. What exact Discord channel participation policies should be available in v1, such as mention-only, whitelist-based participation, or free participation within approved channels?
2. Which owner-facing actions should be eligible for model-inferred tool use in v1, and which should remain explicit-command-only until later?
3. For high-risk outbound communication, is the preferred workflow:
- Block and ask for confirmation before sending
- Save as draft first, then require confirmation
- Offer both depending on channel or recipient type
4. What exact data model should be used for trusted contacts, such as person name only, aliases, email addresses, phone numbers, Discord handles, or grouped identities?
5. How should the user review and edit previously stored trust/contact classifications?
6. What reminder escalation schedule should exist by default, including delay intervals, maximum number of follow-ups, and channel order?
7. Which channels should reminder escalation use in v1, such as Discord only, Discord then SMS, or both concurrently?
8. What provider and integration path should be used for sending SMS to the user?
9. What provider and integration path should be used for sending email on the user’s behalf?
10. What Ollama-served local model(s) are acceptable for the default deployment profile, and what quality threshold is acceptable before falling back to 1minAI?
11. Should persona switching happen automatically based on topic, manually via command, or both?
12. What audit trail or activity log is required for sent messages, drafted content, policy decisions, and reminder escalations?
13. How should the bot authenticate or identify the primary user authoritatively inside Discord: Discord user ID only, configurable allowlist, or another method?
14. What exact capabilities should non-owner users have beyond leaving a message, such as asking whether the primary user is available, requesting a callback, or sending structured urgent notices?
15. How should urgent third-party contact requests be escalated if the primary user does not respond in Discord?
16. Should the Discord bot process itself also run in Podman by default, or is it acceptable to keep only supporting backend services containerized if Discord runtime constraints appear?
