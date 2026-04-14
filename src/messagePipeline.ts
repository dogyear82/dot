import type { Logger } from "pino";
import { SpanKind } from "@opentelemetry/api";

import { evaluateAccess } from "./auth.js";
import { appendPowerIndicator, type ChatService, type LlmRoute } from "./chat/modelRouter.js";
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
import { executeToolDecision, parseExplicitToolDecision, type ToolDecision } from "./toolInvocation.js";
import type { IncomingMessage, WorldLookupSourceName } from "./types.js";
import { evaluateAddressedness } from "./discord/addressing.js";
import type { WorldLookupAdapter } from "./worldLookup.js";

const RECENT_CHAT_HISTORY_LIMIT = 10;

export function registerMessagePipeline(params: {
  bus: EventBus;
  calendarClient: OutlookCalendarClient;
  chatService: ChatService;
  logger: Logger;
  outlookOAuthClient: MicrosoftOutlookOAuthClient;
  ownerUserId: string;
  persistence: Persistence;
  worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
}): () => void {
  const { bus, calendarClient, chatService, logger, outlookOAuthClient, ownerUserId, persistence, worldLookupAdapters } = params;

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

            const content = event.payload.addressedContent.trim();
            const isExplicitCommand = content.startsWith("!");
            let addressedDecision = {
              addressed: isExplicitCommand,
              reason: isExplicitCommand ? "explicit_command" : "recent_message_not_addressed_to_dot"
            };

            span.setAttribute("dot.command.explicit", isExplicitCommand);

            if (!isExplicitCommand) {
              const message = mapInboundEventToIncomingMessage(event);
              const recentConversation = persistence.listRecentConversationTurns(event.correlation.conversationId ?? "", RECENT_CHAT_HISTORY_LIMIT);
              const recentMessages = persistence.listRecentNormalizedMessages(
                event.correlation.conversationId ?? "",
                RECENT_CHAT_HISTORY_LIMIT
              );
              const defaultChannelPolicy = persistence.settings.get("channels.defaultPolicy");
              addressedDecision = evaluateAddressedness({
                message,
                defaultChannelPolicy,
                recentConversation,
                recentMessages
              });

              span.setAttribute("dot.addressed", addressedDecision.addressed);
              span.setAttribute("dot.addressed.reason", addressedDecision.reason);
              logger.info(
                {
                  messageId: event.payload.messageId,
                  addressed: addressedDecision.addressed,
                  addressedReason: addressedDecision.reason,
                  actorRole: accessDecision.actorRole
                },
                "Evaluated message addressedness"
              );

              persistence.saveAccessAudit({
                messageId: event.payload.messageId,
                actorRole: accessDecision.actorRole,
                canUsePrivilegedFeatures: accessDecision.canUsePrivilegedFeatures,
                decision: accessDecision.canUsePrivilegedFeatures ? "owner-allowed" : "non-owner-routed",
                addressed: addressedDecision.addressed,
                addressedReason: addressedDecision.reason,
                transport: event.routing.transport ?? "unknown",
                conversationId: event.correlation.conversationId ?? "unknown"
              });

              if (!addressedDecision.addressed) {
                pipelineOutcome = "ignored_unaddressed";
                return;
              }
            } else {
              span.setAttribute("dot.addressed", true);
              span.setAttribute("dot.addressed.reason", addressedDecision.reason);
              persistence.saveAccessAudit({
                messageId: event.payload.messageId,
                actorRole: accessDecision.actorRole,
                canUsePrivilegedFeatures: accessDecision.canUsePrivilegedFeatures,
                decision: accessDecision.canUsePrivilegedFeatures ? "owner-allowed" : "non-owner-routed",
                addressed: true,
                addressedReason: addressedDecision.reason,
                transport: event.routing.transport ?? "unknown",
                conversationId: event.correlation.conversationId ?? "unknown"
              });
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

            const groundedAnswerService = chatService.generateGroundedReply
              ? {
                  generateGroundedReply: chatService.generateGroundedReply.bind(chatService),
                  generateNewsBriefingReply: chatService.generateNewsBriefingReply?.bind(chatService),
                  generateStoryFollowUpReply: chatService.generateStoryFollowUpReply?.bind(chatService)
                }
              : undefined;

            const normalizeInferredExecuteDecision = (decision: Extract<ToolDecision, { decision: "execute" }>) => {
              if (
                decision.toolName !== "world.lookup" &&
                decision.toolName !== "news.briefing" &&
                decision.toolName !== "news.follow_up"
              ) {
                return decision;
              }

              const conversationId = event.correlation.conversationId ?? "";
              const retryQuery =
                decision.toolName === "world.lookup" ? resolveCurrentEventsRetryQuery(content, conversationId, persistence) : null;

              return {
                ...decision,
                args: {
                  ...decision.args,
                  // Preserve the full owner request so bucket selection keeps temporal/context cues like "right now".
                  // If the owner is correcting a stale/history answer in an active topical-news session, retry the saved topic instead.
                  query: retryQuery ?? content
                }
              };
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

              if (isNewsPreferencesCommand(content)) {
                pipelineOutcome = "news_preferences_command";
                await publishReply(handleNewsPreferencesCommand(persistence, content));
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
                await publishReply(result.reply, result.route ?? "none");
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
                    const normalizedDecision = normalizeInferredExecuteDecision(inferred.decision);
                    const result = await executeToolDecision({
                      calendarClient,
                      conversationId: event.correlation.conversationId ?? "",
                      decision: normalizedDecision,
                      groundedAnswerService,
                      persistence,
                      worldLookupAdapters
                    });
                    persistence.saveToolExecutionAudit({
                      messageId: event.payload.messageId,
                      toolName: result.toolName,
                      invocationSource: "inferred",
                      status: result.status,
                      provider: result.route ?? inferred.route,
                      detail: result.policyDecision?.reason ?? result.detail ?? normalizedDecision.reason
                    });
                    recordToolExecution({ toolName: result.toolName, status: result.status });
                    logger.info(
                      { route: inferred.route, messageId: event.payload.messageId, toolName: result.toolName, status: result.status },
                      "Executed inferred tool decision"
                    );
                    pipelineOutcome = result.status === "executed" ? "tool_execute" : "tool_clarify";
                    await publishReply(result.reply, result.route ?? inferred.route);
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

function resolveCurrentEventsRetryQuery(content: string, conversationId: string, persistence: Persistence): string | null {
  if (!conversationId || !looksLikeCurrentEventsCorrection(content)) {
    return null;
  }

  const latestSession = persistence.getLatestNewsBrowseSession(conversationId);
  if (!latestSession || latestSession.kind !== "topic_lookup") {
    return null;
  }

  return latestSession.query;
}

function looksLikeCurrentEventsCorrection(content: string): boolean {
  const normalized = content
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ");

  const asksForCurrentNews = /\b(current events|current event|news|latest|right now|recent)\b/.test(normalized);
  const rejectsReferenceAnswer = /\b(wikipedia|history|historical|not history|not news)\b/.test(normalized);

  return asksForCurrentNews && rejectsReferenceAnswer;
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
