import { Client, Events, GatewayIntentBits, Partials } from "discord.js";

import type { Logger } from "pino";

import { evaluateAccess } from "../auth.js";
import type { ChatService } from "../chat/modelRouter.js";
import { getOnboardingPrompt, handleOnboardingReply, handleSettingsCommand, isSettingsCommand } from "../onboarding.js";
import { handleCalendarCommand, isCalendarCommand, type OutlookCalendarClient } from "../outlookCalendar.js";
import type { MicrosoftOutlookOAuthClient } from "../outlookOAuth.js";
import { handlePersonalityCommand, isPersonalityCommand } from "../personality.js";
import { handleReminderCommand, isReminderCommand } from "../reminders.js";
import { executeToolDecision } from "../toolInvocation.js";
import { shouldTreatOwnerMessageAsAddressed } from "./addressing.js";
import { normalizeMessage, stripLeadingBotMention } from "./normalize.js";
import type { Persistence } from "../persistence.js";

const RECENT_CHAT_HISTORY_LIMIT = 10;

export function createDiscordClient(params: {
  calendarClient: OutlookCalendarClient;
  chatService: ChatService;
  logger: Logger;
  outlookOAuthClient: MicrosoftOutlookOAuthClient;
  ownerUserId: string;
  persistence: Persistence;
}) {
  const { calendarClient, chatService, logger, outlookOAuthClient, ownerUserId, persistence } = params;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      {
        botUserId: readyClient.user.id,
        botUsername: readyClient.user.username
      },
      "Discord client connected"
    );
  });

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot || !client.user) {
      return;
    }

    const normalized = normalizeMessage(message, client.user.id);
    persistence.saveNormalizedMessage(normalized);
    const accessDecision = evaluateAccess({
      authorId: normalized.authorId,
      ownerUserId,
      isDirectMessage: normalized.isDirectMessage,
      mentionedBot: normalized.mentionedBot
    });
    persistence.saveAccessAudit({
      messageId: normalized.id,
      actorRole: accessDecision.actorRole,
      canUsePrivilegedFeatures: accessDecision.canUsePrivilegedFeatures,
      decision: accessDecision.canUsePrivilegedFeatures ? "owner-allowed" : "non-owner-routed",
      transport: "discord",
      conversationId: normalized.channelId
    });

    logger.info(
      {
        messageId: normalized.id,
        channelId: normalized.channelId,
        authorId: normalized.authorId,
        actorRole: accessDecision.actorRole,
        canUsePrivilegedFeatures: accessDecision.canUsePrivilegedFeatures,
        isDirectMessage: normalized.isDirectMessage,
        mentionedBot: normalized.mentionedBot
      },
      "Received Discord message"
    );

    if (accessDecision.canUsePrivilegedFeatures) {
      const recentConversation = persistence.listRecentConversationTurns(normalized.channelId, RECENT_CHAT_HISTORY_LIMIT);
      const recentMessages = persistence.listRecentNormalizedMessages(normalized.channelId, RECENT_CHAT_HISTORY_LIMIT);
      const defaultChannelPolicy = persistence.settings.get("channels.defaultPolicy");
      const isAddressed = shouldTreatOwnerMessageAsAddressed({
        message: normalized,
        defaultChannelPolicy,
        recentConversation,
        recentMessages
      });

      if (!isAddressed) {
        return;
      }

      const content =
        normalized.isDirectMessage || !normalized.mentionedBot
          ? normalized.content.trim()
          : stripLeadingBotMention(normalized.content, client.user.id);
      let hasSavedUserTurn = false;

      const saveUserConversationTurn = () => {
        if (hasSavedUserTurn || !content) {
          return;
        }

        persistence.saveConversationTurn({
          conversationId: normalized.channelId,
          role: "user",
          content,
          sourceMessageId: normalized.id,
          createdAt: normalized.createdAt
        });
        hasSavedUserTurn = true;
      };

      const replyAndRecordConversation = async (reply: string) => {
        saveUserConversationTurn();
        const replyMessage = await message.reply(reply);
        persistence.saveConversationTurn({
          conversationId: normalized.channelId,
          role: "assistant",
          content: reply,
          sourceMessageId: replyMessage.id,
          createdAt: replyMessage.createdAt.toISOString()
        });
      };

      if (!persistence.settings.hasCompletedOnboarding()) {
        const response = content
          ? handleOnboardingReply(persistence.settings, content)
          : { reply: getOnboardingPrompt(persistence.settings), onboardingComplete: false };
        void replyAndRecordConversation(response.reply);
        return;
      }

      if (isSettingsCommand(content)) {
        void replyAndRecordConversation(handleSettingsCommand(persistence.settings, content));
        return;
      }

      if (isPersonalityCommand(content)) {
        void replyAndRecordConversation(handlePersonalityCommand(persistence, content));
        return;
      }

      if (isReminderCommand(content)) {
        const reply = handleReminderCommand(persistence, content);
        persistence.saveToolExecutionAudit({
          messageId: normalized.id,
          toolName: normalizeExplicitToolName(content),
          invocationSource: "explicit",
          status: "executed",
          provider: null,
          detail: content
        });
        void replyAndRecordConversation(reply);
        return;
      }

      if (isCalendarCommand(content)) {
        void (async () => {
          const reply = await handleCalendarCommand({
            calendarClient,
            content,
            oauthClient: outlookOAuthClient,
            persistence
          });
          persistence.saveToolExecutionAudit({
            messageId: normalized.id,
            toolName: normalizeExplicitToolName(content),
            invocationSource: "explicit",
            status: "executed",
            provider: null,
            detail: content
          });
          await replyAndRecordConversation(reply);
        })();
        return;
      }

      if (!content) {
        return;
      }

      void (async () => {
        try {
          try {
            const inferred = await chatService.inferToolDecision(content);
            if (inferred.decision.decision === "clarify") {
              persistence.saveToolExecutionAudit({
                messageId: normalized.id,
                toolName: inferred.decision.toolName,
                invocationSource: "inferred",
                status: "clarify",
                provider: inferred.provider,
                detail: inferred.decision.reason
              });
              await replyAndRecordConversation(inferred.decision.question);
              return;
            }

            if (inferred.decision.decision === "execute") {
              const reply = await executeToolDecision({
                calendarClient,
                decision: inferred.decision,
                persistence
              });
              persistence.saveToolExecutionAudit({
                messageId: normalized.id,
                toolName: inferred.decision.toolName,
                invocationSource: "inferred",
                status: "executed",
                provider: inferred.provider,
                detail: inferred.decision.reason
              });
              logger.info(
                { provider: inferred.provider, messageId: normalized.id, toolName: inferred.decision.toolName },
                "Executed inferred tool decision"
              );
              await replyAndRecordConversation(reply);
              return;
            }

            persistence.saveToolExecutionAudit({
              messageId: normalized.id,
              toolName: "none",
              invocationSource: "inferred",
              status: "skipped",
              provider: inferred.provider,
              detail: inferred.decision.reason
            });
          } catch (error) {
            persistence.saveToolExecutionAudit({
              messageId: normalized.id,
              toolName: "inference-error",
              invocationSource: "inferred",
              status: "failed",
              provider: null,
              detail: error instanceof Error ? error.message : "unknown inference failure"
            });
            logger.warn({ err: error, messageId: normalized.id }, "Tool inference failed; falling back to chat");
          }

          saveUserConversationTurn();
          const updatedConversation = persistence.listRecentConversationTurns(normalized.channelId, RECENT_CHAT_HISTORY_LIMIT);
          const response = await chatService.generateOwnerReply({
            userMessage: content,
            recentConversation: updatedConversation.slice(0, -1)
          });
          logger.info({ provider: response.provider, messageId: normalized.id }, "Generated owner chat response");
          await replyAndRecordConversation(response.reply);
        } catch (error) {
          logger.error({ err: error, messageId: normalized.id }, "Failed to generate owner chat response");
          await message.reply(
            "I couldn't generate a response from the configured model provider. Check the model settings or provider configuration."
          );
        }
      })();

      return;
    }

    if (!accessDecision.canUsePrivilegedFeatures && accessDecision.shouldReply && accessDecision.responseMessage) {
      void message.reply(accessDecision.responseMessage);
    }
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  return client;
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

  if (
    content.startsWith("!calendar show") ||
    content === "!calendar"
  ) {
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
