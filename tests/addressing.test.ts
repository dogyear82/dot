import test from "node:test";
import assert from "node:assert/strict";

import { shouldTreatOwnerMessageAsAddressed } from "../src/discord/addressing.js";
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
    createdAt: "2026-04-09T00:00:00.000Z",
    ...overrides
  };
}

test("addressedness is true for direct messages and explicit mentions", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ isDirectMessage: true }),
      botUserId: "bot-1",
      defaultChannelPolicy: "mention-only",
      recentMessages: []
    }),
    true
  );

  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ mentionedBot: true }),
      botUserId: "bot-1",
      defaultChannelPolicy: "mention-only",
      recentMessages: []
    }),
    true
  );
});

test("addressedness stays false in shared channels when policy is dm-only", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ content: "dot what about tomorrow?" }),
      botUserId: "bot-1",
      defaultChannelPolicy: "dm-only",
      recentMessages: []
    }),
    false
  );
});

test("addressedness is true for plain-text direct address", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ content: "Dot, what about tomorrow?" }),
      botUserId: "bot-1",
      defaultChannelPolicy: "mention-only",
      recentMessages: []
    }),
    true
  );
});

test("addressedness is true when the bot was the most recent speaker in the channel", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ createdAt: "2026-04-09T00:04:00.000Z", content: "and what about tomorrow?" }),
      botUserId: "bot-1",
      defaultChannelPolicy: "mention-only",
      recentMessages: [
        message({
          id: "msg-bot",
          authorId: "bot-1",
          authorUsername: "Dot",
          content: "You have a meeting today.",
          createdAt: "2026-04-09T00:03:00.000Z"
        })
      ]
    }),
    true
  );
});

test("addressedness stays false when recent bot context is stale or absent", () => {
  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ createdAt: "2026-04-09T00:10:01.000Z", content: "and tomorrow?" }),
      botUserId: "bot-1",
      defaultChannelPolicy: "mention-only",
      recentMessages: [
        message({
          id: "msg-bot",
          authorId: "bot-1",
          authorUsername: "Dot",
          content: "You have a meeting today.",
          createdAt: "2026-04-09T00:04:00.000Z"
        })
      ]
    }),
    false
  );

  assert.equal(
    shouldTreatOwnerMessageAsAddressed({
      message: message({ content: "and tomorrow?" }),
      botUserId: "bot-1",
      defaultChannelPolicy: "mention-only",
      recentMessages: [
        message({
          id: "msg-owner-older",
          authorId: "owner-1",
          content: "previous owner message"
        })
      ]
    }),
    false
  );
});
