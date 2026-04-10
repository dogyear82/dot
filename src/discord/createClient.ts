import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";

import type { Logger } from "pino";

import type { EventBus } from "../eventBus.js";
import { normalizeMessage, stripLeadingBotMention } from "./normalize.js";
import type { Persistence } from "../persistence.js";
import { createDiscordInboundMessageEvent } from "./events.js";

export function createDiscordClient(params: {
  bus: EventBus;
  logger: Logger;
  ownerUserId: string;
  persistence: Persistence;
}) {
  const { bus, logger, ownerUserId, persistence } = params;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });
  const replyRegistry = new Map<string, Message<boolean>>();

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
    replyRegistry.set(normalized.id, message);
    const inboundEvent = createDiscordInboundMessageEvent({
      message: normalized,
      botUserId,
      ownerUserId
    });

    logger.info(
      {
        eventId: inboundEvent.eventId,
        messageId: normalized.id,
        channelId: normalized.channelId,
        authorId: normalized.authorId,
        actorRole: inboundEvent.sender.actorRole,
        isDirectMessage: normalized.isDirectMessage,
        mentionedBot: normalized.mentionedBot
      },
      "Received Discord message and publishing canonical inbound event"
    );

    void bus.publishInboundMessage(inboundEvent).catch((error) => {
      logger.error({ err: error, eventId: inboundEvent.eventId }, "Failed to publish inbound message event");
    });
  });

  bus.subscribeOutboundMessage(async (event) => {
    if (event.transport !== "discord" || !client.user) {
      return;
    }

    const replyTo = replyRegistry.get(event.replyRoute.replyToMessageId);
    if (replyTo) {
      const sent = await replyTo.reply(event.content);
      const normalizedSent = normalizeMessage(sent, client.user.id);
      persistence.saveNormalizedMessage(normalizedSent);
      if (event.recordConversationTurn) {
        persistence.saveConversationTurn({
          conversationId: event.conversationId,
          role: "assistant",
          participantActorId: event.participantActorId,
          content: event.content,
          sourceMessageId: sent.id,
          createdAt: sent.createdAt.toISOString()
        });
      }
      return;
    }

    const channel = await client.channels.fetch(event.replyRoute.channelId);
    if (!channel || !channel.isSendable()) {
      logger.error({ eventId: event.eventId, channelId: event.replyRoute.channelId }, "Unable to route outbound Discord message");
      return;
    }

    const sent = await channel.send(event.content);
    if ("author" in sent) {
      const normalizedSent = normalizeMessage(sent, client.user.id);
      persistence.saveNormalizedMessage(normalizedSent);
      if (event.recordConversationTurn) {
        persistence.saveConversationTurn({
          conversationId: event.conversationId,
          role: "assistant",
          participantActorId: event.participantActorId,
          content: event.content,
          sourceMessageId: sent.id,
          createdAt: sent.createdAt.toISOString()
        });
      }
    }
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  return client;
}
