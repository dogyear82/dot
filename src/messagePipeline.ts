import type { Logger } from "pino";

import { evaluateAccess } from "./auth.js";
import { appendPowerIndicator, type ChatService, type LlmRoute } from "./chat/modelRouter.js";
import { createOutboundMessageRequestedEvent, type InboundMessageReceivedEvent } from "./events.js";
import type { EventBus } from "./eventBus.js";
import { getOnboardingPrompt, handleOnboardingReply, handleSettingsCommand, isSettingsCommand } from "./onboarding.js";
import { handleCalendarCommand, isCalendarCommand, type OutlookCalendarClient } from "./outlookCalendar.js";
import type { MicrosoftOutlookOAuthClient } from "./outlookOAuth.js";
import { handlePersonalityCommand, isPersonalityCommand } from "./personality.js";
import type { Persistence } from "./persistence.js";
import { handleReminderCommand, isReminderCommand } from "./reminders.js";
import { executeToolDecision } from "./toolInvocation.js";
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
    const accessDecision = evaluateAccess({
      authorId: event.sender.actorId,
      ownerUserId,
      isDirectMessage: event.payload.isDirectMessage,
      mentionedBot: event.payload.mentionedBot
    });

    persistence.saveAccessAudit({
      messageId: event.sourceMessageId,
      actorRole: accessDecision.actorRole,
      canUsePrivilegedFeatures: accessDecision.canUsePrivilegedFeatures,
      decision: accessDecision.canUsePrivilegedFeatures ? "owner-allowed" : "non-owner-routed",
      transport: event.transport,
      conversationId: event.conversationId
    });

    logger.info(
      {
        eventId: event.eventId,
        messageId: event.sourceMessageId,
        conversationId: event.conversationId,
        authorId: event.sender.actorId,
        actorRole: accessDecision.actorRole,
        canUsePrivilegedFeatures: accessDecision.canUsePrivilegedFeatures,
        isDirectMessage: event.payload.isDirectMessage,
        mentionedBot: event.payload.mentionedBot
      },
      "Processing inbound message event"
    );

    const content = event.payload.addressedContent.trim();
    const isExplicitCommand = content.startsWith("!");

    if (!isExplicitCommand) {
      const message = mapInboundEventToIncomingMessage(event);
      const recentConversation = persistence.listRecentConversationTurns(event.conversationId, RECENT_CHAT_HISTORY_LIMIT);
      const recentMessages = persistence.listRecentNormalizedMessages(event.conversationId, RECENT_CHAT_HISTORY_LIMIT);
      const defaultChannelPolicy = persistence.settings.get("channels.defaultPolicy");
      const isAddressed = shouldTreatOwnerMessageAsAddressed({
        message,
        defaultChannelPolicy,
        recentConversation,
        recentMessages
      });

      if (!isAddressed) {
        return;
      }
    }

    let hasSavedUserTurn = false;

    const saveUserConversationTurn = () => {
      if (hasSavedUserTurn || !content) {
        return;
      }

        persistence.saveConversationTurn({
          conversationId: event.conversationId,
          role: "user",
          participantActorId: event.sender.actorId,
          content,
          sourceMessageId: event.sourceMessageId,
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
        await publishReply(response.reply);
        return;
      }

      if (isSettingsCommand(content)) {
        await publishReply(handleSettingsCommand(persistence.settings, content));
        return;
      }

      if (isPersonalityCommand(content)) {
        await publishReply(handlePersonalityCommand(persistence, content));
        return;
      }

      if (isReminderCommand(content)) {
        const reply = handleReminderCommand(persistence, content);
        persistence.saveToolExecutionAudit({
          messageId: event.sourceMessageId,
          toolName: normalizeExplicitToolName(content),
          invocationSource: "explicit",
          status: "executed",
          provider: null,
          detail: content
        });
        await publishReply(reply);
        return;
      }

      if (isCalendarCommand(content)) {
        const reply = await handleCalendarCommand({
          calendarClient,
          content,
          oauthClient: outlookOAuthClient,
          persistence
        });
        persistence.saveToolExecutionAudit({
          messageId: event.sourceMessageId,
          toolName: normalizeExplicitToolName(content),
          invocationSource: "explicit",
          status: "executed",
          provider: null,
          detail: content
        });
        await publishReply(reply);
        return;
      }

      if (!content) {
        return;
      }

      try {
        try {
          const inferred = await chatService.inferToolDecision(content);
          if (inferred.decision.decision === "clarify") {
            persistence.saveToolExecutionAudit({
              messageId: event.sourceMessageId,
              toolName: inferred.decision.toolName,
              invocationSource: "inferred",
              status: "clarify",
              provider: inferred.route,
              detail: inferred.decision.reason
            });
            await publishReply(inferred.decision.question, inferred.route);
            return;
          }

          if (inferred.decision.decision === "execute") {
            const reply = await executeToolDecision({
              calendarClient,
              decision: inferred.decision,
              persistence
            });
            persistence.saveToolExecutionAudit({
              messageId: event.sourceMessageId,
              toolName: inferred.decision.toolName,
              invocationSource: "inferred",
              status: "executed",
              provider: inferred.route,
              detail: inferred.decision.reason
            });
            logger.info(
              { route: inferred.route, messageId: event.sourceMessageId, toolName: inferred.decision.toolName },
              "Executed inferred tool decision"
            );
            await publishReply(reply, inferred.route);
            return;
          }

          persistence.saveToolExecutionAudit({
            messageId: event.sourceMessageId,
            toolName: "none",
            invocationSource: "inferred",
            status: "skipped",
            provider: inferred.route,
            detail: inferred.decision.reason
          });
        } catch (error) {
          persistence.saveToolExecutionAudit({
            messageId: event.sourceMessageId,
            toolName: "inference-error",
            invocationSource: "inferred",
            status: "failed",
            provider: null,
            detail: error instanceof Error ? error.message : "unknown inference failure"
          });
          logger.warn({ err: error, messageId: event.sourceMessageId }, "Tool inference failed; falling back to chat");
        }

        saveUserConversationTurn();
        const updatedConversation = persistence.listRecentConversationTurns(event.conversationId, RECENT_CHAT_HISTORY_LIMIT);
        const response = await chatService.generateOwnerReply({
          userMessage: content,
          recentConversation: updatedConversation.slice(0, -1)
        });
        logger.info(
          { route: response.route, powerStatus: response.powerStatus, messageId: event.sourceMessageId },
          "Generated owner chat response"
        );
        await publishReply(response.reply, response.route);
      } catch (error) {
        logger.error({ err: error, messageId: event.sourceMessageId }, "Failed to generate owner chat response");
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
      return;
    }

    if (isSettingsCommand(content) || isPersonalityCommand(content) || isReminderCommand(content) || isCalendarCommand(content)) {
      await publishReply("That command is owner-only.", "none", false);
      return;
    }

    try {
      saveUserConversationTurn();
      const updatedConversation = persistence.listRecentConversationTurns(event.conversationId, RECENT_CHAT_HISTORY_LIMIT);
      const response = await chatService.generateOwnerReply({
        userMessage: content,
        recentConversation: updatedConversation.slice(0, -1)
      });
      logger.info(
        { route: response.route, powerStatus: response.powerStatus, messageId: event.sourceMessageId },
        "Generated non-owner chat response"
      );
      await publishReply(response.reply, response.route);
    } catch (error) {
      logger.error({ err: error, messageId: event.sourceMessageId }, "Failed to generate non-owner chat response");
      await publishReply("I couldn't generate a response right now.", "none", false);
    }
  });
}

