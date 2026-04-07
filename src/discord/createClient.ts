import { Client, Events, GatewayIntentBits, Partials } from "discord.js";

import type { Logger } from "pino";

import { normalizeMessage } from "./normalize.js";
import type { Persistence } from "../persistence.js";

export function createDiscordClient(logger: Logger, persistence: Persistence) {
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

    logger.info(
      {
        messageId: normalized.id,
        channelId: normalized.channelId,
        authorId: normalized.authorId,
        isDirectMessage: normalized.isDirectMessage,
        mentionedBot: normalized.mentionedBot
      },
      "Received Discord message"
    );
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  return client;
}
