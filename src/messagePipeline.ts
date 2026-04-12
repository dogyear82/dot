import type { Logger } from "pino";
import { SpanKind } from "@opentelemetry/api";

import { evaluateAccess } from "./auth.js";
import { appendPowerIndicator, type ChatService, type LlmRoute } from "./chat/modelRouter.js";
import { handleContactCommand, handlePolicyCommand, isContactCommand, isPolicyCommand } from "./contacts.js";
import { handleEmailCommand, isEmailCommand } from "./emailWorkflow.js";
import { createOutboundMessageRequestedEvent, type InboundMessageReceivedEvent } from "./events.js";
import type { EventBus } from "./eventBus.js";
import { getOnboardingPrompt, handleOnboardingReply, handleSettingsCommand, isSettingsCommand } from "./onboarding.js";
import { handleCalendarCommand, isCalendarCommand, type OutlookCalendarClient } from "./outlookCalendar.js";
import type { MicrosoftOutlookOAuthClient } from "./outlookOAuth.js";
import { handlePersonalityCommand, isPersonalityCommand } from "./personality.js";
import { createSpanAttributesForEvent, recordToolExecution, startPipelineTimer, withEventContext, withSpan } from "./observability.js";
import type { Persistence } from "./persistence.js";
import { isReminderCommand } from "./reminders.js";
import { executeToolDecision, parseExplicitToolDecision } from "./toolInvocation.js";
import type { IncomingMessage } from "./types.js";
import { shouldTreatOwnerMessageAsAddressed } from "./discord/addressing.js";

const RECENT_CHAT_HISTORY_LIMIT = 10;

