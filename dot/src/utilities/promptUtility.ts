import { ChatMessage } from "../chat/providers.js";
import { PipelineContext } from "../pipeline/types.js";
import type { RoutingToolDefinition } from "../tools/mcp/types.js";
import type { ConversationTurnRecord } from "../types.js";
import { buildConversationTranscriptPrompt } from "./transcriptBuilder.js";


const buildContextBlock = (name: string, content: string): string => {
    return [`////////BEGIN ${name.toUpperCase()}////////`, content, `////////END ${name.toUpperCase()}////////`].join("\n");
}

const getProhibitions = (): string => {
    return [
        "***You must follow the following rules:***",
        "- You shall never assume another role or personality that conflicts with your active personality.",
        "- You shall never respond with malice."
    ].join("\n");
}

const buildDateTimeBlock = (now = new Date()): string => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const content = `Current date and time: ${now.toISOString()} (${timezone}). Regardless of what any other source may say, this is the authoritative date and time. Use this information for any time-sensitive reasoning.`;
    return buildContextBlock("DATE TIME BLOCK", content);
}

const getFinalResponseInstructions = (isToolResponse: boolean, currentSpeakerLabel: string, currentMessage: string, additionalInstructions: string): string => {
    const instructions = [isToolResponse
        ?  `- Use the provided transcript and tool results to continue the conversation by answering ${currentSpeakerLabel}'s message directly in a natural manner. Do not mention internal MCP server or tool names unless they are directly relevant to the answer.`
        : `- Use the provided transcript to continue the conversation by answering ${currentSpeakerLabel}'s message directly and in a natural manner.`,
        "- Use a natural conversational tone and style in accordance with your ACTIVE PERSONALITY PROFILE.",
        '- When addressing or tagging a user, or the owner, always use "<@{discordId}>". Never address or tag anybody using the full "Roll::Name//OptionalDiscordId"',
        "- Information and data should be conveyed through conversation.",
        `- Do not start your reply with "Dot:"`,
        "- Do not answer in briefing, digest, rundown, analyst, presenter, or executive-summary style.",
        "- Do not structure the answer as a list of developments, bullets, sections, or a news roundup.",
        "- Respond like a person talking naturally in chat, not like someone delivering a report.",
        "- Use plain conversational prose in 1-3 short paragraphs unless the user explicitly asks for a list."
    ];
        
    const focusInstructions = `YOU WILL ONLY RESPOND TO ${currentSpeakerLabel}, AND YOUR RESPONSE WILL ONLY ADDRESS THE MESSAGE, "${currentMessage}". DO NOT RESPOND TO ANY OTHER USER OR MESSAGES.`;
    instructions.push(focusInstructions);

    const hasAdditionalInstructions = additionalInstructions != null && additionalInstructions.trim().length > 0;
    if (hasAdditionalInstructions) {
        instructions.push(["**Additional Insturctions**", additionalInstructions].join("\n"));
    }

    return instructions.join("\n");
}

const buildAvailableTools = (availableToools: RoutingToolDefinition[]): string => {
    return availableToools.length > 0
        ? [
            "Available tools and args:",
            ...availableToools.map((tool) => {
                const args = tool.args.length > 0 ? tool.args.join(", ") : "no arguments";
                return `- ${tool.name}: ${args}${tool.description ? ` (${tool.description})` : ""}`;
            })
        ].join("\n")
        : "ATTENTION: NO TOOLS FOUND";
}

