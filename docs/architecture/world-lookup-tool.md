# World Lookup Tool

## Purpose
`world.lookup` is Dot's external-awareness tool. It gives Dot a single grounded lookup capability without exposing raw provider-specific behavior to the chat pipeline.

The goal is not "general browsing." The goal is:
- answer freshness-sensitive or externally grounded questions
- preserve Dot's normal voice and personality
- cite sources clearly
- avoid copying large source passages

## Top-Level Shape
`world.lookup` should be a single tool surface with deterministic orchestration behind it.

Flow:
1. classify the user question
2. choose relevant public sources
3. fetch selected sources in parallel
4. normalize evidence into a shared shape
5. synthesize a grounded answer in Dot's normal voice

The LLM may decide that `world.lookup` is needed, but it should not directly choose arbitrary API calls.

## Module Boundaries
The internal shape should stay explicit:
- `src/worldLookup.ts`: top-level orchestration entrypoint
- `src/worldLookup/classifier.ts`: deterministic question classification
- `src/worldLookup/sources/`: adapter modules and normalization helpers
- `src/toolInvocation.ts`: inferred/explicit tool registration and deterministic execution
- `src/chat/modelRouter.ts`: final grounded answer synthesis in Dot's normal voice

`world.lookup` should remain one user-facing capability even as source coverage grows.

## Repository Integration Points
The first implementation should fit the seams that already exist:
- [`src/toolInvocation.ts`](/home/tan/repos/dot/src/toolInvocation.ts): introduce `world.lookup` as an inferred tool decision and deterministic execution path
- [`src/chat/modelRouter.ts`](/home/tan/repos/dot/src/chat/modelRouter.ts): reuse the existing LLM route for grounded answer synthesis after evidence is gathered
- [`src/messagePipeline.ts`](/home/tan/repos/dot/src/messagePipeline.ts): preserve current audit and pipeline behavior while recording source usage and lookup outcomes

The LLM should decide whether external grounding is needed. It should not choose providers or raw HTTP calls.

## Source Strategy
Start with free/publicly available sources:
- Wikipedia / Wikimedia for reference grounding
- Wikimedia Current Events / Wikinews for notable recent events
- GDELT for broad news and event discovery
- Open-Meteo for weather
- World Bank APIs for macro and development data
- later: curated RSS adapters for trusted agencies or publishers

## Query Routing
Question types should be classified deterministically into buckets like:
- reference / background
- current events / news
- weather
- economics / world data
- mixed / ambiguous

Each bucket maps to a source plan. Only selected sources should be queried, and those calls should run in parallel with per-source timeouts.

Recommended initial mapping:
- `reference`: Wikipedia / Wikimedia
- `current_events`: Wikimedia Current Events or Wikinews plus GDELT
- `weather`: Open-Meteo
- `economics`: World Bank plus optional recent-context support later
- `mixed`: deterministic primary source plus one supporting source, then synthesize

Do not call every source for every question.

## Source Adapter Layer
Each source should live behind its own adapter module with a shared interface. For example:
- `src/worldLookup/wikipediaAdapter.ts`
- `src/worldLookup/currentEventsAdapter.ts`
- `src/worldLookup/gdeltAdapter.ts`
- `src/worldLookup/openMeteoAdapter.ts`
- `src/worldLookup/worldBankAdapter.ts`

Adapters should be deterministic, timeout-bounded, and independently testable.

## Evidence Contract
Each adapter should return normalized evidence:
- `source`
- `title`
- `url`
- `snippet` or `facts`
- `publishedAt`
- `confidence`

Structured sources may return a compact `facts` list instead of prose snippets, but the normalized evidence must stay small enough for synthesis without prompt bloat.

## Execution Rules
- classify first, fetch second
- query only the sources chosen for that bucket
- run chosen source calls in parallel
- apply per-source timeouts
- tolerate partial failure when at least one useful source succeeds
- treat unsupported “browse the whole web” requests as out of scope

## Answer Synthesis Contract
`world.lookup` should not dump raw source text back to the user.

The synthesis step should:
1. consume the normalized evidence bundle
2. answer only the question that was asked
3. preserve Dot's active personality profile
4. cite naturally in prose
5. append 1-3 relevant links at the bottom
6. avoid long quotations or paragraph regurgitation
7. say when evidence is partial, conflicting, or unavailable

## Answering Rules
Search-backed answers must:
- answer only the question asked
- summarize in Dot's own words
- cite naturally in prose, for example `According to Wikipedia...`
- include 1-3 links at the bottom
- avoid long quotations or paragraph regurgitation

The final answer should be synthesized from normalized evidence, not from raw source passages. The answer should preserve the active personality profile.

## Failure Behavior
If lookup fails or returns insufficient grounding:
- Dot should say she could not verify it right now
- she should not invent unsupported facts
- observability should still record the attempted sources and outcomes

## Observability
`world.lookup` should emit:
- classification bucket
- selected sources
- per-source latency
- per-source success or timeout
- final cited sources

These should align with the existing audit and telemetry patterns already used for tool invocation.

## Boundaries
- classification and source selection: deterministic code
- source fetching: adapter layer
- final answer synthesis: LLM using normalized evidence
- audits, latency, failures, and chosen sources: observability and tool execution records
