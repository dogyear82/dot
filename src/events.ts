import type { ActorRole } from "./auth.js";
import type { EmailActionStatus, OutlookMailMessage, ServiceHealthStatus } from "./types.js";

export const DOT_EVENT_VERSION = "1.0.0";

export const DOT_EVENT_TOPICS = [
  "inbound.message.received",
  "outbound.message.requested",
  "outbound.message.delivered",
  "outbound.message.delivery_failed",
  "diagnostics.health.reported",
  "discord.message.received",
  "discord.message.delivery.requested",
  "llm.reply.generated",
  "email.action.requested",
  "email.action.completed",
  "outlook.calendar.query.completed",
  "outlook.mail.message.detected",
  "outlook.mail.delta.synced",
  "reminder.due"
] as const;

export type DotEventTopic = (typeof DOT_EVENT_TOPICS)[number];

export interface DotEventProducer {
  service: string;
  instanceId?: string;
}

export interface DotEventCorrelation {
  correlationId: string;
  causationId: string | null;
  conversationId: string | null;
  actorId: string | null;
}

export interface DotEventRouting {
  transport: string | null;
  channelId: string | null;
  guildId: string | null;
  replyTo: string | null;
}

export interface DotEventDiagnostics {
  severity: "debug" | "info" | "warn" | "error";
  category: string | null;
}

export interface DotEvent<
  TTopic extends string = string,
  TPayload = unknown,
  TRouting extends DotEventRouting = DotEventRouting
> {
  eventId: string;
  eventType: TTopic;
  eventVersion: string;
  occurredAt: string;
  producer: DotEventProducer;
  correlation: DotEventCorrelation;
  routing: TRouting;
  diagnostics: DotEventDiagnostics;
  payload: TPayload;
}

export interface CanonicalSender {
  actorId: string;
  displayName: string;
  actorRole: ActorRole;
}

export interface InboundReplyRoute extends DotEventRouting {
  transport: "discord";
  channelId: string;
  guildId: string | null;
  replyTo: string;
}

export interface InboundMessagePayload {
  messageId: string;
  sender: CanonicalSender;
  content: string;
  addressedContent: string;
  isDirectMessage: boolean;
  mentionedBot: boolean;
  replyRoute: InboundReplyRoute;
}

export type InboundMessageReceivedEvent = DotEvent<
  "inbound.message.received",
  InboundMessagePayload,
  InboundReplyRoute
>;

export interface OutboundMessageRequestedPayload {
  inResponseToEventId: string | null;
  participantActorId: string;
  content: string;
  recordConversationTurn: boolean;
  delivery: OutboundDelivery;
  deliveryContext: OutboundDeliveryContext | null;
}

export type OutboundMessageRequestedEvent = DotEvent<
  "outbound.message.requested",
  OutboundMessageRequestedPayload,
  OutboundMessageRouting
>;

export interface DirectMessageRoute extends DotEventRouting {
  transport: "discord";
  channelId: null;
  guildId: null;
  replyTo: null;
}

export type OutboundMessageRouting = InboundReplyRoute | DirectMessageRoute;

export interface OutboundReplyDelivery {
  transport: "discord";
  kind: "reply";
  channelId: string;
  guildId: string | null;
  replyTo: string;
  recipientActorId: string;
}

export interface OutboundDirectMessageDelivery {
  transport: "discord";
  kind: "direct-message";
  channelId: null;
  guildId: null;
  replyTo: null;
  recipientActorId: string;
}

export type OutboundDelivery = OutboundReplyDelivery | OutboundDirectMessageDelivery;

export interface ReminderDeliveryContext {
  kind: "reminder";
  reminderId: number;
}

export interface ServiceNotificationDeliveryContext {
  kind: "service_notification";
  notificationType: string;
  service: string;
}

export type OutboundDeliveryContext = ReminderDeliveryContext | ServiceNotificationDeliveryContext;

export interface OutboundMessageDeliveredPayload {
  requestEventId: string;
  participantActorId: string;
  delivery: OutboundDelivery;
  deliveryContext: OutboundDeliveryContext | null;
  transportMessageId: string | null;
}

