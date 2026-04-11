import type { ActorRole } from "./auth.js";

export const DOT_EVENT_VERSION = "1.0.0";

export const DOT_EVENT_TOPICS = [
  "inbound.message.received",
  "outbound.message.requested",
  "diagnostics.health.reported",
  "discord.message.received",
  "discord.message.delivery.requested",
  "llm.reply.generated",
  "outlook.calendar.query.completed",
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
  inResponseToEventId: string;
  participantActorId: string;
  content: string;
  recordConversationTurn: boolean;
  replyRoute: InboundReplyRoute;
}

export type OutboundMessageRequestedEvent = DotEvent<
  "outbound.message.requested",
  OutboundMessageRequestedPayload,
  InboundReplyRoute
>;

export function createOutboundMessageRequestedEvent(params: {
  inboundEvent: InboundMessageReceivedEvent;
  content: string;
  recordConversationTurn?: boolean;
}): OutboundMessageRequestedEvent {
  const { inboundEvent, content, recordConversationTurn = false } = params;

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
      replyRoute: inboundEvent.payload.replyRoute,
      content,
      recordConversationTurn
    }
  };
}
