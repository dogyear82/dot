import { createSystemOutboundMessageRequestedEvent, type OutboundDeliveryContext, type OutboundMessageRequestedEvent } from "./events.js";

export function createOwnerDiscordDirectMessageNotification(params: {
  content: string;
  ownerUserId: string;
  producerService: string;
  correlationId: string;
  actorId?: string | null;
  conversationId?: string | null;
  deliveryContext?: OutboundDeliveryContext | null;
  recordConversationTurn?: boolean;
  diagnosticsCategory?: string | null;
}): OutboundMessageRequestedEvent {
  const {
    actorId = null,
    content,
    conversationId = null,
    correlationId,
    deliveryContext = null,
    diagnosticsCategory = "outbound.notification",
    ownerUserId,
    producerService,
    recordConversationTurn = false
  } = params;

  return createSystemOutboundMessageRequestedEvent({
    content,
    participantActorId: ownerUserId,
    delivery: {
      transport: "discord",
      kind: "direct-message",
      channelId: null,
      guildId: null,
      replyTo: null,
      recipientActorId: ownerUserId
    },
    producerService,
    correlationId,
    actorId,
    conversationId,
    deliveryContext,
    recordConversationTurn,
    diagnosticsCategory
  });
}
