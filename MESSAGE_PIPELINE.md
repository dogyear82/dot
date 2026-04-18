# Message Pipeline

## Purpose

The message pipeline is the end-to-end path an inbound message takes through Dot.

A message enters one end of the pipe as an inbound event. A small number of valid outcomes come out the other end:

- ignore the message
- publish a conversational reply
- publish a deterministic command reply
- publish a tool-result reply
- publish a safe error fallback

The pipeline should orchestrate these stages. It should not own the detailed implementation of each stage.

## Intended High-Level Flow

```text
Inbound event
-> Context
-> Addressedness
-> Access and policy
-> Deterministic command routing or conversational intent routing
-> Tool execution or chat generation
-> Rendering
-> Publish
```

## Stages

### 1. Ingest

Receive an inbound message event and normalize the minimum runtime context needed to process it.

Input:
- raw inbound event

Output:
- message processing context

### 2. Addressedness

Determine whether Dot is being addressed.

This should use:
- deterministic fast paths first
- LLM inference only when deterministic rules do not resolve addressedness

Input:
- message processing context

Output:
- addressed or not addressed
- if addressed, a routing-ready conversational intent result

### 3. Access And Policy

Determine what the sender is allowed to do.

This stage decides:
- owner vs non-owner behavior
- privileged deterministic command eligibility
- policy restrictions that must be enforced before execution

Input:
- addressed message context
- actor and access context

Output:
- allowed route set

### 4. Deterministic Command Routing

Handle explicit deterministic commands before conversational inference.

Examples:
- owner-only command handlers
- explicit tool commands
- other hard-routed command paths

Input:
- message content
- access context

Output:
- handled or not handled
- optional reply payload

### 5. Conversational Intent Routing

If the message was not already handled deterministically:

- decide whether Dot should `respond` or `execute_tool`
- if `execute_tool`, produce a structured tool call payload

This stage should not implement tool logic. It should only classify and route.

Input:
- current message
- recent transcript or conversation context

Output:
- conversational reply intent
- or structured tool intent

### 6. Tool Execution

Execute the selected tool deterministically.

The tool may:
- succeed with structured result data
- return a clarification reply when required information is missing
- fail safely

The pipeline should treat tool clarifications as ordinary replies, not as a special intake engine.

Input:
- tool name
- structured args

Output:
- tool result contract

### 7. Rendering

If the tool result needs natural language rendering, render it in Dot's voice.

If not, pass through direct final text.

Input:
- tool result

Output:
- final outbound reply text

### 8. Publish

Publish the outbound message event and persist only the conversation and audit data that should survive processing.

Input:
- final reply payload

Output:
- outbound event

## Boundary Rules

The pipeline should:
- orchestrate stages
- pass data between stages
- stop processing when a terminal outcome is reached

The pipeline should not:
- implement tool-specific business logic
- implement prompt-building details
- own multi-turn intake engines
- mix persistence internals, routing logic, rendering logic, and execution logic in the same stage implementation

## Target Mental Model

The pipeline is a transport and orchestration path, not a dumping ground for all message-related behavior.

The desired mental model is:

```text
one message in
-> one ordered processing path
-> one terminal outcome out
```

That terminal outcome may be:
- no reply
- a direct reply
- a rendered tool reply
- a safe fallback

## Implications For Cleanup

As the codebase is decomposed, `messagePipeline.ts` should move toward:

- stage orchestration only
- minimal branching at the top level
- stage-specific collaborators for:
  - context building
  - addressedness
  - access and policy
  - command routing
  - conversational intent routing
  - tool execution
  - rendering
  - publishing

The file should read as a pipeline coordinator, not as the implementation site for every concern in the system.
