import type { Logger } from "pino";

import { evaluateDeterministicAddressednessFastPath } from "../discord/addressing.js";
import type { ChatServiceWithOptionalAddressedness, AddressedRouteResult } from "./types.js";
import type { PipelineContext } from "./types.js";

export async function resolveMessageRoute(params: {
    chatService: ChatServiceWithOptionalAddressedness;
    context: PipelineContext;
    correlationId: string;
    logger: Logger;
    messageId: string;
}): Promise<AddressedRouteResult> {
    const deterministicAddressedDecision = evaluateDeterministicAddressednessFastPath({
        message: params.context.incomingMessage,
        isExplicitCommand: params.context.isExplicitCommand,
    });

    if (deterministicAddressedDecision) {
        return {
            addressed: true,
            addressedReason: deterministicAddressedDecision.reason,
            addressedRespondRequiresOwnerChat: false,
            precomputedIntentDecision: null
        };
    }

    if (!params.chatService.inferAddressedToolDecision) {
        throw new Error("Chat service cannot infer addressedness for ambiguous messages");
    }

    const inferredAddressed = await params.chatService.inferAddressedToolDecision(
        params.context.content,
        params.context.recentConversation,
        params.context.currentSpeakerLabel
    );
    params.logger.info(
        {
            messageId: params.messageId,
            correlationId: params.correlationId,
            conversationId: params.context.conversationId,
            stage: "address.infer",
            provider: inferredAddressed.route,
            inputUserMessage: params.context.content,
            promptMessages: inferredAddressed.promptMessages,
            promptMessagesPresent:
                Array.isArray(inferredAddressed.promptMessages) && inferredAddressed.promptMessages.length > 0,
            rawModelOutput: inferredAddressed.rawModelOutput ?? null,
            rawModelOutputPresent:
                typeof inferredAddressed.rawModelOutput === "string" && inferredAddressed.rawModelOutput.length > 0,
            parsedDecision: inferredAddressed.decision
        },
        "Intent classification debug trace"
    );

    if (!inferredAddressed.decision.addressed) {
        return {
            addressed: false,
            addressedReason: "llm_not_addressed",
            addressedRespondRequiresOwnerChat: false,
            precomputedIntentDecision: null
        };
    }

    return {
        addressed: true,
        addressedReason: "llm_addressed",
        addressedRespondRequiresOwnerChat: inferredAddressed.decision.decision === "respond",
        precomputedIntentDecision:
            inferredAddressed.decision.decision === "respond"
                ? null
                : {
                    route: inferredAddressed.route,
                    powerStatus: inferredAddressed.powerStatus,
                    decision: {
                        decision: "execute_tool",
                        toolName: inferredAddressed.decision.toolName,
                        reason: inferredAddressed.decision.reason,
                        confidence: inferredAddressed.decision.confidence,
                        args: inferredAddressed.decision.args
                    }
                }
    };
}
