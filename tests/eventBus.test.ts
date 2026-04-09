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
    occurredAt: "2026-04-09T00:00:00.000Z",
    transport: "discord",
    conversationId: "channel-1",
    sourceMessageId: "msg-1",
    correlationId: "msg-1",
    sender: {
      actorId: "owner-1",
      displayName: "owner",
      actorRole: "owner"
    },
    replyRoute: {
      transport: "discord",
      channelId: "channel-1",
      guildId: "guild-1",
      replyToMessageId: "msg-1"
    },
    payload: {
      content: "hello",
      addressedContent: "hello",
      isDirectMessage: false,
      mentionedBot: true
    }
  });

  await bus.publishOutboundMessage({
    eventId: "event-2",
    eventType: "outbound.message.requested",
    occurredAt: "2026-04-09T00:00:01.000Z",
    transport: "discord",
    conversationId: "channel-1",
    correlationId: "msg-1",
    inResponseToEventId: "event-1",
    replyRoute: {
      transport: "discord",
      channelId: "channel-1",
      guildId: "guild-1",
      replyToMessageId: "msg-1"
    },
    content: "world"
  });

  assert.deepEqual(seen, ["in:event-1", "out:event-2"]);
});
