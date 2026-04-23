import type { Logger } from "pino";
import type { RoutingData, PipelineContext } from "./types.js";
import type { LlmService } from "../chat/llmService.js";
import type { RoutingToolDefinition } from "../tools/mcp/types.js";
import { buildMessageRoutingPrompt } from "../utilities/promptUtility.js";
import { createRouteDataFromCommand } from "./commandHandler.js";


export async function resolveMessageRoute(params: {
    llmService: LlmService;
    context: PipelineContext;
    correlationId: string;
    logger: Logger;
    messageId: string;
    availableTools: RoutingToolDefinition[];
}): Promise<RoutingData> {
    if (params.context.isExplicitCommand) {
        const routeFromCommand = createRouteDataFromCommand(params.context.content);
        if (routeFromCommand.isValid) {
            return routeFromCommand.routingData as RoutingData;
        }
    }

    const prompt = buildMessageRoutingPrompt({
        userMessage: params.context.content, 
        recentConversation: params.context.recentConversation, 
        currentSpeakerLabel: params.context.currentSpeakerLabel, 
        isDotAddressed: params.context.isExplicitCommand,
        availableTools: params.availableTools
    });
    params.logger.info(
        {
            messageId: params.messageId,
            correlationId: params.correlationId,
            conversationId: params.context.conversationId,
            stage: "address.infer.prompt",
            inputUserMessage: params.context.content,
            promptMessages: prompt
        },
        "Intent classification prompt"
    );
    
    const result = await params.llmService.generate(prompt, "gpt-4o-mini");
    params.logger.info(
        {
            messageId: params.messageId,
            correlationId: params.correlationId,
            conversationId: params.context.conversationId,
            stage: "address.infer",
            provider: result.route,
            inputUserMessage: params.context.content,
            promptMessages: result.promptMessages,
            promptMessagesPresent:
                Array.isArray(result.promptMessages) && result.promptMessages.length > 0,
            rawModelOutput: result.rawModelOutput ?? null,
            rawModelOutputPresent:
                typeof result.rawModelOutput === "string" && result.rawModelOutput.length > 0,
            parsedDecision: result.decision
        },
        "Intent classification debug trace"
    );

    return parseMessageRoutingResponse(result);
}

function parseMessageRoutingResponse(response: string): RoutingData {    
    let parsed = JSON.parse(extractJsonObject(response)) as RoutingData;
    if (!parsed) {
        throw new Error("Conversational intent inference returned an invalid response");
    }

    if (!parsed.addressed) {
        return parsed;
    }

    if (!parsed.route || (!parsed.route.name || parsed.route.name.trim() === "")) {
        return {
            addressed: true,
            reason: parsed.reason,
            route: {
                name: "respond",
                reason: "Dot was addressed, but information on how to proceed was either missing, or could not be extracted, from the LLM response. Therefore we'll proceed with a natural language response.",
                instructions: "Respond to the user, asking for clarification on their last message, as you were unable to parse it's meaning or intent."
            }
        }
    }

    let hasValidPathReason = typeof parsed.route.reason === "string" && parsed.route.reason && parsed.reason.trim() !== "";

    if (parsed.route.name === "respond") {
        parsed.route.reason = hasValidPathReason 
            ? parsed.route.reason 
            : "The reason the respond path was chosen is either missing, or could not be extracted, from the LLM response. Therefore we'll proceed with a natural language response.";
        return parsed;
    }

    if (parsed.route.name === "execute_tool") {
        parsed.route.reason = hasValidPathReason ? parsed.route.reason : "The reason execute_tool was chosen is either missing or malformed.";
        return parsed;
    }

    throw new Error("Huh... How'd we reach here?");
}

function extractJsonObject(payload: string): string {
    const trimmed = payload.trim();
    if (trimmed.startsWith("{")) {
        return trimmed;
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
        return trimmed.slice(start, end + 1);
    }

    throw new Error("Tool inference returned non-JSON output");
}
