import http from "node:http";

import { context, createContextKey, SpanKind, SpanStatusCode, trace, type Span, type SpanOptions } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { BatchSpanProcessor, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Logger } from "pino";
import client, { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

import type { AppConfig } from "./config.js";
import type { DotEvent } from "./events.js";
import type { ServiceHealthSnapshotRecord } from "./types.js";

const tracer = trace.getTracer("dot");
const logContextKey = createContextKey("dot-log-context");

interface LogContext {
  eventId?: string;
  eventType?: string;
  correlationId?: string;
  causationId?: string | null;
  conversationId?: string | null;
  actorId?: string | null;
}

interface MetricsState {
  registry: Registry;
  inboundMessagesTotal: Counter<string>;
  outboundMessagesTotal: Counter<string>;
  eventBusPublishedTotal: Counter<string>;
  eventBusConsumedTotal: Counter<string>;
  pipelineDurationSeconds: Histogram<string>;
  llmRequestsTotal: Counter<string>;
  llmRequestDurationSeconds: Histogram<string>;
  toolExecutionsTotal: Counter<string>;
  serviceHealthStatus: Gauge<string>;
}

let metricsState: MetricsState | null = null;
let tracerProvider: NodeTracerProvider | null = null;
let metricsServer: http.Server | null = null;

export interface ObservabilityHandle {
  stop(): Promise<void>;
  getMetricsUrl(): string | null;
}

export function startObservability(params: {
  config: Pick<AppConfig, "LOG_LEVEL" | "METRICS_HOST" | "METRICS_PORT" | "OTEL_EXPORTER_OTLP_ENDPOINT" | "OTEL_SERVICE_NAME">;
  logger: Logger;
  testSpanExporter?: InMemorySpanExporter;
}): ObservabilityHandle {
  if (tracerProvider || metricsServer || metricsState) {
    throw new Error("Observability has already been started.");
  }

  const registry = new Registry();
  registry.setDefaultLabels({
    service_name: params.config.OTEL_SERVICE_NAME
  });
  collectDefaultMetrics({
    prefix: "dot_",
    register: registry
  });

  metricsState = {
    registry,
    inboundMessagesTotal: new client.Counter({
      name: "dot_inbound_messages_total",
      help: "Total inbound messages received by transport and actor role.",
      labelNames: ["transport", "actor_role"],
      registers: [registry]
    }),
    outboundMessagesTotal: new client.Counter({
      name: "dot_outbound_messages_total",
      help: "Total outbound messages requested by transport.",
      labelNames: ["transport"],
      registers: [registry]
    }),
    eventBusPublishedTotal: new client.Counter({
      name: "dot_eventbus_events_published_total",
      help: "Total canonical events published on the bus.",
      labelNames: ["event_type", "producer_service"],
      registers: [registry]
    }),
    eventBusConsumedTotal: new client.Counter({
      name: "dot_eventbus_events_consumed_total",
      help: "Total canonical events consumed from the bus.",
      labelNames: ["event_type", "consumer"],
      registers: [registry]
    }),
    pipelineDurationSeconds: new client.Histogram({
      name: "dot_message_pipeline_duration_seconds",
      help: "Duration of message pipeline handling by actor role and outcome.",
      labelNames: ["actor_role", "outcome"],
      registers: [registry],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]
    }),
    llmRequestsTotal: new client.Counter({
      name: "dot_llm_requests_total",
      help: "Total LLM provider requests by operation, provider, route, and outcome.",
      labelNames: ["operation", "provider", "route", "outcome"],
      registers: [registry]
    }),
    llmRequestDurationSeconds: new client.Histogram({
      name: "dot_llm_request_duration_seconds",
      help: "Duration of LLM provider requests by operation, provider, and route.",
      labelNames: ["operation", "provider", "route"],
      registers: [registry],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30]
    }),
    toolExecutionsTotal: new client.Counter({
      name: "dot_tool_executions_total",
      help: "Total tool decisions and executions by tool and status.",
      labelNames: ["tool_name", "status"],
      registers: [registry]
    }),
    serviceHealthStatus: new client.Gauge({
      name: "dot_service_health_status",
      help: "Current service health status as one-hot gauge values per service, check, and status.",
      labelNames: ["service", "check_name", "status"],
      registers: [registry]
    })
  };

  tracerProvider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: params.config.OTEL_SERVICE_NAME
    }),
    spanProcessors: params.testSpanExporter
      ? [new SimpleSpanProcessor(params.testSpanExporter)]
      : params.config.OTEL_EXPORTER_OTLP_ENDPOINT
        ? [
            new BatchSpanProcessor(
              new OTLPTraceExporter({
                url: params.config.OTEL_EXPORTER_OTLP_ENDPOINT
              })
            )
          ]
        : []
  });

  tracerProvider.register();

  metricsServer = http.createServer(async (request, response) => {
    if (request.url !== "/metrics") {
      response.statusCode = 404;
      response.end("Not Found");
      return;
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", registry.contentType);
    response.end(await registry.metrics());
  });

  metricsServer.listen(params.config.METRICS_PORT, params.config.METRICS_HOST, () => {
    params.logger.info(
      {
        metricsHost: params.config.METRICS_HOST,
        metricsPort: params.config.METRICS_PORT,
        otlpEndpoint: params.config.OTEL_EXPORTER_OTLP_ENDPOINT || null,
        logLevel: params.config.LOG_LEVEL
      },
      "Observability instrumentation started"
    );
  });

  return {
    async stop() {
      if (metricsServer?.listening) {
        await new Promise<void>((resolve, reject) => {
          metricsServer?.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        });
      }
      metricsServer = null;

      if (tracerProvider) {
        await tracerProvider.shutdown();
        tracerProvider = null;
      }

      metricsState = null;
    },
    getMetricsUrl() {
      const address = metricsServer?.address();
      if (!address || typeof address === "string") {
        return null;
      }

      return `http://${address.address}:${address.port}/metrics`;
    }
  };
}

