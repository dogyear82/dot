import type { Logger } from "pino";
import { SpanKind } from "@opentelemetry/api";

import { evaluateAccess } from "./auth.js";
import { appendPowerIndicator, type ChatService } from "./chat/modelRouter.js";
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
import { executeConversationResponse } from "./pipeline/conversationResponse.js";
import { executeInferredToolOrConversation } from "./pipeline/toolExecution.js";
import { handleOwnerCommand, isOwnerOnlyCommand } from "./pipeline/commandHandler.js";

export function registerMessagePipeline(params: {
    bus: EventBus;
    calendarClient: OutlookCalendarClient;
    chatService: ChatService;
    logger: Logger;
    outlookOAuthClient: MicrosoftOutlookOAuthClient;
    ownerUserId: string;
    persistence: Persistence;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
    weatherClient?: WeatherLookupClient;
}): () => void {
    const { bus, calendarClient, chatService, logger, outlookOAuthClient, ownerUserId, persistence, worldLookupAdapters, weatherClient } = params;

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
                            chatService,
                            content,
                            conversationId,
                            event,
                            persistence
                        });

                        const groundedAnswerService = chatService.generateGroundedReply
                            ? {
                                generateGroundedReply: chatService.generateGroundedReply.bind(chatService),
                                generateNewsBriefingReply: chatService.generateNewsBriefingReply?.bind(chatService),
                                generateStoryFollowUpReply: chatService.generateStoryFollowUpReply?.bind(chatService)
                            }
                            : undefined;
                        const routingDecision = await resolveMessageRoute({
                            chatService,
                            context: pipelineContext,
                            correlationId: event.correlation.correlationId,
                            logger,
                            messageId: event.payload.messageId
                        });
                        const { addressed, addressedReason, precomputedIntentDecision } = routingDecision;

                        span.setAttribute("dot.addressed", addressed);
                        span.setAttribute("dot.addressed.reason", addressedReason);
                        logger.info(
                            {
                                messageId: event.payload.messageId,
                                addressed,
                                addressedReason,
                                actorRole: accessDecision.actorRole
                            },
                            "Evaluated message addressedness"
                        );
                        persistence.saveAccessAudit({
                            messageId: event.payload.messageId,
                            actorRole: accessDecision.actorRole,
                            canUsePrivilegedFeatures: accessDecision.canUsePrivilegedFeatures,
                            decision: accessDecision.canUsePrivilegedFeatures ? "owner-allowed" : "non-owner-routed",
                            addressed,
                            addressedReason,
                            transport: event.routing.transport ?? "unknown",
                            conversationId: event.correlation.conversationId ?? "unknown"
                        });

                        if (!addressed) {
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

                            if (isExplicitCommand) {
                                const commandResult = await handleOwnerCommand({
                                    bus,
                                    calendarClient,
                                    content,
                                    conversationId: event.correlation.conversationId ?? "",
                                    event,
                                    groundedAnswerService,
                                    outlookOAuthClient,
                                    persistence,
                                    publisher,
                                    worldLookupAdapters
                                });
                                if (commandResult.handled) {
                                    pipelineOutcome = commandResult.pipelineOutcome;
                                    return;
                                }
                            }

                            try {
                                if (addressedRespondRequiresOwnerChat) {
                                    await executeConversationResponse({
                                        chatService,
                                        content,
                                        conversationId,
                                        currentSpeakerLabel,
                                        logger,
                                        logMessage: "Generated owner chat response",
                                        messageId: event.payload.messageId,
                                        persistence,
                                        publisher
                                    });
                                    pipelineOutcome = "owner_chat";
                                    return;
                                }
                                const inferredResult = await executeInferredToolOrConversation({
                                    calendarClient,
                                    chatService,
                                    content,
                                    conversationId,
                                    currentSpeakerLabel,
                                    event,
                                    groundedAnswerService,
                                    logger,
                                    persistence,
                                    precomputedIntentDecision,
                                    publisher,
                                    recentConversation,
                                    weatherClient,
                                    worldLookupAdapters
                                });
                                pipelineOutcome = inferredResult.pipelineOutcome;
                            } catch (error) {
                                pipelineOutcome = "owner_chat_error";
                                logger.error({ err: error, messageId: event.payload.messageId }, "Failed to generate owner chat response");
                                await bus.publishOutboundMessage(
                                    createOutboundMessageRequestedEvent({
                                        inboundEvent: event,
                                        content: appendPowerIndicator(
                                            "I couldn't generate a response from the configured model provider. Check the model settings or provider configuration.",
                                            chatService.getPowerStatus("none")
                                        ),
                                        recordConversationTurn: false
                                    })
                                );
                            }

                            return;
                        }

                        if (isExplicitCommand && isOwnerOnlyCommand(content)) {
                            pipelineOutcome = "owner_only_denied";
                            await publisher.publishReply("That command is owner-only.", "none", false);
                            return;
                        }

                        try {
                            await executeConversationResponse({
                                chatService,
                                content,
                                conversationId,
                                currentSpeakerLabel,
                                logger,
                                logMessage: "Generated non-owner chat response",
                                messageId: event.payload.messageId,
                                persistence,
                                publisher
                            });
                            pipelineOutcome = "non_owner_chat";
                        } catch (error) {
                            pipelineOutcome = "non_owner_chat_error";
                            logger.error({ err: error, messageId: event.payload.messageId }, "Failed to generate non-owner chat response");
                            await publisher.publishReply("I couldn't generate a response right now.", "none", false);
                        }
                    } finally {
                        span.setAttribute("dot.pipeline.outcome", pipelineOutcome);
                        stopPipelineTimer();
                    }
                }
            );
        });
    });
}
