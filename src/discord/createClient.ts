import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import { SpanKind } from "@opentelemetry/api";

import type { Logger } from "pino";

import type { EventBus } from "../eventBus.js";
import { createSpanAttributesForEvent, recordInboundMessage, recordOutboundMessage, withEventContext, withSpan } from "../observability.js";
import { normalizeMessage } from "./normalize.js";
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
    const botRoleIds = message.guild?.members.me?.roles.cache.map((role) => role.id) ?? [];
    const normalized = normalizeMessage(message, { botUserId, botUsername: client.user.username, botRoleIds });
    persistence.saveNormalizedMessage(normalized);
    replyRegistry.set(normalized.id, message);
    const inboundEvent = createDiscordInboundMessageEvent({
      message: normalized,
      botUserId,
      botUsername: client.user.username,
      botRoleIds,
      ownerUserId
    });

    void withEventContext(inboundEvent, async () => {
      await withSpan(
        "discord.message.received",
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            ...createSpanAttributesForEvent(inboundEvent),
            "messaging.system": "discord",
            "dot.actor.role": inboundEvent.payload.sender.actorRole
          }
        },
        async () => {
          recordInboundMessage({
            transport: inboundEvent.routing.transport ?? "unknown",
            actorRole: inboundEvent.payload.sender.actorRole
          });

          logger.info(
            {
              messageId: normalized.id,
              channelId: normalized.channelId,
              authorId: normalized.authorId,
              actorRole: inboundEvent.payload.sender.actorRole,
              isDirectMessage: normalized.isDirectMessage,
              mentionedBot: normalized.mentionedBot
            },
            "Received Discord message and publishing canonical inbound event"
          );

          await bus.publishInboundMessage(inboundEvent);
        }
      );
    }).catch((error) => {
      logger.error({ err: error, eventId: inboundEvent.eventId }, "Failed to publish inbound message event");
    });
  });

  bus.subscribeOutboundMessage(async (event) => {
    if (event.routing.transport !== "discord" || !client.user) {
      return;
    }

    const botUser = client.user;

    await withEventContext(event, async () => {
      await withSpan(
        "discord.message.deliver",
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            ...createSpanAttributesForEvent(event),
            "messaging.system": "discord"
          }
        },
        async () => {
          recordOutboundMessage({
            transport: event.routing.transport ?? "unknown"
          });

          const replyTo = replyRegistry.get(event.payload.replyRoute.replyTo);
          if (replyTo) {
            const sent = await replyTo.reply(event.payload.content);
            const normalizedSent = normalizeMessage(sent, {
              botUserId: botUser.id,
              botUsername: botUser.username,
              botRoleIds: sent.guild?.members.me?.roles.cache.map((role) => role.id) ?? []
            });
            persistence.saveNormalizedMessage(normalizedSent);
            if (event.payload.recordConversationTurn) {
              persistence.saveConversationTurn({
                conversationId: event.correlation.conversationId ?? "",
                role: "assistant",
                participantActorId: event.payload.participantActorId,
                content: event.payload.content,
                sourceMessageId: sent.id,
                createdAt: sent.createdAt.toISOString()
              });
            }
            return;
          }

          const channel = await client.channels.fetch(event.payload.replyRoute.channelId);
          if (!channel || !channel.isSendable()) {
            logger.error({ channelId: event.payload.replyRoute.channelId }, "Unable to route outbound Discord message");
            return;
          }

          const sent = await channel.send(event.payload.content);
          if ("author" in sent) {
            const normalizedSent = normalizeMessage(sent, {
              botUserId: botUser.id,
              botUsername: botUser.username,
              botRoleIds: sent.guild?.members.me?.roles.cache.map((role) => role.id) ?? []
            });
            persistence.saveNormalizedMessage(normalizedSent);
            if (event.payload.recordConversationTurn) {
              persistence.saveConversationTurn({
                conversationId: event.correlation.conversationId ?? "",
                role: "assistant",
                participantActorId: event.payload.participantActorId,
                content: event.payload.content,
                sourceMessageId: sent.id,
                createdAt: sent.createdAt.toISOString()
              });
            }
          }
        }
      );
    });
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  return client;
}
