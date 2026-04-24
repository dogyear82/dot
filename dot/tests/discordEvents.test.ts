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
    botRoleIds: ["role-bot"],
    ownerUserId: "owner-1"
  });

  assert.equal(event.eventId, "discord:msg-1");
  assert.equal(event.eventVersion, "1.0.0");
  assert.equal(event.producer.service, "discord-ingress");
  assert.equal(event.routing.transport, "discord");
  assert.equal(event.correlation.conversationId, "channel-1");
  assert.equal(event.payload.sender.actorRole, "owner");
  assert.equal(event.payload.replyRoute.replyTo, "msg-1");
  assert.equal(event.payload.messageId, "msg-1");
  assert.equal(event.payload.content, "@Dot hello there");
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
    botRoleIds: ["role-bot"],
    ownerUserId: "owner-1"
  });

  assert.equal(event.payload.content, "@Dot !settings show");
  assert.equal(event.payload.addressedContent, "!settings show");
});

test("createDiscordInboundMessageEvent strips the bot role mention prefix only when it is the leading target", () => {
  const message: IncomingMessage = {
    id: "msg-3",
    channelId: "channel-1",
    guildId: "guild-1",
    authorId: "owner-1",
    authorUsername: "tan",
    content: "<@&role-bot> !settings show",
    isDirectMessage: false,
    mentionedBot: true,
    createdAt: "2026-04-09T00:00:00.000Z"
  };

  const event = createDiscordInboundMessageEvent({
    message,
    botUserId: "bot-1",
    botUsername: "Dot",
    botRoleIds: ["role-bot"],
    ownerUserId: "owner-1"
  });

  assert.equal(event.payload.addressedContent, "!settings show");
  assert.equal(event.payload.content, "@Dot !settings show");
});

test("createDiscordInboundMessageEvent does not strip unrelated leading role mentions", () => {
  const message: IncomingMessage = {
    id: "msg-4",
    channelId: "channel-1",
    guildId: "guild-1",
    authorId: "owner-1",
    authorUsername: "tan",
    content: "<@&role-other> <@&role-bot> !settings show",
    isDirectMessage: false,
    mentionedBot: true,
    createdAt: "2026-04-09T00:00:00.000Z"
  };

  const event = createDiscordInboundMessageEvent({
    message,
    botUserId: "bot-1",
    botUsername: "Dot",
    botRoleIds: ["role-bot"],
    ownerUserId: "owner-1"
  });

  assert.equal(event.payload.content, "<@&role-other> @Dot !settings show");
  assert.equal(event.payload.addressedContent, "<@&role-other> @Dot !settings show");
});
