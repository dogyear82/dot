import type { Logger } from "pino";

import type { ChatService } from "../chat/modelRouter.js";
import { recordToolExecution } from "../observability.js";
import type { Persistence } from "../persistence.js";
import type { GroundedAnswerService, MessageRoute } from "../toolInvocation.js";
import { executeTool } from "../toolExecutor.js";
import type { WorldLookupSourceName,  } from "../types.js";
import type { WorldLookupAdapter } from "../worldLookup.js";
import type { WeatherLookupClient } from "../weatherLookup.js";
import type { ReplyPublisher } from "./types.js";

export async function executeInferredToolOrConversation(params: {
    calendarClient: import("../outlookCalendar.js").OutlookCalendarClient;
    chatService: ChatService;
    content: string;
    conversationId: string;
    currentSpeakerLabel: string;
    event: import("../events.js").InboundMessageReceivedEvent;
    groundedAnswerService?: GroundedAnswerService;
    logger: Logger;
    persistence: Persistence;
    messageRoute: MessageRoute | null;
    publisher: ReplyPublisher;
    recentConversation: import("../types.js").ConversationTurnRecord[];
    weatherClient?: WeatherLookupClient;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
}): Promise<{ pipelineOutcome: string }> {

    try {
        const inferred = params.messageRoute
            ? params.messageRoute
            : await params.chatService.inferToolDecision(
                params.content,
                params.recentConversation,
                params.currentSpeakerLabel
            );

        if (!params.messageRoute) {
            params.logger.info(
                {
                    messageId: params.event.payload.messageId,
                    correlationId: params.event.correlation.correlationId,
                    conversationId: params.conversationId,
                    stage: "tool.infer",
                    provider: inferred.name,
                    inputUserMessage: params.content,
                    promptMessages: "promptMessages" in inferred ? inferred.promptMessages : undefined,
                    promptMessagesPresent:
                        "promptMessages" in inferred &&
                        Array.isArray(inferred.promptMessages) &&
                        inferred.promptMessages.length > 0,
                    rawModelOutput: "rawModelOutput" in inferred ? inferred.rawModelOutput ?? null : null,
                    rawModelOutputPresent:
                        "rawModelOutput" in inferred &&
                        typeof inferred.rawModelOutput === "string" &&
                        inferred.rawModelOutput.length > 0,
                    parsedDecision: inferred.decision
                },
                "Intent classification debug trace"
            );
        }

        if (inferred.decision.decision === "respond") {
            params.persistence.saveToolExecutionAudit({
                messageId: params.event.payload.messageId,
                toolName: "respond",
                invocationSource: "inferred",
                status: "executed",
                provider: inferred.route,
                detail: `decision=${inferred.name.decision}; reason=${inferred.decision.reason}`
            });
            recordToolExecution({ toolName: "respond", status: "executed" });
            await params.publisher.publishReply(inferred.decision.response, inferred.route);

            return { pipelineOutcome: "owner_chat" };
        }

        const result = await executeTool(
            inferred.decision.toolName,
            Object.entries(inferred.decision.args).map(([key, value]) => `${key}=${String(value)}`),
            {
                calendarClient: params.calendarClient,
                persistence: params.persistence,
                conversationId: params.conversationId,
                userMessage: params.content,
                worldLookupAdapters: params.worldLookupAdapters,
                weatherClient: params.weatherClient
            }
        );

        const reply = result.success ? result.result : result.reason;
        const executionStatus = result.success ? "executed" : "failed";

        params.persistence.saveToolExecutionAudit({
            messageId: params.event.payload.messageId,
            toolName: inferred.decision.toolName,
            invocationSource: "inferred",
            status: executionStatus,
            provider: inferred.route,
            detail: inferred.decision.reason
        });
        recordToolExecution({
            toolName: inferred.decision.toolName,
            status: executionStatus
        });
        params.logger.info(
            {
                route: inferred.route,
                messageId: params.event.payload.messageId,
                toolName: inferred.decision.toolName,
                status: executionStatus
            },
            "Executed inferred tool decision"
        );
        await params.publisher.publishReply(reply, inferred.route);

        return { pipelineOutcome: result.success ? "tool_execute" : "tool_failed" };
    } catch (error) {
        params.persistence.saveToolExecutionAudit({
            messageId: params.event.payload.messageId,
            toolName: "conversation-intent",
            invocationSource: "inferred",
            status: "failed",
            provider: null,
            detail: error instanceof Error ? error.message : "unknown inference failure"
        });
        recordToolExecution({ toolName: "conversation-intent", status: "failed" });

        params.logger.warn(
            { err: error, messageId: params.event.payload.messageId },
            "Conversational intent classification failed; falling back to chat"
        );
        await params.publisher.saveUserConversationTurn();
        const updatedConversation = params.persistence.listRecentConversationTurns(params.conversationId, 10);
        const response = await params.chatService.generateOwnerReply({
            userMessage: params.content,
            recentConversation: updatedConversation.slice(0, -1),
            currentSpeakerLabel: params.currentSpeakerLabel
        });
        params.logger.info(
            { route: response.route, powerStatus: response.powerStatus, messageId: params.event.payload.messageId },
            "Generated owner chat response"
        );
        await params.publisher.publishReply(response.reply, response.route, false);

        return { pipelineOutcome: "owner_chat" };
    }
}
