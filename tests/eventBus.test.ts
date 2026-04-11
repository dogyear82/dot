import test from "node:test";
import assert from "node:assert/strict";

import { createInMemoryEventBus } from "../src/eventBus.js";

test("in-memory event bus publishes inbound and outbound events to subscribers", async () => {
  const bus = createInMemoryEventBus();
  const seen: string[] = [];

  bus.subscribeInboundMessage(async (event) => {
    seen.push(`in:${event.eventId}`);
  });

  bus.subscribeOutboundMessage(async (event) => {
    seen.push(`out:${event.eventId}`);
  });

  await bus.publishInboundMessage({
    eventId: "event-1",
    eventType: "inbound.message.received",
    eventVersion: "1.0.0",
    occurredAt: "2026-04-09T00:00:00.000Z",
    producer: {
      service: "discord-ingress"
    },
    correlation: {
      correlationId: "msg-1",
      causationId: null,
      conversationId: "channel-1",
      actorId: "owner-1"
    },
    routing: {
      transport: "discord",
      channelId: "channel-1",
      guildId: "guild-1",
      replyTo: "msg-1"
    },
    diagnostics: {
      severity: "info",
      category: "discord.inbound"
    },
    payload: {
      messageId: "msg-1",
      sender: {
        actorId: "owner-1",
        displayName: "owner",
        actorRole: "owner"
      },
      content: "hello",
      addressedContent: "hello",
      isDirectMessage: false,
      mentionedBot: true,
      replyRoute: {
        transport: "discord",
        channelId: "channel-1",
        guildId: "guild-1",
        replyTo: "msg-1"
      }
    }
  });

  await bus.publishOutboundMessage({
    eventId: "event-2",
    eventType: "outbound.message.requested",
    eventVersion: "1.0.0",
    occurredAt: "2026-04-09T00:00:01.000Z",
    producer: {
      service: "message-pipeline"
    },
    correlation: {
      correlationId: "msg-1",
      causationId: "event-1",
      conversationId: "channel-1",
      actorId: "owner-1"
    },
    routing: {
      transport: "discord",
      channelId: "channel-1",
      guildId: "guild-1",
      replyTo: "msg-1"
    },
    diagnostics: {
      severity: "info",
      category: "outbound.delivery"
    },
    payload: {
      inResponseToEventId: "event-1",
      participantActorId: "owner-1",
      replyRoute: {
        transport: "discord",
        channelId: "channel-1",
        guildId: "guild-1",
        replyTo: "msg-1"
      },
      content: "world",
      recordConversationTurn: false
    }
  });

  assert.deepEqual(seen, ["in:event-1", "out:event-2"]);
});

test("in-memory event bus supports generic topic subscription and all-event observation", async () => {
  const bus = createInMemoryEventBus();
  const seen: string[] = [];

  bus.subscribe("inbound.message.received", async (event) => {
    seen.push(`topic:${event.eventType}:${event.eventId}`);
  });

  bus.subscribeAll(async (event) => {
    seen.push(`all:${event.eventType}:${event.eventId}`);
  });

  await bus.publishInboundMessage({
    eventId: "event-3",
    eventType: "inbound.message.received",
    eventVersion: "1.0.0",
    occurredAt: "2026-04-09T00:00:00.000Z",
    producer: { service: "discord-ingress" },
    correlation: {
      correlationId: "msg-3",
      causationId: null,
      conversationId: "channel-1",
      actorId: "owner-1"
    },
    routing: {
      transport: "discord",
      channelId: "channel-1",
      guildId: "guild-1",
      replyTo: "msg-3"
    },
    diagnostics: {
      severity: "info",
      category: "discord.inbound"
    },
    payload: {
      messageId: "msg-3",
      sender: {
        actorId: "owner-1",
        displayName: "owner",
        actorRole: "owner"
      },
      content: "hello",
      addressedContent: "hello",
      isDirectMessage: false,
      mentionedBot: true,
      replyRoute: {
        transport: "discord",
        channelId: "channel-1",
        guildId: "guild-1",
        replyTo: "msg-3"
      }
    }
  });

  assert.deepEqual(seen, [
    "topic:inbound.message.received:event-3",
    "all:inbound.message.received:event-3"
  ]);
});
