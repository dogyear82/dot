import { isEmailCommand } from "../tools/email/command.js";
import type { InboundMessageReceivedEvent } from "../events.js";
import type { Persistence } from "../persistence.js";
import { isNewsPreferencesCommand } from "../newsPreferences.js";
import { isSettingsCommand } from "../onboarding.js";
import { isCalendarCommand } from "../outlookCalendar.js";
import { isPersonalityCommand } from "../personality.js";
import { isReminderCommand } from "../reminders.js";
import { parseExplicitToolDecision } from "../toolInvocation.js";
import type { IncomingMessage, PendingConversationalToolSessionRecord } from "../types.js";
import { isContactCommand, isPolicyCommand } from "../contacts.js";
import type { PipelineContext } from "./types.js";

const RECENT_CHAT_HISTORY_LIMIT = 10;
const PENDING_TOOL_SESSION_TTL_MS = 15 * 60 * 1000;

export function buildPipelineContext(params: {
    event: InboundMessageReceivedEvent;
    persistence: Persistence;
}): PipelineContext {
    const conversationId = params.event.correlation.conversationId ?? "";
    return {
        event: params.event,
        content: params.event.payload.addressedContent.trim(),
        conversationId,
        currentSpeakerLabel: formatCurrentSpeakerLabel(params.event),
        incomingMessage: mapInboundEventToIncomingMessage(params.event),
        isExplicitCommand: isValidExplicitCommand(params.event.payload.addressedContent.trim()),
        recentConversation: params.persistence.listRecentConversationTurns(conversationId, RECENT_CHAT_HISTORY_LIMIT)
    };
}

function getPendingToolSession(
    persistence: Persistence,
    conversationId: string
): PendingConversationalToolSessionRecord | null {
    if (!conversationId) {
        return null;
    }

    const session = persistence.getPendingConversationalToolSession(conversationId);
    if (!session) {
        return null;
    }

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
        persistence.clearPendingConversationalToolSession(conversationId);
        return null;
    }

    return session;
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
    return (
        isSettingsCommand(content) ||
        isNewsPreferencesCommand(content) ||
        isPersonalityCommand(content) ||
        isContactCommand(content) ||
        isPolicyCommand(content) ||
        isEmailCommand(content) ||
        isCalendarCommand(content) ||
        isReminderCommand(content) ||
        parseExplicitToolDecision(content) !== null
    );
}

function formatCurrentSpeakerLabel(event: InboundMessageReceivedEvent): string {
    const displayName = event.payload.sender.displayName;
    const actorId = event.payload.sender.actorId;

    switch (event.payload.sender.actorRole) {
        case "owner":
            return displayName ? `Owner (${displayName})` : "Owner";
        case "non-owner":
            return displayName ? `Participant (${displayName})` : `Participant (${actorId})`;
        default:
            return displayName ? `User (${displayName})` : `User (${actorId})`;
    }
}

export { PENDING_TOOL_SESSION_TTL_MS };
