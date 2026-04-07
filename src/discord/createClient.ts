import { Client, Events, GatewayIntentBits, Partials } from "discord.js";

import type { Logger } from "pino";

import { evaluateAccess } from "../auth.js";
import { getOnboardingPrompt, handleOnboardingReply, handleSettingsCommand, isSettingsCommand } from "../onboarding.js";
import { normalizeMessage } from "./normalize.js";
import type { Persistence } from "../persistence.js";

export function createDiscordClient(params: {
  logger: Logger;
  ownerUserId: string;
  persistence: Persistence;
}) {
  const { logger, ownerUserId, persistence } = params;
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
      if (!normalized.isDirectMessage) {
        return;
      }

      const content = normalized.content.trim();

      if (!persistence.settings.hasCompletedOnboarding()) {
        const response = content
          ? handleOnboardingReply(persistence.settings, content)
          : { reply: getOnboardingPrompt(persistence.settings), onboardingComplete: false };
        void message.reply(response.reply);
        return;
      }

      if (isSettingsCommand(content)) {
        void message.reply(handleSettingsCommand(persistence.settings, content));
      }

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
