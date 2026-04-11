import type { ActorRole } from "./auth.js";

export interface CanonicalSender {
  actorId: string;
  displayName: string;
  actorRole: ActorRole;
}

export interface InboundReplyRoute {
  transport: "discord";
  channelId: string;
  guildId: string | null;
  replyToMessageId: string;
}

export interface InboundMessagePayload {
  content: string;
  addressedContent: string;
  isDirectMessage: boolean;
  mentionedBot: boolean;
}

export interface InboundMessageReceivedEvent {
  eventId: string;
  eventType: "inbound.message.received";
  occurredAt: string;
  transport: "discord";
  conversationId: string;
  sourceMessageId: string;
  correlationId: string;
  sender: CanonicalSender;
  replyRoute: InboundReplyRoute;
  payload: InboundMessagePayload;
}

export interface OutboundMessageRequestedEvent {
  eventId: string;
  eventType: "outbound.message.requested";
  occurredAt: string;
  transport: "discord";
  conversationId: string;
  correlationId: string;
  inResponseToEventId: string;
  participantActorId: string;
  replyRoute: InboundReplyRoute;
  content: string;
  recordConversationTurn: boolean;
}

export function createOutboundMessageRequestedEvent(params: {
  inboundEvent: InboundMessageReceivedEvent;
  content: string;
  recordConversationTurn?: boolean;
}): OutboundMessageRequestedEvent {
  const { inboundEvent, content, recordConversationTurn = false } = params;

  return {
    eventId: `${inboundEvent.eventId}:outbound:${Date.now()}`,
    eventType: "outbound.message.requested",
    occurredAt: new Date().toISOString(),
    transport: inboundEvent.transport,
    conversationId: inboundEvent.conversationId,
    correlationId: inboundEvent.correlationId,
    inResponseToEventId: inboundEvent.eventId,
    participantActorId: inboundEvent.sender.actorId,
    replyRoute: inboundEvent.replyRoute,
    content,
    recordConversationTurn
  };
}
