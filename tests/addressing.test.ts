import test from "node:test";
import assert from "node:assert/strict";

import { shouldTreatOwnerMessageAsAddressed } from "../src/discord/addressing.js";
import type { ConversationTurnRecord, IncomingMessage } from "../src/types.js";

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
    createdAt: "2026-04-09T00:00:00.000Z",
    ...overrides
  };
}

function turn(overrides: Partial<ConversationTurnRecord> = {}): ConversationTurnRecord {
  return {
    id: 1,
    conversationId: "chan-1",
    role: "assistant",
    content: "hello",
    sourceMessageId: "source-1",
    createdAt: "2026-04-09T00:00:00.000Z",
    ...overrides
  };
}

test("addressedness is true for direct messages and explicit mentions", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ isDirectMessage: true }),
      defaultChannelPolicy: "mention-only",
      recentConversation: [],
      recentMessages: []
    }),
    true
  );

  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ mentionedBot: true }),
      defaultChannelPolicy: "mention-only",
      recentConversation: [],
      recentMessages: []
    }),
    true
  );
});

test("addressedness stays false in shared channels when policy is dm-only", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ content: "dot what about tomorrow?" }),
      defaultChannelPolicy: "dm-only",
      recentConversation: [],
      recentMessages: []
    }),
    false
  );
});

test("addressedness is true for plain-text direct address", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ content: "Dot, what about tomorrow?" }),
      defaultChannelPolicy: "mention-only",
      recentConversation: [],
      recentMessages: []
    }),
    true
  );
});

test("addressedness is true when recent assistant conversation is still active", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ createdAt: "2026-04-09T00:04:00.000Z", content: "and what about tomorrow?" }),
      defaultChannelPolicy: "mention-only",
      recentConversation: [turn({ createdAt: "2026-04-09T00:03:00.000Z", content: "You have a meeting today." })],
      recentMessages: [message({ id: "msg-previous", createdAt: "2026-04-09T00:02:30.000Z", content: "@Dot hello", mentionedBot: true })]
    }),
    true
  );
});

test("addressedness stays false when recent assistant context is stale or absent", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ createdAt: "2026-04-09T00:10:01.000Z", content: "and tomorrow?" }),
      defaultChannelPolicy: "mention-only",
      recentConversation: [turn({ createdAt: "2026-04-09T00:04:00.000Z" })],
      recentMessages: []
    }),
    false
  );

  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ content: "and tomorrow?" }),
      defaultChannelPolicy: "mention-only",
      recentConversation: [turn({ role: "user", content: "previous owner message" })],
      recentMessages: []
    }),
    false
  );
});

test("addressedness uses the most recent turn in the bounded conversation window", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ createdAt: "2026-04-09T00:04:00.000Z", content: "and tomorrow?" }),
      defaultChannelPolicy: "mention-only",
      recentConversation: [
        turn({ id: 1, createdAt: "2026-04-09T00:02:00.000Z" }),
        turn({ id: 2, role: "user", createdAt: "2026-04-09T00:02:30.000Z", content: "thanks" })
      ],
      recentMessages: []
    }),
    false
  );
});

test("addressedness stays false when another inbound message arrived after the assistant reply", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ id: "msg-current", createdAt: "2026-04-09T00:04:00.000Z", content: "and tomorrow?" }),
      defaultChannelPolicy: "mention-only",
      recentConversation: [turn({ createdAt: "2026-04-09T00:03:00.000Z" })],
      recentMessages: [
        message({
          id: "msg-current",
          createdAt: "2026-04-09T00:04:00.000Z",
          content: "and tomorrow?"
        }),
        message({
          id: "msg-other-user",
          authorId: "user-2",
          authorUsername: "friend",
          createdAt: "2026-04-09T00:03:30.000Z",
          content: "wait, what happened?"
        })
      ]
    }),
    false
  );
});
