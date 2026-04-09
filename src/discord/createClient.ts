import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";

import type { Logger } from "pino";

import { evaluateAccess } from "../auth.js";
import type { ChatService } from "../chat/modelRouter.js";
import { getOnboardingPrompt, handleOnboardingReply, handleSettingsCommand, isSettingsCommand } from "../onboarding.js";
import { handleCalendarCommand, isCalendarCommand, type OutlookCalendarClient } from "../outlookCalendar.js";
import { handlePersonalityCommand, isPersonalityCommand } from "../personality.js";
import { handleReminderCommand, isReminderCommand } from "../reminders.js";
import { executeToolDecision } from "../toolInvocation.js";
import { shouldTreatOwnerMessageAsAddressed } from "./addressing.js";
import { normalizeMessage, stripLeadingBotMention } from "./normalize.js";
import type { Persistence } from "../persistence.js";

export function createDiscordClient(params: {
  calendarClient: OutlookCalendarClient;
  chatService: ChatService;
  logger: Logger;
  ownerUserId: string;
  persistence: Persistence;
}) {
  const { calendarClient, chatService, logger, ownerUserId, persistence } = params;
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
    const botUserId = client.user.id;

    const normalized = normalizeMessage(message, botUserId);
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
      decision: accessDecision.canUsePrivilegedFeatures ? "owner-allowed" : "non-owner-routed"
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
      const isAddressed = shouldTreatOwnerMessageAsAddressed({
        message: normalized,
        botUserId,
        defaultChannelPolicy: persistence.settings.get("channels.defaultPolicy"),
        recentMessages: normalized.isDirectMessage ? [] : persistence.listRecentNormalizedMessages(normalized.channelId, 3)
      });

      logger.info(
        {
          messageId: normalized.id,
          channelId: normalized.channelId,
          addressed: isAddressed,
          isDirectMessage: normalized.isDirectMessage,
          mentionedBot: normalized.mentionedBot
        },
        "Evaluated owner addressedness"
      );

      if (!isAddressed) {
        return;
      }

      const content = normalized.isDirectMessage || !normalized.mentionedBot
        ? normalized.content.trim()
        : stripLeadingBotMention(normalized.content, botUserId);

      if (!persistence.settings.hasCompletedOnboarding()) {
        const response = content
          ? handleOnboardingReply(persistence.settings, content)
          : { reply: getOnboardingPrompt(persistence.settings), onboardingComplete: false };
        void replyAndRecord(message, response.reply, botUserId, persistence);
        return;
      }

      if (isSettingsCommand(content)) {
        void replyAndRecord(message, handleSettingsCommand(persistence.settings, content), botUserId, persistence);
        return;
      }

      if (isPersonalityCommand(content)) {
        void replyAndRecord(message, handlePersonalityCommand(persistence, content), botUserId, persistence);
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
        void replyAndRecord(message, reply, botUserId, persistence);
        return;
      }

      if (isCalendarCommand(content)) {
        void (async () => {
          const reply = await handleCalendarCommand({
            calendarClient,
            content,
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
          await replyAndRecord(message, reply, botUserId, persistence);
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
              await replyAndRecord(message, inferred.decision.question, botUserId, persistence);
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
              await replyAndRecord(message, reply, botUserId, persistence);
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

          const response = await chatService.generateOwnerReply(content);
          logger.info({ provider: response.provider, messageId: normalized.id }, "Generated owner chat response");
          await replyAndRecord(message, response.reply, botUserId, persistence);
        } catch (error) {
          logger.error({ err: error, messageId: normalized.id }, "Failed to generate owner chat response");
          await replyAndRecord(
            message,
            "I couldn't generate a response from the configured model provider. Check the model settings or provider configuration.",
            botUserId,
            persistence
          );
        }
      })();

      return;
    }

    if (!accessDecision.canUsePrivilegedFeatures && accessDecision.shouldReply && accessDecision.responseMessage) {
      void replyAndRecord(message, accessDecision.responseMessage, botUserId, persistence);
    }
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  return client;
}

async function replyAndRecord(
  message: Message<boolean>,
  content: string,
  botUserId: string,
  persistence: Persistence
) {
  const sent = await message.reply(content);
  persistence.saveNormalizedMessage(normalizeMessage(sent, botUserId));
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