export function registerMessagePipeline(params: {
  bus: EventBus;
  calendarClient: OutlookCalendarClient;
  chatService: ChatService;
  logger: Logger;
  outlookOAuthClient: MicrosoftOutlookOAuthClient;
  ownerUserId: string;
  persistence: Persistence;
}): () => void {
  const { bus, calendarClient, chatService, logger, outlookOAuthClient, ownerUserId, persistence } = params;

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
            persistence.saveAccessAudit({
              messageId: event.payload.messageId,
              actorRole: accessDecision.actorRole,
              canUsePrivilegedFeatures: accessDecision.canUsePrivilegedFeatures,
              decision: accessDecision.canUsePrivilegedFeatures ? "owner-allowed" : "non-owner-routed",
              transport: event.routing.transport ?? "unknown",
              conversationId: event.correlation.conversationId ?? "unknown"
            });

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

            const content = event.payload.addressedContent.trim();
            const isExplicitCommand = content.startsWith("!");

            span.setAttribute("dot.command.explicit", isExplicitCommand);

            if (!isExplicitCommand) {
              const message = mapInboundEventToIncomingMessage(event);
              const recentConversation = persistence.listRecentConversationTurns(event.correlation.conversationId ?? "", RECENT_CHAT_HISTORY_LIMIT);
              const recentMessages = persistence.listRecentNormalizedMessages(
                event.correlation.conversationId ?? "",
                RECENT_CHAT_HISTORY_LIMIT
              );
              const defaultChannelPolicy = persistence.settings.get("channels.defaultPolicy");
              const isAddressed = shouldTreatOwnerMessageAsAddressed({
                message,
                defaultChannelPolicy,
                recentConversation,
                recentMessages
              });

              if (!isAddressed) {
                pipelineOutcome = "ignored_unaddressed";
                return;
              }
            }

            let hasSavedUserTurn = false;

            const saveUserConversationTurn = () => {
              if (hasSavedUserTurn || !content) {
                return;
              }

              persistence.saveConversationTurn({
                conversationId: event.correlation.conversationId ?? "",
                role: "user",
                participantActorId: event.payload.sender.actorId,
                content,
                sourceMessageId: event.payload.messageId,
                createdAt: event.occurredAt
              });
              hasSavedUserTurn = true;
            };

            const publishReply = async (reply: string, route: LlmRoute = "none", recordConversationTurn = true) => {
              if (recordConversationTurn) {
                saveUserConversationTurn();
              }
              await bus.publishOutboundMessage(
                createOutboundMessageRequestedEvent({
                  inboundEvent: event,
                  content: appendPowerIndicator(reply, chatService.getPowerStatus(route)),
                  recordConversationTurn
                })
              );
            };

            if (accessDecision.canUsePrivilegedFeatures) {
              if (!persistence.settings.hasCompletedOnboarding()) {
                const response = content
                  ? handleOnboardingReply(persistence.settings, content)
                  : { reply: getOnboardingPrompt(persistence.settings), onboardingComplete: false };
                pipelineOutcome = "onboarding";
                await publishReply(response.reply);
                return;
              }

              if (isSettingsCommand(content)) {
                pipelineOutcome = "settings_command";
                await publishReply(handleSettingsCommand(persistence.settings, content));
                return;
              }

              if (isPersonalityCommand(content)) {
                pipelineOutcome = "personality_command";
                await publishReply(handlePersonalityCommand(persistence, content));
                return;
              }

              if (isContactCommand(content)) {
                pipelineOutcome = "contact_command";
                await publishReply(
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
                await publishReply(
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
                await publishReply(
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
                await publishReply(explicitToolDecision.question, "none");
                return;
              }

              if (explicitToolDecision?.decision === "execute") {
                const result = await executeToolDecision({
                  calendarClient,
                  decision: explicitToolDecision,
                  persistence
                });
                persistence.saveToolExecutionAudit({
                  messageId: event.payload.messageId,
                  toolName: result.toolName,
                  invocationSource: "explicit",
                  status: result.status,
                  provider: null,
                  detail:
                    result.policyDecision?.reason ??
                    explicitToolDecision.reason
                });
                recordToolExecution({ toolName: result.toolName, status: result.status });
                pipelineOutcome = result.status === "executed" ? "tool_execute" : "tool_clarify";
                await publishReply(result.reply);
                return;
              }

              if (isCalendarCommand(content)) {
                pipelineOutcome = "calendar_command";
                await publishReply(
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
                try {
                  const inferred = await chatService.inferToolDecision(content);
                  if (inferred.decision.decision === "clarify") {
                    persistence.saveToolExecutionAudit({
                      messageId: event.payload.messageId,
                      toolName: inferred.decision.toolName,
                      invocationSource: "inferred",
                      status: "clarify",
                      provider: inferred.route,
                      detail: inferred.decision.reason
                    });
                    recordToolExecution({ toolName: inferred.decision.toolName, status: "clarify" });
                    pipelineOutcome = "tool_clarify";
                    await publishReply(inferred.decision.question, inferred.route);
                    return;
                  }

                  if (inferred.decision.decision === "execute") {
                    const result = await executeToolDecision({
                      calendarClient,
                      decision: inferred.decision,
                      persistence
                    });
                    persistence.saveToolExecutionAudit({
                      messageId: event.payload.messageId,
                      toolName: result.toolName,
                      invocationSource: "inferred",
                      status: result.status,
                      provider: inferred.route,
                      detail: result.policyDecision?.reason ?? inferred.decision.reason
                    });
                    recordToolExecution({ toolName: result.toolName, status: result.status });
                    logger.info(
                      { route: inferred.route, messageId: event.payload.messageId, toolName: result.toolName, status: result.status },
                      "Executed inferred tool decision"
                    );
                    pipelineOutcome = result.status === "executed" ? "tool_execute" : "tool_clarify";
                    await publishReply(result.reply, inferred.route);
                    return;
                  }

                  persistence.saveToolExecutionAudit({
                    messageId: event.payload.messageId,
                    toolName: "none",
                    invocationSource: "inferred",
                    status: "skipped",
                    provider: inferred.route,
                    detail: inferred.decision.reason
                  });
                  recordToolExecution({ toolName: "none", status: "skipped" });
                } catch (error) {
                  persistence.saveToolExecutionAudit({
                    messageId: event.payload.messageId,
                    toolName: "inference-error",
                    invocationSource: "inferred",
                    status: "failed",
                    provider: null,
                    detail: error instanceof Error ? error.message : "unknown inference failure"
                  });
                  recordToolExecution({ toolName: "inference-error", status: "failed" });
                  logger.warn({ err: error, messageId: event.payload.messageId }, "Tool inference failed; falling back to chat");
                }

                saveUserConversationTurn();
                const updatedConversation = persistence.listRecentConversationTurns(
                  event.correlation.conversationId ?? "",
                  RECENT_CHAT_HISTORY_LIMIT
                );
                const response = await chatService.generateOwnerReply({
                  userMessage: content,
                  recentConversation: updatedConversation.slice(0, -1)
                });
                logger.info(
                  { route: response.route, powerStatus: response.powerStatus, messageId: event.payload.messageId },
                  "Generated owner chat response"
                );
                pipelineOutcome = "owner_chat";
                await publishReply(response.reply, response.route);
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
              await publishReply("That command is owner-only.", "none", false);
              return;
            }

            try {
              saveUserConversationTurn();
              const updatedConversation = persistence.listRecentConversationTurns(
                event.correlation.conversationId ?? "",
                RECENT_CHAT_HISTORY_LIMIT
              );
              const response = await chatService.generateOwnerReply({
                userMessage: content,
                recentConversation: updatedConversation.slice(0, -1)
              });
              logger.info(
                { route: response.route, powerStatus: response.powerStatus, messageId: event.payload.messageId },
                "Generated non-owner chat response"
              );
              pipelineOutcome = "non_owner_chat";
              await publishReply(response.reply, response.route);
            } catch (error) {
              pipelineOutcome = "non_owner_chat_error";
              logger.error({ err: error, messageId: event.payload.messageId }, "Failed to generate non-owner chat response");
              await publishReply("I couldn't generate a response right now.", "none", false);
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

function mapInboundEventToIncomingMessage(event: InboundMessageReceivedEvent): IncomingMessage {
  return {
    id: event.payload.messageId,
    channelId: event.correlation.conversationId ?? "",
    guildId: event.payload.replyRoute.guildId,
    authorId: event.payload.sender.actorId,
    authorUsername: event.payload.sender.displayName,
    content: event.payload.content,
    isDirectMessage: event.payload.isDirectMessage,
    mentionedBot: event.payload.mentionedBot,
    createdAt: event.occurredAt
  };
}
