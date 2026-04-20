import { createOutboundMessageRequestedEvent, type InboundMessageReceivedEvent } from "../events.js";
import type { EventBus } from "../eventBus.js";
import type { Persistence } from "../persistence.js";
import type { ReplyPublisher } from "./types.js";

export function createReplyPublisher(params: {
    bus: EventBus;
    content: string;
    conversationId: string;
    event: InboundMessageReceivedEvent;
    persistence: Persistence;
}): ReplyPublisher {
    let hasSavedUserTurn = false;

    const saveUserConversationTurn = () => {
        if (hasSavedUserTurn || !params.content) {
            return;
        }

        params.persistence.saveConversationTurn({
            conversationId: params.conversationId,
            role: "user",
            participantActorId: params.event.payload.sender.actorId,
            participantDisplayName: params.event.payload.sender.displayName,
            participantKind: params.event.payload.sender.actorRole,
            content: params.content,
            sourceMessageId: params.event.payload.messageId,
            createdAt: params.event.occurredAt
        });
        hasSavedUserTurn = true;
    };

    return {
        saveUserConversationTurn,
        async publishReply(reply: string, route: LlmRoute = "none", recordConversationTurn = true) {
            if (recordConversationTurn) {
                saveUserConversationTurn();
            }

            await params.bus.publishOutboundMessage(
                createOutboundMessageRequestedEvent({
                    inboundEvent: params.event,
                    content: reply,
                    recordConversationTurn
                })
            );
        }
    };
}