function mapInboundEventToIncomingMessage(event: InboundMessageReceivedEvent): IncomingMessage {
  return {
    id: event.sourceMessageId,
    channelId: event.conversationId,
    guildId: event.replyRoute.guildId,
    authorId: event.sender.actorId,
    authorUsername: event.sender.displayName,
    content: event.payload.content,
    isDirectMessage: event.payload.isDirectMessage,
    mentionedBot: event.payload.mentionedBot,
    createdAt: event.occurredAt
  };
}

function normalizeExplicitToolName(content: string): string {
  if (content.startsWith("!reminder add ") || content.startsWith("!remind ")) {
    return "reminder.add";
  }

  if (content.startsWith("!reminder ack ")) {
    return "reminder.ack";
  }

  if (content.startsWith("!reminder show") || content === "!reminder") {
    return "reminder.show";
  }

  if (content.startsWith("!calendar remind ")) {
    return "calendar.remind";
  }

  if (content.startsWith("!calendar auth")) {
    return "calendar.auth";
  }

  if (content.startsWith("!calendar show") || content === "!calendar") {
    return "calendar.show";
  }

  if (content.startsWith("!settings")) {
    return "settings";
  }

  if (content.startsWith("!personality")) {
    return "personality";
  }

  return "explicit-command";
}
