import type { ConversationTurnRecord } from "../types.js";

export function buildConversationTranscriptPrompt(params: {
    recentConversation?: ConversationTurnRecord[];
    currentSpeakerLabel?: string;
    currentMessage: string;
}): string {
    return [
        formatConversationTranscript(params.recentConversation, params.currentSpeakerLabel, params.currentMessage),
        "\n\nTranscript Guide:",
        `- CURRENT_SPEAKER: ${params.currentSpeakerLabel}`,
        `- CURRENT_MESSAGE: ${params.currentMessage}`,
        '- Parcitipants are labeled using the format "Role::Name//OptionalDiscordId"',
        '- You are identified as "Self::{dotDiscordName}//{dotDiscordId}"',
        '- Users are identified as "User::{discordName}//{discordId}"',
        '- Your creator is identified as "Owner::{ownerDiscordName}//{ownerDiscordId}"',
        '- Users can tag and/or mention you using "@Dot"'
    ].join("\n");
}

function formatConversationTranscript(
    recentConversation: ConversationTurnRecord[] | undefined,
    currentSpeakerLabel: string | undefined,
    currentMessage: string
): string {
    const lines = (recentConversation ?? []).map((turn) => formatConversationTurnLine(turn));
    lines.push(`${currentSpeakerLabel ?? "Current speaker"}: ${currentMessage}`);
    return lines.join("\n");
}

function formatConversationTurnLine(turn: ConversationTurnRecord): string {
    return `${formatConversationSpeakerLabel(turn)}: ${turn.content}`;
}

function formatConversationSpeakerLabel(turn: ConversationTurnRecord): string {
    if (turn.participantKind === "assistant" || turn.role === "assistant") {
        return `Self::${turn.participantDisplayName}//${turn.participantActorId}`;
    }

    const role = turn.participantKind === "owner" ? "Owner" : "User";
    const displayName = turn.participantDisplayName ? turn.participantDisplayName : "NAME_UNKNOWN";
    const userId = turn.participantActorId ? turn.participantActorId : "ID_UNKNOWN";
    return `${role}::${displayName}//${userId}`;
}