export type OutboundMessageDeliveredEvent = DotEvent<
  "outbound.message.delivered",
  OutboundMessageDeliveredPayload,
  OutboundMessageRouting
>;

export interface OutboundMessageDeliveryFailedPayload {
  requestEventId: string;
  participantActorId: string;
  delivery: OutboundDelivery;
  deliveryContext: OutboundDeliveryContext | null;
  reason: string;
}

export type OutboundMessageDeliveryFailedEvent = DotEvent<
  "outbound.message.delivery_failed",
  OutboundMessageDeliveryFailedPayload,
  OutboundMessageRouting
>;

export interface ServiceHealthReportedPayload {
  service: string;
  checkName: string;
  status: ServiceHealthStatus;
  state: string | null;
  detail: string | null;
  observedLatencyMs: number | null;
  sourceEventId: string | null;
}

export type ServiceHealthReportedEvent = DotEvent<
  "diagnostics.health.reported",
  ServiceHealthReportedPayload
>;

export interface OutlookMailMessageDetectedPayload {
  message: OutlookMailMessage;
  initialBaseline: boolean;
}

export type OutlookMailMessageDetectedEvent = DotEvent<
  "outlook.mail.message.detected",
  OutlookMailMessageDetectedPayload
>;

export type EmailActionOperation = "create_draft" | "send_draft";

export interface EmailActionRequestedPayload {
  actionId: number;
  operation: EmailActionOperation;
}

export type EmailActionRequestedEvent = DotEvent<
  "email.action.requested",
  EmailActionRequestedPayload
>;

export interface EmailActionCompletedPayload {
  requestEventId: string;
  actionId: number;
  operation: EmailActionOperation;
  status: EmailActionStatus;
  reply: string;
}

export type EmailActionCompletedEvent = DotEvent<
  "email.action.completed",
  EmailActionCompletedPayload
>;

export function createOutboundMessageRequestedEvent(params: {
  inboundEvent: InboundMessageReceivedEvent;
  content: string;
  recordConversationTurn?: boolean;
  deliveryContext?: OutboundDeliveryContext | null;
}): OutboundMessageRequestedEvent {
  const { inboundEvent, content, recordConversationTurn = false, deliveryContext = null } = params;
  const delivery: OutboundReplyDelivery = {
    transport: "discord",
    kind: "reply",
    channelId: inboundEvent.payload.replyRoute.channelId,
    guildId: inboundEvent.payload.replyRoute.guildId,
    replyTo: inboundEvent.payload.replyRoute.replyTo,
    recipientActorId: inboundEvent.payload.sender.actorId
  };

  return {
    eventId: `${inboundEvent.eventId}:outbound:${Date.now()}`,
    eventType: "outbound.message.requested",
    eventVersion: DOT_EVENT_VERSION,
    occurredAt: new Date().toISOString(),
    producer: { service: "message-pipeline" },
    correlation: {
      correlationId: inboundEvent.correlation.correlationId,
      causationId: inboundEvent.eventId,
      conversationId: inboundEvent.correlation.conversationId,
      actorId: inboundEvent.correlation.actorId
    },
    routing: inboundEvent.routing,
    diagnostics: {
      severity: "info",
      category: "outbound.delivery"
    },
    payload: {
      inResponseToEventId: inboundEvent.eventId,
      participantActorId: inboundEvent.payload.sender.actorId,
      delivery,
      deliveryContext,
      content,
      recordConversationTurn
    }
  };
}

