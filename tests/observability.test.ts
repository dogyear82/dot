import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { createInMemoryEventBus } from "../src/eventBus.js";
import type { InboundMessageReceivedEvent, OutboundMessageRequestedEvent } from "../src/events.js";
import { registerMessagePipeline } from "../src/messagePipeline.js";
import { startObservability } from "../src/observability.js";
import { initializePersistence } from "../src/persistence.js";
import type { ChatService } from "../src/chat/modelRouter.js";
import type { OutlookCalendarClient } from "../src/outlookCalendar.js";

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-observability-"));
  const sqlitePath = path.join(dataDir, "dot.sqlite");
  const persistence = initializePersistence(dataDir, sqlitePath);

  return {
    persistence,
    cleanup() {
      persistence.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}

function inboundEvent(): InboundMessageReceivedEvent {
  return {
    eventId: "discord:msg-1",
    eventType: "inbound.message.received",
    eventVersion: "1.0.0",
    occurredAt: "2026-04-11T00:00:00.000Z",
    producer: {
      service: "discord-ingress"
    },
    correlation: {
      correlationId: "corr-1",
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
      content: "!settings show",
      addressedContent: "!settings show",
      isDirectMessage: false,
      mentionedBot: true,
      replyRoute: {
        transport: "discord",
        channelId: "channel-1",
        guildId: "guild-1",
        replyTo: "msg-1"
      }
    }
  };
}

test("observability exports metrics and spans for a canonical message-pipeline flow", async () => {
  const { persistence, cleanup } = createPersistence();
  const spanExporter = new InMemorySpanExporter();
  const observability = startObservability({
    config: {
      LOG_LEVEL: "info",
      METRICS_HOST: "127.0.0.1",
      METRICS_PORT: 0,
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      OTEL_SERVICE_NAME: "dot-test"
    },
    logger: createLogger() as never,
    testSpanExporter: spanExporter
  });
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  const chatService: ChatService = {
    async generateOwnerReply() {
      return { route: "local", powerStatus: "standby", reply: "chat reply" };
    },
    async inferToolDecision() {
      return { route: "local", powerStatus: "standby", decision: { decision: "none", reason: "not needed" } };
    },
    getPowerStatus() {
      return "standby";
    }
  };

  persistence.settings.set("onboarding.completed", "true");
  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient,
    chatService,
    logger: createLogger() as never,
    mailClient: {} as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  try {
    await bus.publishInboundMessage(inboundEvent());

    assert.equal(outbound.length, 1);

    const metricsUrl = await waitForMetricsUrl(observability, 2000);
    assert(metricsUrl);
    const metricsResponse = await fetch(metricsUrl);
    const metricsBody = await metricsResponse.text();

    assert.match(metricsBody, /dot_inbound_messages_total/);
    assert.match(metricsBody, /dot_message_pipeline_duration_seconds/);
    assert.match(metricsBody, /dot_eventbus_events_published_total/);

    const spans = spanExporter.getFinishedSpans();
    assert(spans.some((span) => span.name === "eventbus.publish"));
    assert(spans.some((span) => span.name === "eventbus.consume"));
    assert(spans.some((span) => span.name === "message.pipeline.handle"));
    assert(spans.some((span) => span.attributes["dot.correlation.id"] === "corr-1"));
  } finally {
    unsubscribe();
    await bus.close();
    await observability.stop();
    cleanup();
  }
});

async function waitForMetricsUrl(
  observability: { getMetricsUrl(): string | null },
  timeoutMs: number
): Promise<string | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const metricsUrl = observability.getMetricsUrl();
    if (metricsUrl) {
      return metricsUrl;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return null;
}
