import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDiagnosticsObserver, createHostHealthEvent, mapServiceReadinessToHealthStatus } from "../src/diagnostics.js";
import { createInMemoryEventBus } from "../src/eventBus.js";
import { createServiceHealthReportedEvent } from "../src/events.js";
import { initializePersistence } from "../src/persistence.js";

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-diagnostics-"));
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

test("diagnostics observer records canonical events and updates latest service health snapshots", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();

  try {
    const observer = createDiagnosticsObserver({
      bus,
      logger: createLogger() as never,
      persistence
    });

    await bus.publish({
      eventId: "event-1",
      eventType: "inbound.message.received",
      eventVersion: "1.0.0",
      occurredAt: "2026-04-11T00:00:00.000Z",
      producer: {
        service: "discord-ingress"
      },
      correlation: {
        correlationId: "corr-1",
        causationId: null,
        conversationId: "chan-1",
        actorId: "owner-1"
      },
      routing: {
        transport: "discord",
        channelId: "chan-1",
        guildId: "guild-1",
        replyTo: "msg-1"
      },
      diagnostics: {
        severity: "info",
        category: "discord.inbound"
      },
      payload: {
        messageId: "msg-1"
      }
    });

    await bus.publish(
      createServiceHealthReportedEvent({
        service: "discord-transport",
        checkName: "host.lifecycle",
        status: "good",
        state: "ready",
        detail: null
      })
    );

    const recentEvents = persistence.listRecentDiagnosticEvents(5);
    assert.equal(recentEvents.length, 2);
    assert.equal(recentEvents[0]?.eventType, "diagnostics.health.reported");
    assert.equal(recentEvents[1]?.eventType, "inbound.message.received");

    assert.deepEqual(persistence.listServiceHealthSnapshots(), [
      {
        service: "discord-transport",
        checkName: "host.lifecycle",
        status: "good",
        state: "ready",
        detail: null,
        observedLatencyMs: null,
        sourceEventId: null,
        lastEventId: recentEvents[0]!.eventId,
        updatedAt: recentEvents[0]!.occurredAt
      }
    ]);

    observer.stop();
  } finally {
    await bus.close();
    cleanup();
  }
});

test("service readiness maps deterministically to dashboard health states", () => {
  assert.equal(mapServiceReadinessToHealthStatus("idle"), "offline");
  assert.equal(mapServiceReadinessToHealthStatus("starting"), "bad");
  assert.equal(mapServiceReadinessToHealthStatus("ready"), "good");
  assert.equal(mapServiceReadinessToHealthStatus("stopping"), "bad");
  assert.equal(mapServiceReadinessToHealthStatus("stopped"), "offline");
  assert.equal(mapServiceReadinessToHealthStatus("error"), "bad");
});

test("host lifecycle helper emits the standardized diagnostics health event shape", () => {
  const event = createHostHealthEvent({
    name: "reminders",
    readiness: "error",
    detail: "scheduler failed"
  });

  assert.equal(event.eventType, "diagnostics.health.reported");
  assert.equal(event.payload.service, "reminders");
  assert.equal(event.payload.checkName, "host.lifecycle");
  assert.equal(event.payload.status, "bad");
  assert.equal(event.payload.state, "error");
  assert.equal(event.payload.detail, "scheduler failed");
});
