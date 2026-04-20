import type { Logger } from "pino";
import { SpanKind } from "@opentelemetry/api";

import { evaluateAccess } from "./auth.js";
import type { LlmService } from "./chat/llmService.js";
import { createOutboundMessageRequestedEvent, type InboundMessageReceivedEvent } from "./events.js";
import type { EventBus } from "./eventBus.js";
import { getOnboardingPrompt, handleOnboardingReply } from "./onboarding.js";
import type { OutlookCalendarClient } from "./outlookCalendar.js";
import type { MicrosoftOutlookOAuthClient } from "./outlookOAuth.js";
import { createSpanAttributesForEvent, startPipelineTimer, withEventContext, withSpan } from "./observability.js";
import type { Persistence } from "./persistence.js";
import type { WorldLookupSourceName } from "./types.js";
import type { WorldLookupAdapter } from "./worldLookup.js";
import type { WeatherLookupClient } from "./weatherLookup.js";
import { buildPipelineContext } from "./pipeline/context.js";
import { createReplyPublisher } from "./pipeline/publish.js";
import { resolveMessageRoute } from "./pipeline/routing.js";
import { executeTool, ToolContext } from "./toolExecutor.js";
import { buildGeneralConversationPrompt, buildToolPrompt } from "./utilities/promptUtility.js";
import { getToolResponse } from "./pipeline/toolExecution.js";

export function registerMessagePipeline(params: {
    bus: EventBus;
    calendarClient: OutlookCalendarClient;
    llmService: LlmService;
    logger: Logger;
    outlookOAuthClient: MicrosoftOutlookOAuthClient;
    ownerUserId: string;
    persistence: Persistence;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
    weatherClient?: WeatherLookupClient;
}): () => void {
    const { bus, calendarClient, llmService, logger, outlookOAuthClient, ownerUserId, persistence, worldLookupAdapters, weatherClient } = params;

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

                        const pipelineContext = buildPipelineContext({
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
                        const routingData = await resolveMessageRoute({
                            llmService,
                            context: pipelineContext,
                            correlationId: event.correlation.correlationId,
                            logger,
                            messageId: event.payload.messageId
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
                        persistence.saveAccessAudit({
                            messageId: event.payload.messageId,
                            actorRole: accessDecision.actorRole,
                            canUsePrivilegedFeatures: accessDecision.canUsePrivilegedFeatures,
                            decision: accessDecision.canUsePrivilegedFeatures ? "owner-allowed" : "non-owner-routed",
                            addressed: routingData.addressed,
                            addressedReason: routingData.reason,
                            transport: event.routing.transport ?? "unknown",
                            conversationId: event.correlation.conversationId ?? "unknown"
                        });

                        if (!routingData.addressed || !routingData.route) {
                            pipelineOutcome = "ignored_unaddressed";
                            return;
                        }

                        if (accessDecision.canUsePrivilegedFeatures) {
                            if (!persistence.settings.hasCompletedOnboarding()) {
                                const response = content
                                    ? handleOnboardingReply(persistence.settings, content)
                                    : { reply: getOnboardingPrompt(persistence.settings), onboardingComplete: false };
                                pipelineOutcome = "onboarding";
                                await publisher.publishReply(response.reply);
                                return;
                            }

                            if (routingData.route.name === "execute_tool") {
                                const { name, args } = routingData.route;
                                const toolContext: ToolContext = {
                                    actorId: event.payload.sender.actorId,
                                    bus,
                                    calendarClient,
                                    persistence,
                                    conversationId,
                                    userMessage: undefined,
                                    worldLookupAdapters,
                                    articleReader: undefined,
                                    weatherClient
                                };
                                const toolResponse = await getToolResponse(name, args, recentConversation, currentSpeakerLabel, content, toolContext, params.llmService);
                                if (toolResponse.success) {                                                  
                                    await bus.publishOutboundMessage(
                                        createOutboundMessageRequestedEvent({
                                            inboundEvent: event,
                                            content: toolResponse.response,
                                            recordConversationTurn: true
                                        })
                                    );
                                }
                            }
                        }
                        
                        const additionalInstructions = routingData.route.name === "execute_tool" ? "You tried to look up additional data using a tool, but the tool call failed." : routingData.route.instructions;
                        const generalConversationPrompt = buildGeneralConversationPrompt(recentConversation, currentSpeakerLabel, content, additionalInstructions);
                        const response = await params.llmService.generate(generalConversationPrompt);
                                        
                        await bus.publishOutboundMessage(
                            createOutboundMessageRequestedEvent({
                                inboundEvent: event,
                                content: response,
                                recordConversationTurn: true
                            })
                        );
                    } finally {
                        span.setAttribute("dot.pipeline.outcome", pipelineOutcome);
                        stopPipelineTimer();
                    }
                }
            );
        });
    });
}
