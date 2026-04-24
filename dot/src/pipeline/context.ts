import type { InboundMessageReceivedEvent } from "../events.js";
import type { Persistence } from "../persistence.js";
import type { IncomingMessage } from "../types.js";
import type { PipelineContext } from "./types.js";
import { isRegisteredExplicitCommand } from "./commandHandler.js";

const RECENT_CHAT_HISTORY_LIMIT = 20;

export function buildPipelineContext(params: {
    event: InboundMessageReceivedEvent;
    persistence: Persistence;
}): Promise<PipelineContext> {
    const conversationId = params.event.correlation.conversationId ?? "";
    return Promise.resolve(params.persistence.listRecentConversationTurns(conversationId, RECENT_CHAT_HISTORY_LIMIT)).then((recentConversation) => ({
        event: params.event,
        content: params.event.payload.content.trim(),
        conversationId,
        currentSpeakerLabel: formatCurrentSpeakerLabel(params.event),
        incomingMessage: mapInboundEventToIncomingMessage(params.event),
        isExplicitCommand: isValidExplicitCommand(params.event.payload.addressedContent.trim()),
        recentConversation
    }));
}

function mapInboundEventToIncomingMessage(event: InboundMessageReceivedEvent): IncomingMessage {
    return {
        id: event.payload.messageId,
        channelId: event.correlation.conversationId ?? "",
        guildId: event.payload.replyRoute.guildId,
        authorId: event.payload.sender.actorId,
        authorUsername: event.payload.sender.displayName,
        content: event.payload.content,
        isDirectMessage: event.payload.isDirectMessage,
        mentionedBot: event.payload.mentionedBot,
        repliedToMessageId: event.payload.repliedToMessageId,
        repliedToBot: event.payload.repliedToBot,
        createdAt: event.occurredAt
    };
}

function isValidExplicitCommand(content: string): boolean {
    return isRegisteredExplicitCommand(content);
}

function formatCurrentSpeakerLabel(event: InboundMessageReceivedEvent): string {
    const displayName = event.payload.sender.displayName;
    const actorId = event.payload.sender.actorId;

    switch (event.payload.sender.actorRole) {
        case "owner":
            return displayName ? `Owner::${displayName}//${actorId}` : "Owner";
        default:
            return displayName ? `User::${displayName}//${actorId}` : `User::UNKNOWN`;
    }
}
