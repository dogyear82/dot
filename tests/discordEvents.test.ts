import test from "node:test";
import assert from "node:assert/strict";

import { createDiscordInboundMessageEvent } from "../src/discord/events.js";
import type { IncomingMessage } from "../src/types.js";

test("createDiscordInboundMessageEvent produces a canonical transport-neutral envelope", () => {
  const message: IncomingMessage = {
    id: "msg-1",
    channelId: "channel-1",
    guildId: "guild-1",
    authorId: "owner-1",
    authorUsername: "tan",
    content: "<@bot-1> hello there",
    isDirectMessage: false,
    mentionedBot: true,
    createdAt: "2026-04-09T00:00:00.000Z"
  };

  const event = createDiscordInboundMessageEvent({
    message,
    botUserId: "bot-1",
    botUsername: "Dot",
    ownerUserId: "owner-1"
  });

  assert.equal(event.eventId, "discord:msg-1");
  assert.equal(event.transport, "discord");
  assert.equal(event.conversationId, "channel-1");
  assert.equal(event.sender.actorRole, "owner");
  assert.equal(event.replyRoute.replyToMessageId, "msg-1");
  assert.equal(event.payload.content, "<@bot-1> hello there");
  assert.equal(event.payload.addressedContent, "hello there");
});

test("createDiscordInboundMessageEvent strips a plain-text bot address prefix", () => {
  const message: IncomingMessage = {
    id: "msg-2",
    channelId: "channel-1",
    guildId: "guild-1",
    authorId: "owner-1",
    authorUsername: "tan",
    content: "@Dot !settings show",
    isDirectMessage: false,
    mentionedBot: false,
    createdAt: "2026-04-09T00:00:00.000Z"
  };

  const event = createDiscordInboundMessageEvent({
    message,
    botUserId: "bot-1",
    botUsername: "Dot",
    ownerUserId: "owner-1"
  });

  assert.equal(event.payload.content, "@Dot !settings show");
  assert.equal(event.payload.addressedContent, "!settings show");
});