export function createSystemOutboundMessageRequestedEvent(params: {
  content: string;
  participantActorId: string;
  delivery: OutboundDelivery;
  producerService: string;
  correlationId: string;
  conversationId?: string | null;
  actorId?: string | null;
  diagnosticsCategory?: string | null;
  deliveryContext?: OutboundDeliveryContext | null;
  recordConversationTurn?: boolean;
}): OutboundMessageRequestedEvent {
  const {
    actorId = null,
    content,
    conversationId = null,
    correlationId,
    delivery,
    deliveryContext = null,
    diagnosticsCategory = "outbound.delivery",
    participantActorId,
    producerService,
    recordConversationTurn = false
  } = params;
  const routing = toOutboundRouting(delivery);

  return {
    eventId: `${producerService}:outbound:${Date.now()}`,
    eventType: "outbound.message.requested",
    eventVersion: DOT_EVENT_VERSION,
    occurredAt: new Date().toISOString(),
    producer: { service: producerService },
    correlation: {
      correlationId,
      causationId: null,
      conversationId,
      actorId
    },
    routing,
    diagnostics: {
      severity: "info",
      category: diagnosticsCategory
    },
    payload: {
      inResponseToEventId: null,
      participantActorId,
      content,
      recordConversationTurn,
      delivery,
      deliveryContext
    }
  };
}

export function createOutboundMessageDeliveredEvent(params: {
  requestEvent: OutboundMessageRequestedEvent;
  producerService?: string;
  transportMessageId?: string | null;
}): OutboundMessageDeliveredEvent {
  const routing = toOutboundRouting(params.requestEvent.payload.delivery);

  return {
    eventId: `${params.requestEvent.eventId}:delivered:${Date.now()}`,
    eventType: "outbound.message.delivered",
    eventVersion: DOT_EVENT_VERSION,
    occurredAt: new Date().toISOString(),
    producer: { service: params.producerService ?? "discord-egress-service" },
    correlation: {
      correlationId: params.requestEvent.correlation.correlationId,
      causationId: params.requestEvent.eventId,
      conversationId: params.requestEvent.correlation.conversationId,
      actorId: params.requestEvent.correlation.actorId
    },
    routing,
    diagnostics: {
      severity: "info",
      category: "outbound.delivery"
    },
    payload: {
      requestEventId: params.requestEvent.eventId,
      participantActorId: params.requestEvent.payload.participantActorId,
      delivery: params.requestEvent.payload.delivery,
      deliveryContext: params.requestEvent.payload.deliveryContext,
      transportMessageId: params.transportMessageId ?? null
    }
  };
}

export function createOutboundMessageDeliveryFailedEvent(params: {
  requestEvent: OutboundMessageRequestedEvent;
  producerService?: string;
  reason: string;
}): OutboundMessageDeliveryFailedEvent {
  const routing = toOutboundRouting(params.requestEvent.payload.delivery);

  return {
    eventId: `${params.requestEvent.eventId}:failed:${Date.now()}`,
    eventType: "outbound.message.delivery_failed",
    eventVersion: DOT_EVENT_VERSION,
    occurredAt: new Date().toISOString(),
    producer: { service: params.producerService ?? "discord-egress-service" },
    correlation: {
      correlationId: params.requestEvent.correlation.correlationId,
      causationId: params.requestEvent.eventId,
      conversationId: params.requestEvent.correlation.conversationId,
      actorId: params.requestEvent.correlation.actorId
    },
    routing,
    diagnostics: {
      severity: "warn",
      category: "outbound.delivery"
    },
    payload: {
      requestEventId: params.requestEvent.eventId,
      participantActorId: params.requestEvent.payload.participantActorId,
      delivery: params.requestEvent.payload.delivery,
      deliveryContext: params.requestEvent.payload.deliveryContext,
      reason: params.reason
    }
  };
}

function toOutboundRouting(delivery: OutboundDelivery): OutboundMessageRouting {
  if (delivery.kind === "reply") {
    return {
      transport: delivery.transport,
      channelId: delivery.channelId,
      guildId: delivery.guildId,
      replyTo: delivery.replyTo
    };
  }

  return {
    transport: delivery.transport,
    channelId: null,
    guildId: null,
    replyTo: null
  };
}

