import { executeTool, ToolContext } from "../toolExecutor.js";
import type { ConversationTurnRecord } from "../types.js";
import { LlmService } from "../chat/llmService.js";
import { buildToolPrompt } from "../utilities/promptUtility.js";

export async function getToolResponse(
    toolName: string,
    args: Record<string, string | number>,
    messages: ConversationTurnRecord[],
    currentSpeakerLabel: string,
    currentMessage: string,
    context: ToolContext,
    llmService: LlmService
): Promise<{ success: boolean, response: string }> {
    const toolResult = await executeTool(toolName, args, context);
    if (toolResult.success) {                                    
        const toolResponse = toolResult.isPrompt
            ? await llmService.generate(buildToolPrompt(toolResult.result, toolResult.additionalInstructions?? "", messages, currentSpeakerLabel, currentMessage))
            : toolResult.result;
        return toolResponse;
    }

    return {
        success: false,
        response: ""
    };
}