export function getActiveLogContext(): Record<string, string> {
  const current = context.active().getValue(logContextKey) as LogContext | undefined;
  const activeSpan = trace.getActiveSpan();
  const spanContext = activeSpan?.spanContext();
  const logContext: Record<string, string> = {};

  if (spanContext?.traceId) {
    logContext.traceId = spanContext.traceId;
    logContext.spanId = spanContext.spanId;
  }

  if (current?.eventId) {
    logContext.eventId = current.eventId;
  }
  if (current?.eventType) {
    logContext.eventType = current.eventType;
  }
  if (current?.correlationId) {
    logContext.correlationId = current.correlationId;
  }
  if (current?.causationId) {
    logContext.causationId = current.causationId;
  }
  if (current?.conversationId) {
    logContext.conversationId = current.conversationId;
  }
  if (current?.actorId) {
    logContext.actorId = current.actorId;
  }

  return logContext;
}

export function withEventContext<T>(event: DotEvent, fn: () => T): T {
  const active = context.active();
  const current = (active.getValue(logContextKey) as LogContext | undefined) ?? {};
  const enriched = active.setValue(logContextKey, {
    ...current,
    eventId: event.eventId,
    eventType: event.eventType,
    correlationId: event.correlation.correlationId,
    causationId: event.correlation.causationId,
    conversationId: event.correlation.conversationId,
    actorId: event.correlation.actorId
  });

  return context.with(enriched, fn);
}

export async function withSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T> | T
): Promise<T> {
  return tracer.startActiveSpan(name, options, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function createSpanAttributesForEvent(event: DotEvent): Record<string, string> {
  return {
    "dot.event.id": event.eventId,
    "dot.event.type": event.eventType,
    "dot.correlation.id": event.correlation.correlationId,
    "dot.causation.id": event.correlation.causationId ?? "",
    "dot.conversation.id": event.correlation.conversationId ?? "",
    "dot.actor.id": event.correlation.actorId ?? "",
    "dot.producer.service": event.producer.service
  };
}

export function recordInboundMessage(params: { transport: string; actorRole: string }) {
  metricsState?.inboundMessagesTotal.inc({
    transport: params.transport,
    actor_role: params.actorRole
  });
}

export function recordOutboundMessage(params: { transport: string }) {
  metricsState?.outboundMessagesTotal.inc({
    transport: params.transport
  });
}

export function recordEventPublished(event: DotEvent) {
  metricsState?.eventBusPublishedTotal.inc({
    event_type: event.eventType,
    producer_service: event.producer.service
  });
}

export function recordEventConsumed(params: { event: DotEvent; consumer: string }) {
  metricsState?.eventBusConsumedTotal.inc({
    event_type: params.event.eventType,
    consumer: params.consumer
  });
}

export function startPipelineTimer(params: { actorRole: string; outcome: () => string }) {
  const startedAt = process.hrtime.bigint();

  return () => {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    metricsState?.pipelineDurationSeconds.observe(
      {
        actor_role: params.actorRole,
        outcome: params.outcome()
      },
      durationSeconds
    );
  };
}

export function startLlmTimer(params: {
  operation: string;
  provider: string;
  route: string;
}) {
  const startedAt = process.hrtime.bigint();

  return {
    stop(outcome: "success" | "failure") {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      metricsState?.llmRequestsTotal.inc({
        operation: params.operation,
        provider: params.provider,
        route: params.route,
        outcome
      });
      metricsState?.llmRequestDurationSeconds.observe(
        {
          operation: params.operation,
          provider: params.provider,
          route: params.route
        },
        durationSeconds
      );
    }
  };
}

export function recordToolExecution(params: { toolName: string; status: string }) {
  metricsState?.toolExecutionsTotal.inc({
    tool_name: params.toolName,
    status: params.status
  });
}

export function recordServiceHealthSnapshot(snapshot: ServiceHealthSnapshotRecord) {
  for (const status of ["good", "bad", "offline"] as const) {
    metricsState?.serviceHealthStatus.set(
      {
        service: snapshot.service,
        check_name: snapshot.checkName,
        status
      },
      snapshot.status === status ? 1 : 0
    );
  }
}

export function getSpanKind() {
  return SpanKind;
}
