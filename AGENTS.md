# Repository Guidelines

## Project Structure & Module Organization
Core application code lives in [`src/`](/home/tan/repos/dot/src). Key areas:
- `src/discord/`: Discord ingress, normalization, and outbound delivery
- `src/chat/`: model routing, providers, and persona behavior
- `src/runtime/`: service-host bootstrap and lifecycle coordination
- `src/outlook*.ts`, `src/mail*.ts`, `src/reminders.ts`: Outlook, mail, and reminder workflows
- `src/persistence.ts`, `src/types.ts`, `src/events.ts`: storage, shared types, and canonical event contracts

Tests live in [`tests/`](/home/tan/repos/dot/tests) with one `*.test.ts` file per subsystem. Operational assets live in [`ops/`](/home/tan/repos/dot/ops), architecture docs in [`docs/`](/home/tan/repos/dot/docs), and container wiring in [`compose.yaml`](/home/tan/repos/dot/compose.yaml).

## Build, Test, and Development Commands
- `npm run dev`: run the app with `tsx watch` for local development
- `npm run build`: compile TypeScript into [`dist/`](/home/tan/repos/dot/dist)
- `npm test`: run the full Node test suite
- `node --import tsx --test tests/messagePipeline.test.ts`: run a focused test file
- `podman-compose up -d --build`: start the full local stack, including observability services

Use focused tests while iterating, then run `npm test` and `npm run build` before opening a PR.

## Coding Style & Naming Conventions
This repo uses TypeScript with ES modules and 2-space indentation. Prefer small, single-purpose modules and deterministic code paths for privileged actions. File names use lower camel or domain names (`messagePipeline.ts`, `outlookMail.ts`); tests mirror the module name (`messagePipeline.test.ts`).

Use descriptive event names and keep shared contracts in `src/types.ts` and `src/events.ts`. There is no separate lint script today, so rely on TypeScript, existing patterns, and targeted tests.

## Testing Guidelines
Tests use Node’s built-in test runner with `tsx`. Add or update tests for every behavior change, especially around:
- command routing
- persistence/state transitions
- Outlook and Discord boundary adapters
- deterministic policy decisions

Name files `*.test.ts` and keep fixtures local to the test file unless broadly reused.

## Change Review Discipline
For behavior changes, do not patch only the immediate defect site. Trace the full path from input formation through parsing, orchestration, execution, and final output or side effects before deciding on a fix.

After the first implementation pass, perform an explicit upstream and downstream impact review:
- verify how the changed value was formed upstream
- verify how it is consumed downstream
- identify adjacent branches or contracts the change can affect

Remediate material findings from that review, then repeat the implement-review-remediate loop until no material issues remain.

## Required workflow before testing
- Verify correct git branch
- Restart docker containers
- Confirm services are running
- Always verify that rebuilt or restarted images are actually running the intended code before declaring the environment ready. Do not assume a restart picked up the latest changes; confirm the live container matches the expected branch/commit or contains the expected code path.

Do not say "ready for testing" unless all steps are complete.

## Commit & Pull Request Guidelines
Commits follow the story-first pattern seen in history, for example:
- `DOT-12 formalize structured tool invocation`
- `DOT-44 chunk oversized Discord replies`

Use `<JIRAKEY> <imperative summary>`. PRs should include:
- a short summary of behavior or architectural change
- linked story/issue
- validation commands run
- screenshots only when UI or dashboard behavior changes

## Security & Configuration Tips
Configuration is environment-driven through [`src/config.ts`](/home/tan/repos/dot/src/config.ts). Keep secrets in `.env`, never in source control. For Outlook and other external integrations, prefer explicit scopes and deterministic approval flows over inferred side effects.
