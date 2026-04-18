import type { Logger } from "pino";

import type { ChatService, LlmRoute } from "../chat/modelRouter.js";
import {
    executeConversationalToolCall,
    renderConversationalToolResult,
    type ConversationalToolName
} from "../conversationalTools.js";
import { recordToolExecution } from "../observability.js";
import { continueReminderIntake, startReminderIntake, type ReminderIntakeState } from "../reminderIntake.js";
import type { Persistence } from "../persistence.js";
import type { GroundedAnswerService } from "../toolInvocation.js";
import type {
    PendingConversationalToolSessionRecord,
    WorldLookupSourceName
} from "../types.js";
import type { WorldLookupAdapter } from "../worldLookup.js";
import type { WeatherLookupClient } from "../weatherLookup.js";
import type { PrecomputedIntentDecision, ReplyPublisher } from "./types.js";

const PENDING_TOOL_SESSION_TTL_MS = 15 * 60 * 1000;

export async function executeInferredToolOrConversation(params: {
    calendarClient: import("../outlookCalendar.js").OutlookCalendarClient;
    chatService: ChatService;
    content: string;
    conversationId: string;
    currentSpeakerLabel: string;
    event: import("../events.js").InboundMessageReceivedEvent;
    groundedAnswerService?: GroundedAnswerService;
    logger: Logger;
    pendingToolSession: PendingConversationalToolSessionRecord | null;
    persistence: Persistence;
    precomputedIntentDecision: PrecomputedIntentDecision | null;
    publisher: ReplyPublisher;
    recentConversation: import("../types.js").ConversationTurnRecord[];
    weatherClient?: WeatherLookupClient;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
}): Promise<{ pipelineOutcome: string }> {
    let activePendingToolSession: PendingConversationalToolSessionRecord | null = params.pendingToolSession;

    try {
        const inferred = params.precomputedIntentDecision
            ? params.precomputedIntentDecision
            : params.pendingToolSession?.toolName === "reminder.add"
                ? {
                    route: "deterministic" as const,
                    powerStatus: params.chatService.getPowerStatus("deterministic"),
                    decision: {
                        decision: "execute_tool" as const,
                        toolName: "reminder.add" as const,
                        reason: "continue deterministic reminder intake",
                        confidence: "high" as const,
                        args: {}
                    }
                }
                : params.pendingToolSession && params.chatService.resolvePendingToolDecision
                    ? await params.chatService.resolvePendingToolDecision({
                        userMessage: params.content,
                        session: params.pendingToolSession,
                        recentConversation: params.recentConversation,
                        currentSpeakerLabel: params.currentSpeakerLabel
                    })
                    : await params.chatService.inferToolDecision(
                        params.content,
                        params.recentConversation,
                        params.currentSpeakerLabel
                    );

        if (!params.precomputedIntentDecision) {
            params.logger.info(
                {
                    messageId: params.event.payload.messageId,
                    correlationId: params.event.correlation.correlationId,
                    conversationId: params.conversationId,
                    stage: params.pendingToolSession ? "tool.resume" : "tool.infer",
                    provider: inferred.route,
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
                detail: `decision=${inferred.decision.decision}; reason=${inferred.decision.reason}`
            });
            recordToolExecution({ toolName: "respond", status: "executed" });
            await params.publisher.publishReply(inferred.decision.response, inferred.route);

            return { pipelineOutcome: "owner_chat" };
        }

        let resolvedArgs =
            params.pendingToolSession && params.pendingToolSession.toolName === inferred.decision.toolName
                ? { ...params.pendingToolSession.args, ...inferred.decision.args }
                : inferred.decision.args;

        if (inferred.decision.toolName === "reminder.add") {
            const reminderIntakeOutcome =
                params.pendingToolSession?.sessionState?.engine === "reminder.add.intake"
                    ? continueReminderIntake({
                        state: params.pendingToolSession.sessionState,
                        userMessage: params.content
                    })
                    : startReminderIntake({
                        args: resolvedArgs
                    });

            if (reminderIntakeOutcome.kind === "clarify" || reminderIntakeOutcome.kind === "requires_confirmation") {
                const reminderIntakeArgs = reminderIntakeArgsFromState(reminderIntakeOutcome.state);
                savePendingToolSession({
                    persistence: params.persistence,
                    conversationId: params.conversationId,
                    toolName: "reminder.add",
                    args: reminderIntakeArgs,
                    originalUserMessage: params.content,
                    pendingStatus: reminderIntakeOutcome.kind,
                    pendingPrompt: reminderIntakeOutcome.prompt,
                    sessionState: reminderIntakeOutcome.state,
                    prior: params.pendingToolSession
                });
                params.persistence.saveToolExecutionAudit({
                    messageId: params.event.payload.messageId,
                    toolName: "reminder.add",
                    invocationSource: "inferred",
                    status: reminderIntakeOutcome.kind,
                    provider: inferred.route,
                    detail: `deterministic_intake=yes; step=${reminderIntakeOutcome.state.step}`
                });
                recordToolExecution({ toolName: "reminder.add", status: reminderIntakeOutcome.kind });
                params.logger.info(
                    {
                        route: inferred.route,
                        messageId: params.event.payload.messageId,
                        toolName: "reminder.add",
                        intakeStep: reminderIntakeOutcome.state.step,
                        status: reminderIntakeOutcome.kind
                    },
                    "Advanced deterministic reminder intake"
                );
                await params.publisher.publishReply(reminderIntakeOutcome.prompt, inferred.route);

                return { pipelineOutcome: "tool_clarify" };
            }

            resolvedArgs = {
                ...resolvedArgs,
                ...reminderIntakeOutcome.args
            };
        }

        if (!params.chatService.renderToolResult) {
            throw new Error("Chat service cannot render conversational tool results");
        }

        const result = await renderConversationalToolResult({
            result: await executeConversationalToolCall({
                call: {
                    toolName: inferred.decision.toolName as ConversationalToolName,
                    args: resolvedArgs,
                    userMessage: params.content,
                    conversationId: params.conversationId
                },
                context: {
                    calendarClient: params.calendarClient,
                    persistence: params.persistence,
                    groundedAnswerService: params.groundedAnswerService,
                    worldLookupAdapters: params.worldLookupAdapters,
                    articleReader: undefined,
                    weatherClient: params.weatherClient
                }
            }),
            userMessage: params.content,
            renderService: { renderToolResult: params.chatService.renderToolResult },
            recentConversation: params.recentConversation
        });

        if (
            (result.status === "clarify" || result.status === "requires_confirmation") &&
            shouldPersistPendingToolSession(result.toolName)
        ) {
            savePendingToolSession({
                persistence: params.persistence,
                conversationId: params.conversationId,
                toolName: result.toolName,
                args: resolvedArgs,
                originalUserMessage: params.content,
                pendingStatus: result.status,
                pendingPrompt: result.reply,
                prior: params.pendingToolSession
            });
        } else if (params.pendingToolSession) {
            params.persistence.clearPendingConversationalToolSession(params.conversationId);
        }

        params.persistence.saveToolExecutionAudit({
            messageId: params.event.payload.messageId,
            toolName: result.toolName,
            invocationSource: "inferred",
            status: result.status === "success" ? "executed" : result.status,
            provider: result.route ?? "none",
            detail: result.detail ?? inferred.decision.reason
        });
        recordToolExecution({
            toolName: result.toolName,
            status: result.status === "success" ? "executed" : result.status
        });
        params.logger.info(
            {
                route: result.route ?? inferred.route,
                messageId: params.event.payload.messageId,
                toolName: result.toolName,
                status: result.status
            },
            "Executed inferred tool decision"
        );
        await params.publisher.publishReply(result.reply, result.route ?? "none");

        return { pipelineOutcome: result.status === "success" ? "tool_execute" : "tool_clarify" };
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

        if (activePendingToolSession) {
            params.logger.warn(
                {
                    err: error,
                    messageId: params.event.payload.messageId,
                    toolName: activePendingToolSession.toolName
                },
                "Pending tool clarification failed; keeping the clarification active"
            );
            await params.publisher.publishReply(
                "I lost the thread on that tool follow-up. Answer my last clarification directly and I'll try again.",
                "none"
            );

            return { pipelineOutcome: "tool_clarify" };
        }

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

function reminderIntakeArgsFromState(state: ReminderIntakeState): Record<string, string | number> {
    const args: Record<string, string | number> = {};
    if (state.data.message) {
        args.message = state.data.message;
    }
    if (state.data.duration) {
        args.duration = state.data.duration;
    }
    if (state.data.dueAt) {
        args.dueAt = state.data.dueAt;
    }
    return args;
}

function shouldPersistPendingToolSession(toolName: ConversationalToolName): boolean {
    return toolName !== "weather.lookup";
}

function savePendingToolSession(params: {
    persistence: Persistence;
    conversationId: string;
    toolName: string;
    args: Record<string, string | number>;
    originalUserMessage: string;
    pendingStatus: "clarify" | "requires_confirmation";
    pendingPrompt: string;
    sessionState?: ReminderIntakeState | null;
    prior?: PendingConversationalToolSessionRecord | null;
}): void {
    if (!params.conversationId) {
        return;
    }

    const now = new Date();
    params.persistence.savePendingConversationalToolSession({
        conversationId: params.conversationId,
        toolName: params.toolName,
        args: params.args,
        originalUserMessage: params.prior?.originalUserMessage ?? params.originalUserMessage,
        pendingStatus: params.pendingStatus,
        pendingPrompt: params.pendingPrompt,
        sessionState: params.sessionState ?? params.prior?.sessionState ?? null,
        createdAt: params.prior?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + PENDING_TOOL_SESSION_TTL_MS).toISOString()
    });
}
