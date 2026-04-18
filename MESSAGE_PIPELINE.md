# Message Pipeline

## Purpose

The message pipeline is the end-to-end path an inbound message takes through Dot.

A message enters one end of the pipe as an inbound event. A small number of valid outcomes come out the other end:

- ignore the message
- publish a conversational reply
- publish a tool-result reply
- publish a safe error fallback

The pipeline should orchestrate these stages. It should not own the detailed implementation of each stage.

## Intended High-Level Flow

```text
Inbound event
-> Context
-> Addressedness
-> Tool execution or chat generation
-> Publish
```

## Stages

### 1. Ingest

Receive an inbound message event and normalize the minimum runtime context needed to process it.

Input:
- raw inbound event

Output:
- message processing context

### 2. Message Routing

Determines which route the message should take, handled in 2 phases; To determine if Dot is being addressed and if so, should Dot respond with conversation or execute a tool? The first kind of routing is simple. If a user enters an explicit command, such as "!calendar show" then the message is routed to whatever tool the command is meant to invoke.

If the message is not an explicit command, then we first need to determine if Dot is being addressed before taking action against the incoming message. If Dot is not being addressed, then the message stops in it's tracks. No further processing is needed. The first check is purely deterministic, and involves check if a user issued an explicit command, such as:

```

!calendar show

```
Any message that begins with an explicit command will be routed down the tool execution path.

Failing the tool check, the message, along with a transcript of the chat, is sent to an LLM to determine addressedness, and if addressed, to respond with conversation or execute a tool. It is at this stage that the message wills top if it is determined that addressedness is false. The LLM should follow the following rules to determine if a conversational reply, or a tool execution, is the right path for the message.

The message should receive a conversational reply if:

- The user did not request a tool use, nor is data from a tool necessary to answer the user's query.
- The message is just chitchat.
- The user requested a tool, or a data from a tool is necessary to answer the user's query, but Dot does not have the necessary data to execute the tool. In this instance the LLM should choose to respond with conversation to ilicit the data required to execute the tool and answer the question.

The message should receive a tool execution reply if BOTH of the following are true:

- The user asked for a tool, or provided followup information to a previous tool request, or if data from a tool is necessary to answer the users query.
- The LLM is able to extract the necessary data, from the recent chat transcript, including the most recent message, to invoke the necessary tool.


### 3. Conversation Response Path

Messages routed down the conversation response path will come with instructions on how to respond. Such logic is handled in a response service. The message pipeline merely hands off the chat transcript to the response service and awaits it's response.


### 4. Tool Execution Path

Messages routed down the tool execution path will also call the response service, except this time to respond with tool execution. When forming the tool execution response, the LLM will also provide the tool name and any arguments or parameters the tool needs to successfully run. The tool execution logic is handled inside of the tool. The message pipeline merely hands the tool execution payload to the response service and awaits it's response.


### 5. Publish

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


## Implications For Cleanup

As the codebase is decomposed, `messagePipeline.ts` should move toward:

- stage orchestration only
- minimal branching at the top level
- stage-specific collaborators for:
  - context building
  - addressedness
  - conversational intent routing
  - tool execution
  - publishing

The file should read as a pipeline coordinator, not as the implementation site for every concern in the system.
