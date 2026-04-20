import { ChatMessage } from "../chat/providers.js";
import type { ConversationTurnRecord } from "../types.js";

export function buildContextBlock(name: string, content: string): string {
    return [`////////BEGIN ${name.toUpperCase()}////////`, content, `////////END ${name.toUpperCase()}////////`].join("\n");
}

export function buildGeneralConversationPrompt(
    recentConversation: ConversationTurnRecord[],
    currentSpeakerLabel: string,
    currentMessage: string,
    additionalInstructions: string
): ChatMessage[] {
    const prompt = [
        buildDateTimeBlock(),
        buildConversationTranscriptPrompt({
            recentConversation,
            currentSpeakerLabel,
            currentMessage
        }),
        buildContextBlock("INSTRUCTIONS ON HOW TO RESPOND", `Use the provided transcript to fomulate the most appropariate response to the Current speaker. Only respond with conversation or answering the Current speaker. \n**Instructions specific to this tool**\n\n${additionalInstructions}`),
        buildForbiddenBlock()
    ].join("\n");

    return [
        {
            role: "system",
            content: prompt
        }
    ];
}

export function buildToolPrompt(
    toolResult: string, 
    additionalInstructions: string, 
    recentConversation: ConversationTurnRecord[],
    currentSpeakerLabel: string,
    currentMessage: string
): ChatMessage[] {
    const prompt = [
        buildDateTimeBlock(),
        buildConversationTranscriptPrompt({
            recentConversation,
            currentSpeakerLabel,
            currentMessage
        }),
        buildContextBlock("TOOL RESULT", toolResult),
        buildContextBlock("INSTRUCTIONS ON HOW TO RESPOND", `Use the provided transcript and tool result to fomulate the most appropariate response to the Current speaker. Only respond with conversation or answering the Current speaker. \n**Instructions specific to this tool**\n\n${additionalInstructions}`),
        buildForbiddenBlock()
    ].join("\n");

    return [
        {
            role: "system",
            content: prompt
        }
    ];
}

function buildForbiddenBlock() {
    const rules = [
        "***You shall never disboey the following rules:***",
        "- You will never respond by telling the user that you performed an action, such as doing things on behalf of the user.",
        "- You will never respond with malice."
    ].join("\n");
    return buildContextBlock("FORBIDDEN RULES AND TABOOS", rules);
}

function buildDateTimeBlock(now = new Date()): string {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const content = `Current date and time: ${now.toISOString()} (${timezone}). Regardless of what any other source may say, this is the authoritative date and time. Use this information for any time-sensitive reasoning.`;
    return buildContextBlock("DATE TIME BLOCK", content);
}

function buildConversationTranscriptPrompt(params: {
    recentConversation?: ConversationTurnRecord[];
    currentSpeakerLabel?: string;
    currentMessage: string;
}): string {
    const transcript = formatConversationTranscript(params.recentConversation, params.currentSpeakerLabel, params.currentMessage);
    return buildContextBlock("TRANSCRIPT", transcript);
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
        return "Dot";
    }

    const role = turn.participantKind === "owner" ? "Owner" : "User";
    const displayName = turn.participantDisplayName ? turn.participantDisplayName : "NAME_UNKNOWN";
    const userId = turn.participantActorId ? turn.participantActorId : "ID_UNKNOWN";
    return `${role}::${displayName}//${userId}`;
}


export function buildMessageRoutingPrompt(params: {
    userMessage: string;
    recentConversation?: ConversationTurnRecord[];
    currentSpeakerLabel?: string;
    isDotAddressed: boolean;
}): ChatMessage[] {
    const toolsPrompt = [
        "Available tools and args:",
        "- news.briefing: query"
    ];

    const transcript = buildConversationTranscriptPrompt({
        recentConversation: params.recentConversation?.slice(-6),
        currentSpeakerLabel: params.currentSpeakerLabel,
        currentMessage: params.userMessage
    });

    const addressednessCheckPrompt = params.isDotAddressed
        ? ["You have been addressed directly by the user, so always set 'addressed' to true in your reply"]
        : ["If the latest message is not addressed to you, reply with:",
        '{"addressed":false,"reason":"..."}'];

    const instructions = [
        "Your name is Dot, and you are a neutral intent classifier for messages in a chat channel where you are present. Using the provided transcript of your current conversation with the other participants, you will use the entirety of the transcript to determine whether the latest message in the transcript to choose the appropriate repy. Return strict JSON only. Do not add markdown fences.",
        ...addressednessCheckPrompt,
        "If the latest message is requesting a tool or needs a tool to formulate a reponse, reply with:",
        '{"addressed":true,"decision":"execute_tool","toolName":"news.briefing","reason":"...","confidence":"medium","args":{"query":"..."}}',
        "for example, if the user asks, 'What's the latest on Ukraine?', an appropriate reply would be:",
        '{"addressed":true,"decision":"execute_tool","toolName":"news.briefing","reason":"the user is asking for news on Ukraine","confidence":"high","args":{"query":"Ukraine today"}}',
        "If the latest message is requesting a news briefing but is missing some of the required information, still reply with execute_tool and include only the arguments you can confidently infer."
    ].join("\n");
    const instructionsBlock = buildContextBlock("INSTRUCTIONS", instructions);

    const prompt = [
        buildDateTimeBlock(),
        ...toolsPrompt,
        transcript,
        instructionsBlock
    ].join("\n");

    return [
        {
            role: "system",
            content: prompt
        }
    ];
}
