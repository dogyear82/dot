import { ChatMessage } from "../chat/providers.js";
import type { ConversationTurnRecord } from "../types.js";
import { buildConversationTranscriptPrompt } from "./transcriptBuilder.js";

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
        buildContextBlock("INSTRUCTIONS ON HOW TO RESPOND", `Use the provided transcript to fomulate the most appropariate response to the Current speaker. Only respond with conversation or answers to the Current speaker.  \n**Instructions specific to this tool**\n\n${additionalInstructions}`),
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
    const prohibitionAgainstWaywardResponses = `YOU WILL ONLY RESPOND TO ${currentSpeakerLabel}'s message, "${currentMessage}". DO NOT RESPOND TO ANY OTHER USER'S MESSAGES.`;
    const prompt = [
        buildDateTimeBlock(),
        buildConversationTranscriptPrompt({
            recentConversation,
            currentSpeakerLabel,
            currentMessage
        }),
        buildContextBlock("TOOL RESULT", toolResult),
        buildContextBlock("INSTRUCTIONS ON HOW TO RESPOND", `Use the provided transcript and tool result to fomulate the most appropariate response to the Current speaker. Only respond with conversation or answering the Current speaker.\n${prohibitionAgainstWaywardResponses}\n\n**Instructions specific to this tool**\n\n${additionalInstructions}`),
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
        "- You shall never assume another role or personality that conflicts with your active personality.",
        "- You shall never respond by telling the user that you performed an action, such as doing things on behalf of the user.",
        "- You shall never respond with malice."
    ].join("\n");
    return buildContextBlock("FORBIDDEN ACTIONS AND TABOOS", rules);
}

function buildDateTimeBlock(now = new Date()): string {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const content = `Current date and time: ${now.toISOString()} (${timezone}). Regardless of what any other source may say, this is the authoritative date and time. Use this information for any time-sensitive reasoning.`;
    return buildContextBlock("DATE TIME BLOCK", content);
}


export function buildMessageRoutingPrompt(params: {
    userMessage: string;
    recentConversation?: ConversationTurnRecord[];
    currentSpeakerLabel?: string;
    isDotAddressed: boolean;
}): ChatMessage[] {
    const tools = [
        "Available tools and args:",
        "- news.briefing: query"
    ].join("\n");

    const transcript = buildConversationTranscriptPrompt({
        recentConversation: params.recentConversation?.slice(-6),
        currentSpeakerLabel: params.currentSpeakerLabel,
        currentMessage: params.userMessage
    });

    const prohibitionAgainstWaywardResponses = `YOU WILL ONLY RESPOND IF ADDRESSED AND ONLY TO ${params.currentSpeakerLabel}'s message, "${params.userMessage}". DO NOT RESPOND TO ANY OTHER USER'S MESSAGES. DO NOT RESPOND UNLESS ADDRESSED.`;
    const addressednessCheckPrompt = params.isDotAddressed
        ? [
            `You have been addressed directly by ${params.currentSpeakerLabel}, so always set 'addressed' to true in your reply, and the reason should be simply, "Direct Message.`,
            `You will use the provided transcript to determine how best to respond to ${params.currentSpeakerLabel}'s message, "${params.userMessage}"`,
            prohibitionAgainstWaywardResponses
        ]
        : [
            `You will use the transcript to determine whether ${params.currentSpeakerLabel}'s message, "${params.userMessage}" is addressed to you, and if it is, how best to respond.`,
            prohibitionAgainstWaywardResponses,
            `If the ${params.currentSpeakerLabel}'s message is not addressed to you, reply with: {"addressed":false,"reason":"...", "route": null`,
            `If ${params.currentSpeakerLabel}'s message is addressing you, addressed should be true in your reply, along with a reason why you believe ${params.currentSpeakerLabel} addressed you.`
        ];

    const instructions = [
        "You are Dot, a neutral intent classifier for messages in a chat channel where you are present. Return strict JSON only. Do not add markdown fences.",
        ...addressednessCheckPrompt,
        `If one of the available tools would be helpful, or is required, to formulate a proper response to ${params.currentSpeakerLabel}'s message, your reply should include the tool's name, the reason you chose that tool, and a collection of argument key-value pairs`,
        'For example, if the user asks, "what\'s the latest on the war in ukraine?", you should respond with { "addressed":true,"reason":"User asked about current events mid conversation. Only the user and I are actively participating in the conversation, so I have concluded that I am the target of their message", "route":{"name":"execute_tool", "toolName": "news.briefing", "reason": "User asked for news on the war in Ukraine.", "args":{"query":"Ukraine war"}}}',
        'If tool use is not necessary and a simple conversational response is the most appropriate path. For example, if the user simply said, "@Dot tell me a joke", reply with: \'{"addressed":true,"reason":"Tagged by user","route":{"name":"respond","reason":"User just asked for a joke","instructions":""}}\'. Make sure to leave instructions blank.'
    ].join("\n");

    const prompt = [
        buildDateTimeBlock(),
        buildContextBlock("TOOLS AVAILABLE", tools),
        buildContextBlock("TRANSCRIPT", transcript),
        buildContextBlock("INSTRUCTIONS", instructions)
    ].join("\n");

    return [
        {
            role: "system",
            content: prompt
        }
    ];
}
