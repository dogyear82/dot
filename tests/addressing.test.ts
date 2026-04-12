import test from "node:test";
import assert from "node:assert/strict";

import { evaluateAddressedness, shouldTreatOwnerMessageAsAddressed } from "../src/discord/addressing.js";
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
    participantActorId: "owner-1",
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

test("addressedness still responds to clear shared-channel direct address even when policy is dm-only", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ content: "dot what about tomorrow?" }),
      defaultChannelPolicy: "dm-only",
      recentConversation: [],
      recentMessages: []
    }),
    true
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

test("addressedness is true for explicit commands in shared channels", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ content: "!settings set llm.mode power" }),
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
      recentConversation: [turn({ role: "user", participantActorId: "owner-1", content: "previous owner message" })],
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
        turn({ id: 2, role: "user", participantActorId: "owner-1", createdAt: "2026-04-09T00:02:30.000Z", content: "thanks" })
      ],
      recentMessages: []
    }),
    false
  );
});

test("addressedness stays false when the recent assistant reply was for a different participant", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ authorId: "user-2", authorUsername: "friend", createdAt: "2026-04-09T00:04:00.000Z", content: "and tomorrow?" }),
      defaultChannelPolicy: "mention-only",
      recentConversation: [turn({ createdAt: "2026-04-09T00:03:00.000Z", participantActorId: "owner-1" })],
      recentMessages: [message({ id: "msg-previous", createdAt: "2026-04-09T00:02:30.000Z", content: "@Dot hello", mentionedBot: true })]
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

test("addressedness requires the previous inbound message to have been explicitly addressed to Dot", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ id: "msg-current", createdAt: "2026-04-09T00:01:30.000Z", content: "and tomorrow?" }),
      defaultChannelPolicy: "mention-only",
      recentConversation: [turn({ createdAt: "2026-04-09T00:01:00.000Z" })],
      recentMessages: [
        message({
          id: "msg-current",
          createdAt: "2026-04-09T00:01:30.000Z",
          content: "and tomorrow?"
        }),
        message({
          id: "msg-previous-same-author",
          createdAt: "2026-04-09T00:00:30.000Z",
          content: "what about tomorrow?",
          mentionedBot: false
        })
      ]
    }),
    false
  );
});

test("addressedness diagnostics return a stable reason for ignored follow-ups", () => {
  const decision = evaluateAddressedness({
    message: message({ id: "msg-current", createdAt: "2026-04-09T00:01:30.000Z", content: "and tomorrow?" }),
    defaultChannelPolicy: "mention-only",
    recentConversation: [turn({ createdAt: "2026-04-09T00:01:00.000Z" })],
    recentMessages: [
      message({
        id: "msg-current",
        createdAt: "2026-04-09T00:01:30.000Z",
        content: "and tomorrow?"
      }),
      message({
        id: "msg-previous-same-author",
        createdAt: "2026-04-09T00:00:30.000Z",
        content: "what about tomorrow?",
        mentionedBot: false
      })
    ]
  });

  assert.deepEqual(decision, {
    addressed: false,
    reason: "recent_message_not_addressed_to_dot"
  });
});
