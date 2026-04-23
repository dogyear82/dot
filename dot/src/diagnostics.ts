import type { Logger } from "pino";

import type { EventBus } from "./eventBus.js";
import { recordServiceHealthSnapshot } from "./observability.js";
import type { DotEvent, ServiceHealthReportedEvent } from "./events.js";
import { createServiceHealthReportedEvent } from "./events.js";
import type { Persistence } from "./persistence.js";
import type { ServiceHealthSnapshotRecord, ServiceHealthStatus } from "./types.js";
import type { ServiceReadiness, ServiceStatus } from "./runtime/serviceHost.js";

export interface DiagnosticsObserver {
  stop(): void;
}

export function createDiagnosticsObserver(params: {
  bus: EventBus;
  logger: Logger;
  persistence: Persistence;
}): DiagnosticsObserver {
  const unsubscribe = params.bus.subscribeAll(async (event) => {
    await params.persistence.saveDiagnosticEvent(event);

    if (isServiceHealthReportedEvent(event)) {
      const snapshot = buildServiceHealthSnapshotFromEvent(event);
      await params.persistence.upsertServiceHealthSnapshot(snapshot);
      recordServiceHealthSnapshot(snapshot);
    }
  });

  params.logger.info("Diagnostics observer subscribed to all bus topics");

  return {
    stop() {
      unsubscribe();
    }
  };
}

export function mapServiceReadinessToHealthStatus(readiness: ServiceReadiness): ServiceHealthStatus {
  switch (readiness) {
    case "ready":
      return "good";
    case "idle":
    case "stopped":
      return "offline";
    case "starting":
    case "stopping":
    case "error":
      return "bad";
  }
}

export function createHostHealthEvent(status: ServiceStatus): ServiceHealthReportedEvent {
  return createServiceHealthReportedEvent({
    service: status.name,
    checkName: "host.lifecycle",
    status: mapServiceReadinessToHealthStatus(status.readiness),
    state: status.readiness,
    detail: status.detail
  });
}

function isServiceHealthReportedEvent(event: DotEvent): event is ServiceHealthReportedEvent {
  return event.eventType === "diagnostics.health.reported";
}

export function buildServiceHealthSnapshotFromEvent(event: ServiceHealthReportedEvent): ServiceHealthSnapshotRecord {
  return {
    service: event.payload.service,
    checkName: event.payload.checkName,
    status: event.payload.status,
    state: event.payload.state,
    detail: event.payload.detail,
    observedLatencyMs: event.payload.observedLatencyMs,
    sourceEventId: event.payload.sourceEventId,
    lastEventId: event.eventId,
    updatedAt: event.occurredAt
  };
}
