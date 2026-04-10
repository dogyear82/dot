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
      if (!normalized.isDirectMessage && !normalized.mentionedBot) {
        return;
      }

      const content = normalized.isDirectMessage
        ? normalized.content.trim()
        : stripLeadingBotMention(normalized.content, client.user.id);

      if (!persistence.settings.hasCompletedOnboarding()) {
        const response = content
          ? handleOnboardingReply(persistence.settings, content)
          : { reply: getOnboardingPrompt(persistence.settings), onboardingComplete: false };
        void message.reply(response.reply);
        return;
      }

      if (isSettingsCommand(content)) {
        void message.reply(handleSettingsCommand(persistence.settings, content));
        return;
      }

      if (isPersonalityCommand(content)) {
        void message.reply(handlePersonalityCommand(persistence, content));
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
        void message.reply(reply);
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
          await message.reply(reply);
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
              await message.reply(inferred.decision.question);
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
              await message.reply(reply);
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

          persistence.saveConversationTurn({
            conversationId: normalized.channelId,
            role: "user",
            content,
            sourceMessageId: normalized.id,
            createdAt: normalized.createdAt
          });
          const recentConversation = persistence.listRecentConversationTurns(normalized.channelId, RECENT_CHAT_HISTORY_LIMIT);
          const response = await chatService.generateOwnerReply({
            userMessage: content,
            recentConversation: recentConversation.slice(0, -1)
          });
          logger.info({ provider: response.provider, messageId: normalized.id }, "Generated owner chat response");
          const replyMessage = await message.reply(response.reply);
          persistence.saveConversationTurn({
            conversationId: normalized.channelId,
            role: "assistant",
            content: response.reply,
            sourceMessageId: replyMessage.id,
            createdAt: replyMessage.createdAt.toISOString()
          });
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