export function createServiceHealthReportedEvent(params: {
  service: string;
  checkName: string;
  status: ServiceHealthStatus;
  state?: string | null;
  detail?: string | null;
  observedLatencyMs?: number | null;
  sourceEventId?: string | null;
  producerService?: string;
}): ServiceHealthReportedEvent {
  return {
    eventId: `diagnostics.health.reported:${params.service}:${params.checkName}:${Date.now()}`,
    eventType: "diagnostics.health.reported",
    eventVersion: DOT_EVENT_VERSION,
    occurredAt: new Date().toISOString(),
    producer: {
      service: params.producerService ?? params.service
    },
    correlation: {
      correlationId: `diagnostics:${params.service}`,
      causationId: params.sourceEventId ?? null,
      conversationId: null,
      actorId: null
    },
    routing: {
      transport: null,
      channelId: null,
      guildId: null,
      replyTo: null
    },
    diagnostics: {
      severity: params.status === "bad" ? "warn" : "info",
      category: "service.health"
    },
    payload: {
      service: params.service,
      checkName: params.checkName,
      status: params.status,
      state: params.state ?? null,
      detail: params.detail ?? null,
      observedLatencyMs: params.observedLatencyMs ?? null,
      sourceEventId: params.sourceEventId ?? null
    }
  };
}

export function createOutlookMailMessageDetectedEvent(params: {
  message: OutlookMailMessage;
  initialBaseline: boolean;
}): OutlookMailMessageDetectedEvent {
  return {
    eventId: `outlook.mail.message.detected:${params.message.id}:${Date.now()}`,
    eventType: "outlook.mail.message.detected",
    eventVersion: DOT_EVENT_VERSION,
    occurredAt: new Date().toISOString(),
    producer: {
      service: "mail-sync-service"
    },
    correlation: {
      correlationId: `outlook-mail:${params.message.id}`,
      causationId: null,
      conversationId: null,
      actorId: null
    },
    routing: {
      transport: null,
      channelId: null,
      guildId: null,
      replyTo: null
    },
    diagnostics: {
      severity: "info",
      category: "outlook.mail"
    },
    payload: {
      message: params.message,
      initialBaseline: params.initialBaseline
    }
  };
}

export function createEmailActionRequestedEvent(params: {
  actionId: number;
  operation: EmailActionOperation;
  correlationId: string;
  conversationId?: string | null;
  actorId?: string | null;
}): EmailActionRequestedEvent {
  return {
    eventId: `email.action.requested:${params.actionId}:${params.operation}:${Date.now()}`,
    eventType: "email.action.requested",
    eventVersion: DOT_EVENT_VERSION,
    occurredAt: new Date().toISOString(),
    producer: {
      service: "email-workflow"
    },
    correlation: {
      correlationId: params.correlationId,
      causationId: null,
      conversationId: params.conversationId ?? null,
      actorId: params.actorId ?? null
    },
    routing: {
      transport: null,
      channelId: null,
      guildId: null,
      replyTo: null
    },
    diagnostics: {
      severity: "info",
      category: "email.action"
    },
    payload: {
      actionId: params.actionId,
      operation: params.operation
    }
  };
}

export function createEmailActionCompletedEvent(params: {
  requestEvent: EmailActionRequestedEvent;
  status: EmailActionStatus;
  reply: string;
}): EmailActionCompletedEvent {
  return {
    eventId: `${params.requestEvent.eventId}:completed:${Date.now()}`,
    eventType: "email.action.completed",
    eventVersion: DOT_EVENT_VERSION,
    occurredAt: new Date().toISOString(),
    producer: {
      service: "email-actions-service"
    },
    correlation: {
      correlationId: params.requestEvent.correlation.correlationId,
      causationId: params.requestEvent.eventId,
      conversationId: params.requestEvent.correlation.conversationId,
      actorId: params.requestEvent.correlation.actorId
    },
    routing: {
      transport: null,
      channelId: null,
      guildId: null,
      replyTo: null
    },
    diagnostics: {
      severity: params.status === "draft_failed" || params.status === "send_failed" ? "warn" : "info",
      category: "email.action"
    },
    payload: {
      requestEventId: params.requestEvent.eventId,
      actionId: params.requestEvent.payload.actionId,
      operation: params.requestEvent.payload.operation,
      status: params.status,
      reply: params.reply
    }
  };
}
