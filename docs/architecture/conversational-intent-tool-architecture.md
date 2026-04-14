# Conversational Intent And Tool Architecture

## Purpose
This document defines the target architecture for Dot's non-command conversational routing.

The goal is to let the LLM interpret natural language while keeping execution deterministic, safe, and modular.

## Core Rule
Only explicit `!commands` should use deterministic intent routing.

Everything else should follow this shape:
1. LLM classifies the conversational message
2. structured output is validated deterministically
3. a tool is executed deterministically, or Dot responds directly

Deterministic code should remain responsible for:
- execution safety
- source restrictions
- output contracts
- persistence
- orchestration
- explicit command handling

Deterministic code should not decide conversational intent for normal speech.

## Intent Contract
The conversational classifier should emit strict JSON with only two top-level outcomes:
- `respond`
- `execute_tool`

Example:

```json
{"decision":"respond","response":"Well, deary, I don't know that yet."}
```

```json
{"decision":"execute_tool","toolName":"world.lookup","args":{"query":"what's happening in Ukraine right now?"}}
```

Parse failure must not be treated as a valid response. Invalid output should fail safely.

## Tool Interface
All tools should implement the same input/output shape.

Example target contract:

```ts
interface ToolCall {
  toolName: string;
  args: Record<string, unknown>;
  context: ToolContext;
}

interface ToolResult {
  status: "success" | "clarify" | "blocked" | "requires_confirmation" | "failed";
  presentation: "final_text" | "llm_render";
  payload: unknown;
  renderInstructions?: ToolRenderInstructions;
  metadata?: Record<string, unknown>;
}
```

The executor should not care what concrete tool is being called beyond the shared contract.

## Rendering
Tools own their results, but not always the final user-facing wording.

Two presentation modes are required:
- `final_text`
- `llm_render`

`final_text` is for deterministic user-facing replies like reminder acknowledgements.

`llm_render` is for structured outputs that should be turned into natural language, such as weather data or grounded article evidence.

For `llm_render`, tools should provide render instructions:

```ts
interface ToolRenderInstructions {
  systemPrompt: string;
  constraints?: string[];
  styleHints?: string[];
}
```

The renderer should use:
- the active personality profile
- the tool payload
- the tool-specific render instructions

The renderer should not guess how to present a tool result.

## Clarification
Clarification should be a tool outcome, not a top-level conversational intent.

That keeps the classifier narrow:
- respond
- execute a tool

If a tool needs more information, it returns `status: "clarify"`.

## Design Consequences
- no deterministic conversational phrase matching for normal speech
- explicit commands remain deterministic
- tool choice comes from structured LLM classification
- execution remains deterministic
- tool outputs become more reusable and testable
- rendering remains composable and tool-directed

## Migration Direction
The near-term first slice is the news/current-events path:
- `news.briefing`
- `world.lookup`
- `news.follow_up`
- repair/correction of prior lookup answers

If that slice works well, the same contract can expand to other conversational tools without changing the execution model.
