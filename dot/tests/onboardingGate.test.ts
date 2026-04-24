import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryEventBus } from "../src/eventBus.js";
import type { InboundMessageReceivedEvent, OutboundMessageRequestedEvent } from "../src/events.js";
import { registerMessagePipeline } from "../src/messagePipeline.js";
import { createSettingsStore } from "../src/settings.js";

function createInboundEvent(
  overrides: Partial<InboundMessageReceivedEvent["payload"]> = {}
): InboundMessageReceivedEvent {
  return {
    eventId: "discord:msg-1",
    eventType: "inbound.message.received",
    eventVersion: "1.0.0",
    occurredAt: "2026-04-24T00:00:00.000Z",
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
        displayName: "tan",
        actorRole: "owner"
      },
      content: "Dot, you there?",
      addressedContent: "Dot, you there?",
      isDirectMessage: false,
      mentionedBot: true,
      repliedToMessageId: null,
      repliedToBot: false,
      replyRoute: {
        transport: "discord",
        channelId: "channel-1",
        guildId: "guild-1",
        replyTo: "msg-1"
      },
      ...overrides
    }
  };
}

test("owner messages bypass routing and enter onboarding until onboarding is complete", async () => {
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const settings = createSettingsStore({});
  let llmCalls = 0;
  let toolCatalogCalls = 0;

  const unsubscribeOutbound = bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  const unsubscribePipeline = registerMessagePipeline({
    bus,
    llmService: {
      async generate() {
        llmCalls += 1;
        return "";
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {}
    } as never,
    ownerUserId: "owner-1",
    persistence: {
      settings,
      async saveNormalizedMessage() {},
      async saveConversationTurn() {},
      async listRecentConversationTurns() {
        return [];
      },
      async saveAccessAudit() {},
      async saveDiagnosticEvent() {},
      async upsertServiceHealthSnapshot() {},
      async close() {}
    },
    toolService: {
      async listToolsForRouting() {
        toolCatalogCalls += 1;
        return [];
      },
      async executeTool() {
        throw new Error("tool execution should not run during onboarding");
      }
    }
  });

  try {
    assert.equal(settings.hasCompletedOnboarding(), false);

    await bus.publishInboundMessage(createInboundEvent());

    assert.equal(llmCalls, 0);
    assert.equal(toolCatalogCalls, 0);
    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /Please reply with one of:/);
    assert.match(outbound[0]?.payload.content ?? "", /sheltered, diagnostic/);
  } finally {
    unsubscribePipeline();
    unsubscribeOutbound();
    await bus.close();
  }
});