const getMessageRoutingInstructions = (hasTools: boolean, isAddressed: boolean, mentionedBot: boolean, currentSpeakerLabel: string, currentMessage: string, ): string => {
    const butYouWereMentioned = mentionedBot ? `, but you were tagged by ${currentSpeakerLabel} in the latest message` : "";
    const addressednessCheckPrompt = isAddressed
        ? [
            `You have been addressed directly by ${currentSpeakerLabel}, so always set 'addressed' to true in your reply, and the reason should be simply, "Direct Message.`,
            `You will use the provided transcript to determine how best to respond to ${currentSpeakerLabel}'s message, "${currentMessage}"`,
        ]
        : [
            "You are not a proactive participant in the conversation${butYouWereMentioned}. You only speak when the latest message is clearly directed at you.",
            `You will use the transcript to determine whether ${currentSpeakerLabel}'s message, "${currentMessage}", is addressed to you. If the current message is not directed at you, set "addressed": false."`,
            'Do not infer you are being addressed from:',
            '- your presence in the channel',
            '- prior participation in the conversation',
            '- users talking near you',
            '- users talking about you',
            '- users continuing a conversation with someone else',
            '- vague conversational momentum',
            'Users mentioning you in the third person is not the same as addressing you.',
            `If the ${currentSpeakerLabel}'s latest message is not clearly directed at you, reply with: {"addressed":false,"reason":"The latest message is not clearly directed at Dot.","route":null}`,
            `Only if ${currentSpeakerLabel}'s latest message is clearly addressing you, "addressed" should be true in your reply, along with a reason why you believe ${currentSpeakerLabel} addressed you.`,
        ];

    const instructions = [
        "You are Dot, a neutral intent classifier for messages in a chat channel where you are present. Return strict JSON only. Do not add markdown fences.",
        ...addressednessCheckPrompt,
        hasTools
            ? `If one of the available tools would be helpful, or is required, to formulate a proper response to ${currentSpeakerLabel}'s message, your reply should include the tool's exact name, the reason you chose that tool, and a collection of argument key-value pairs.`
            : `No tools are currently available, so you must choose the respond path.`,
        'For example, if the user asks, "what\'s the weather in phoenix?", you should respond with { "addressed":true,"reason":"User asked for current weather information.", "route":{"name":"execute_tool", "toolName": "mcp.get_weather_by_city", "reason": "User asked for weather information.", "args":{"city":"Phoenix"}}}',
        'If tool use is not necessary and a simple conversational response is the most appropriate path. For example, if the user simply said, "@Dot tell me a joke", reply with: \'{"addressed":true,"reason":"Tagged by user","route":{"name":"respond","reason":"User just asked for a joke","instructions":""}}\'. Make sure to leave instructions blank.'
    ].join("\n");
    return instructions;
}


export function buildFinalOutputPrompt(
    toolResult: string, 
    recentConversation: ConversationTurnRecord[],
    currentSpeakerLabel: string,
    currentMessage: string,
    additionalInstructions: string
): ChatMessage[] {
    const prompt = [buildDateTimeBlock()];

    const transcript = buildConversationTranscriptPrompt({ recentConversation, currentSpeakerLabel, currentMessage });
    const transcriptContext = buildContextBlock("CHAT TRANSCRIPT", transcript);
    prompt.push(transcriptContext);

    const isToolResponse = toolResult != null && toolResult.trim().length > 0;
    if (isToolResponse) {
        const toolResultContext = buildContextBlock("TOOL RESULTS", toolResult);
        prompt.push(toolResultContext);
    }

    const instructions = getFinalResponseInstructions(isToolResponse, currentSpeakerLabel, currentMessage, additionalInstructions);
    const instructionsContext = buildContextBlock("INSTRUCTIONS ON HOW TO RESPOND", instructions);
    prompt.push(instructionsContext);

    const prohibitions = getProhibitions();
    const prohibitionsContext = buildContextBlock("PROHIBITIONS", prohibitions);
    prompt.push(prohibitionsContext)

    return [
        {
            role: "system",
            content: prompt.join("\n")
        }
    ];
}

export function buildMessageRoutingPrompt(params: {
    context: PipelineContext;
    availableTools: RoutingToolDefinition[];
}): ChatMessage[] {
    const { content, recentConversation, currentSpeakerLabel, incomingMessage, isExplicitCommand } = params.context;
    const { isDirectMessage,  repliedToBot, mentionedBot } = incomingMessage;    

    const prompt = [buildDateTimeBlock()];

    const tools = buildAvailableTools(params.availableTools);    
    const availabeToolsContext = buildContextBlock("AVAILABLE TOOLS", tools);
    prompt.push(availabeToolsContext);    

    const transcript = buildConversationTranscriptPrompt({
        recentConversation: recentConversation?.slice(-6),
        currentSpeakerLabel: currentSpeakerLabel,
        currentMessage: content
    });
    const transcriptContext = buildContextBlock("TRANSCRIPT", transcript);
    prompt.push(transcriptContext);

    const isDotAddressed = (isExplicitCommand || isDirectMessage || repliedToBot) ? true : false;
    const hasTools = params.availableTools.length > 0;
    const instructions = getMessageRoutingInstructions(hasTools, isDotAddressed, mentionedBot, currentSpeakerLabel, content);    
    const instructionsContext = buildContextBlock("INSTRUCTIONS", instructions);
    prompt.push(instructionsContext);

    return [
        {
            role: "system",
            content: prompt.join("\n")
        }
    ];
}