import type { Logger } from "pino";
import { SpanKind } from "@opentelemetry/api";

import { evaluateAccess } from "./auth.js";
import { appendPowerIndicator, type ChatService } from "./chat/modelRouter.js";
import { handleContactCommand, handlePolicyCommand, isContactCommand, isPolicyCommand } from "./contacts.js";
import { handleEmailCommand, isEmailCommand } from "./emailWorkflow.js";
import { createOutboundMessageRequestedEvent, type InboundMessageReceivedEvent } from "./events.js";
import type { EventBus } from "./eventBus.js";
import { handleNewsPreferencesCommand, isNewsPreferencesCommand } from "./newsPreferences.js";
import { getOnboardingPrompt, handleOnboardingReply, handleSettingsCommand, isSettingsCommand } from "./onboarding.js";
import { handleCalendarCommand, isCalendarCommand, type OutlookCalendarClient } from "./outlookCalendar.js";
import type { MicrosoftOutlookOAuthClient } from "./outlookOAuth.js";
import { handlePersonalityCommand, isPersonalityCommand } from "./personality.js";
import { createSpanAttributesForEvent, recordToolExecution, startPipelineTimer, withEventContext, withSpan } from "./observability.js";
import type { Persistence } from "./persistence.js";
import { isReminderCommand } from "./reminders.js";
import { executeToolDecision, parseExplicitToolDecision } from "./toolInvocation.js";
import type { WorldLookupSourceName } from "./types.js";
import type { WorldLookupAdapter } from "./worldLookup.js";
import type { WeatherLookupClient } from "./weatherLookup.js";
import { buildPipelineContext } from "./pipeline/context.js";
import { createReplyPublisher } from "./pipeline/publish.js";
import { resolveMessageRoute } from "./pipeline/routing.js";
import { executeConversationResponse } from "./pipeline/conversationResponse.js";
import { executeInferredToolOrConversation } from "./pipeline/toolExecution.js";

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
          const accessDecision = evaluateAccess({
            authorId: event.payload.sender.actorId,
            ownerUserId,
            isDirectMessage: event.payload.isDirectMessage,
            mentionedBot: event.payload.mentionedBot
          });
          let pipelineOutcome = "ignored";
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
            const { content, conversationId, currentSpeakerLabel, isExplicitCommand, pendingToolSession, recentConversation } = pipelineContext;
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
            const { addressed, addressedReason, addressedRespondRequiresOwnerChat, precomputedIntentDecision } = routingDecision;

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

              if (isSettingsCommand(content)) {
                pipelineOutcome = "settings_command";
                await publisher.publishReply(handleSettingsCommand(persistence.settings, content));
                return;
              }

              if (isNewsPreferencesCommand(content)) {
                pipelineOutcome = "news_preferences_command";
                await publisher.publishReply(handleNewsPreferencesCommand(persistence, content));
                return;
              }

              if (isPersonalityCommand(content)) {
                pipelineOutcome = "personality_command";
                await publisher.publishReply(handlePersonalityCommand(persistence, content));
                return;
              }

              if (isContactCommand(content)) {
                pipelineOutcome = "contact_command";
                await publisher.publishReply(
                  handleContactCommand({
                    content,
                    conversationId: event.correlation.conversationId ?? "",
                    persistence
                  }),
                  "none"
                );
                return;
              }

              if (isPolicyCommand(content)) {
                pipelineOutcome = "policy_command";
                await publisher.publishReply(
                  handlePolicyCommand({
                    content,
                    conversationId: event.correlation.conversationId ?? "",
                    persistence
                  }),
                  "none"
                );
                return;
              }

              if (isEmailCommand(content)) {
                pipelineOutcome = "email_command";
                await publisher.publishReply(
                  await handleEmailCommand({
                    actorId: event.payload.sender.actorId,
                    bus,
                    content,
                    conversationId: event.correlation.conversationId ?? "",
                    persistence
                  }),
                  "none"
                );
                return;
              }

              const explicitToolDecision = parseExplicitToolDecision(content);
              if (explicitToolDecision?.decision === "clarify") {
                persistence.saveToolExecutionAudit({
                  messageId: event.payload.messageId,
                  toolName: explicitToolDecision.toolName,
                  invocationSource: "explicit",
                  status: "clarify",
                  provider: null,
                  detail: explicitToolDecision.reason
                });
                recordToolExecution({ toolName: explicitToolDecision.toolName, status: "clarify" });
                pipelineOutcome = "tool_clarify";
                await publisher.publishReply(explicitToolDecision.question, "none");
                return;
              }

              if (explicitToolDecision?.decision === "execute") {
                const result = await executeToolDecision({
                  calendarClient,
                  conversationId: event.correlation.conversationId ?? "",
                  decision: explicitToolDecision,
                  groundedAnswerService,
                  persistence,
                  worldLookupAdapters
                });
                persistence.saveToolExecutionAudit({
                  messageId: event.payload.messageId,
                  toolName: result.toolName,
                  invocationSource: "explicit",
                  status: result.status,
                  provider: result.route ?? null,
                  detail:
                    result.policyDecision?.reason ??
                    result.detail ??
                    explicitToolDecision.reason
                });
                recordToolExecution({ toolName: result.toolName, status: result.status });
                pipelineOutcome = result.status === "executed" ? "tool_execute" : "tool_clarify";
                await publisher.publishReply(result.reply, result.route ?? "none");
                return;
              }

              if (isCalendarCommand(content)) {
                pipelineOutcome = "calendar_command";
                await publisher.publishReply(
                  await handleCalendarCommand({
                    calendarClient,
                    content,
                    oauthClient: outlookOAuthClient,
                    persistence
                  })
                );
                return;
              }

              if (!content) {
                pipelineOutcome = "ignored_empty";
                return;
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
                  pendingToolSession,
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

            if (!content) {
              pipelineOutcome = "ignored_empty";
              return;
            }

            if (
              isSettingsCommand(content) ||
              isPersonalityCommand(content) ||
              isContactCommand(content) ||
              isPolicyCommand(content) ||
              isReminderCommand(content) ||
              isCalendarCommand(content)
            ) {
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
