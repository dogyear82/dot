import type { Logger } from "pino";
import { SpanKind } from "@opentelemetry/api";

import { evaluateAccess } from "./auth.js";
import type { LlmService } from "./chat/llmService.js";
import type { EventBus } from "./eventBus.js";
import { getOnboardingPrompt, handleOnboardingReply } from "./onboarding.js";
import { createSpanAttributesForEvent, startPipelineTimer, withEventContext, withSpan } from "./observability.js";
import type { Persistence } from "./persistence.js";
import type { WorldLookupSourceName } from "./types.js";
import { buildPipelineContext } from "./pipeline/context.js";
import { createReplyPublisher } from "./pipeline/publish.js";
import { resolveMessageRoute } from "./pipeline/routing.js";
import type { ToolCallService } from "./tools/mcp/service.js";
import type { WorldLookupAdapter } from "./tools/shared/worldLookup.js";
import { buildFinalOutputPrompt } from "./utilities/promptUtility.js";

export function registerMessagePipeline(params: {
    bus: EventBus;
    llmService: LlmService;
    logger: Logger;
    ownerUserId: string;
    persistence: Persistence;
    toolService: ToolCallService;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
}): () => void {
    const { bus, llmService, logger, ownerUserId, persistence } = params;

    return bus.subscribeInboundMessage(async (event) => {
        await withEventContext(event, async () => {
            await withSpan(
                "message.pipeline.handle",
                {
                    kind: SpanKind.INTERNAL,
                    attributes: {
                        ...createSpanAttributesForEvent(event),
                        "dot.actor.role": event.payload.sender.actorRole
                    }
                },
                async (span) => {
                    let pipelineOutcome = "ignored";
                    let accessDecision = evaluateAccess({
                        authorId: event.payload.sender.actorId,
                        ownerUserId,
                        isDirectMessage: event.payload.isDirectMessage,
                        mentionedBot: event.payload.mentionedBot
                    });
                    const stopPipelineTimer = startPipelineTimer({
                        actorRole: accessDecision.actorRole,
                        outcome: () => pipelineOutcome
                    });

                    try {
                        logger.info(
                            {
                                messageId: event.payload.messageId,
                                authorId: event.payload.sender.actorId,
                                actorRole: accessDecision.actorRole,
                                canUsePrivilegedFeatures: accessDecision.canUsePrivilegedFeatures,
                                isDirectMessage: event.payload.isDirectMessage,
                                mentionedBot: event.payload.mentionedBot
                            },
                            "Processing inbound message event"
                        );

                        const pipelineContext = await buildPipelineContext({
                            event,
                            persistence
                        });
                        const { content, conversationId, currentSpeakerLabel, isExplicitCommand, recentConversation } = pipelineContext;

                        if (!content) {
                            pipelineOutcome = "ignored_empty";
                            return;
                        }

                        accessDecision = evaluateAccess({
                            authorId: event.payload.sender.actorId,
                            ownerUserId,
                            isDirectMessage: event.payload.isDirectMessage,
                            mentionedBot: event.payload.mentionedBot
                        });
                        const publisher = createReplyPublisher({
                            bus,
                            content,
                            conversationId,
                            event,
                            persistence
                        });

                        if (!persistence.settings.hasCompletedOnboarding()) {
                            if (!accessDecision.canUsePrivilegedFeatures) {
                                pipelineOutcome = "ignored_onboarding_incomplete";
                                return;
                            }

                            const response = content
                                ? handleOnboardingReply(persistence.settings, content)
                                : { reply: getOnboardingPrompt(persistence.settings), onboardingComplete: false };
                            pipelineOutcome = "onboarding";
                            await publisher.publishReply(response.reply);
                            return;
                        }

                        const availableTools = await params.toolService.listToolsForRouting();
                        const routingData = await resolveMessageRoute({
                            llmService,
                            context: pipelineContext,
                            correlationId: event.correlation.correlationId,
                            logger,
                            messageId: event.payload.messageId,
                            availableTools
                        });

                        span.setAttribute("dot.addressed", routingData.addressed);
                        span.setAttribute("dot.addressed.reason", routingData.reason);
                        logger.info(
                            {
                                messageId: event.payload.messageId,
                                addressed: routingData.addressed,
                                addressedReason: routingData.reason,
                                actorRole: accessDecision.actorRole
                            },
                            "Evaluated message addressedness"
                        );
                        await persistence.saveAccessAudit({
                            messageId: event.payload.messageId,
                            actorRole: accessDecision.actorRole,
                            canUsePrivilegedFeatures: accessDecision.canUsePrivilegedFeatures,
                            decision: accessDecision.canUsePrivilegedFeatures ? "owner-allowed" : "non-owner-routed",
                            addressed: routingData.addressed,
                            addressedReason: routingData.reason ?? "unknown",
                            transport: event.routing.transport ?? "unknown",
                            conversationId: event.correlation.conversationId ?? "unknown"
                        });

                        if (!routingData.addressed || !routingData.route) {
                            pipelineOutcome = "ignored_unaddressed";
                            return;
                        }

                        if (accessDecision.canUsePrivilegedFeatures) {
                            if (routingData.route.name === "execute_tool") {
                                const { toolName, args } = routingData.route;
                                const toolResponse = await params.toolService.executeTool(toolName, args);

                                if (toolResponse.success) {
                                    const prompt = buildFinalOutputPrompt(
                                        toolResponse.content,
                                        recentConversation,
                                        currentSpeakerLabel,
                                        content,
                                        ""
                                    );
                                    const response = await params.llmService.generate(prompt);
                                    await publisher.publishReply(response);
                                    pipelineOutcome = "tool";
                                    return;
                                }

                                const failureInstructions = toolResponse.failureDetail
                                    ? `You tried to look up additional data using the tool "${toolName}", but the tool call failed with: ${toolResponse.failureDetail}`
                                    : "You tried to look up additional data using a tool, but the tool call failed.";
                                const generalConversationPrompt = buildFinalOutputPrompt(
                                    "",
                                    recentConversation,
                                    currentSpeakerLabel,
                                    content,
                                    failureInstructions
                                );
                                const response = await params.llmService.generate(generalConversationPrompt);
                                logger.info({
                                    messageId: event.payload.messageId,
                                    prompt: generalConversationPrompt,
                                    response,
                                }, "Prompt for final tool augmented message output.");

                                await publisher.publishReply(response);
                                pipelineOutcome = "tool";
                                return;
                            }
                        }
                        
                        const additionalInstructions = routingData.route.name === "respond"
                            ? routingData.route.instructions
                            : "";
                        const generalConversationPrompt = buildFinalOutputPrompt("", recentConversation, currentSpeakerLabel, content, additionalInstructions);
                        const response = await params.llmService.generate(generalConversationPrompt);
                        logger.info({
                            messageId: event.payload.messageId,
                            prompt: generalConversationPrompt,
                            response
                        }, "Response for final general covneration output.");

                        await publisher.publishReply(response);
                        pipelineOutcome = "conversation";
                    } finally {
                        span.setAttribute("dot.pipeline.outcome", pipelineOutcome);
                        stopPipelineTimer();
                    }
                }
            );
        });
    });
}
