import test from "node:test";
import assert from "node:assert/strict";

import { evaluateDeterministicAddressednessFastPath } from "../src/discord/addressing.js";
import type { IncomingMessage } from "../src/types.js";

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: "msg-1",
    channelId: "chan-1",
    guildId: "guild-1",
    authorId: "owner-1",
    authorUsername: "owner",
    content: "hello",
    isDirectMessage: false,
    mentionedBot: false,
    repliedToMessageId: null,
    repliedToBot: false,
    createdAt: "2026-04-09T00:00:00.000Z",
    ...overrides
  };
}

test("deterministic addressedness fast path is true for direct messages and explicit mentions", () => {
  assert.deepEqual(
    evaluateDeterministicAddressednessFastPath({
      message: message({ isDirectMessage: true }),
      isExplicitCommand: false,
      hasPendingToolSession: false
    }),
    { addressed: true, reason: "direct_message" }
  );

  assert.deepEqual(
    evaluateDeterministicAddressednessFastPath({
      message: message({ mentionedBot: true }),
      isExplicitCommand: false,
      hasPendingToolSession: false
    }),
    { addressed: true, reason: "explicit_mention" }
  );
});

test("deterministic addressedness fast path is true for replies to Dot", () => {
  assert.deepEqual(
    evaluateDeterministicAddressednessFastPath({
      message: message({ repliedToMessageId: "bot-msg-1", repliedToBot: true }),
      isExplicitCommand: false,
      hasPendingToolSession: false
    }),
    { addressed: true, reason: "reply_to_dot" }
  );
});

test("deterministic addressedness fast path is true for valid explicit commands", () => {
  assert.deepEqual(
    evaluateDeterministicAddressednessFastPath({
      message: message({ content: "!settings show" }),
      isExplicitCommand: true,
      hasPendingToolSession: false
    }),
    { addressed: true, reason: "explicit_command" }
  );
});

test("deterministic addressedness fast path is true when a pending tool session exists", () => {
  assert.deepEqual(
    evaluateDeterministicAddressednessFastPath({
      message: message({ content: "yes" }),
      isExplicitCommand: false,
      hasPendingToolSession: true
    }),
    { addressed: true, reason: "active_pending_tool_session" }
  );
});

test("plain text direct address now falls through to LLM inference", () => {
  assert.equal(
    evaluateDeterministicAddressednessFastPath({
      message: message({ content: "dot, what about tomorrow?" }),
      isExplicitCommand: false,
      hasPendingToolSession: false
    }),
    null
  );
});

test("non-fast-path shared-channel chatter falls through to LLM inference", () => {
  assert.equal(
    evaluateDeterministicAddressednessFastPath({
      message: message({ content: "can somebody send me that link" }),
      isExplicitCommand: false,
      hasPendingToolSession: false
    }),
    null
  );
});
