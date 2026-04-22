import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { SpanKind } from "@opentelemetry/api";

import type { Logger } from "pino";

import type { EventBus } from "../eventBus.js";
import { createSpanAttributesForEvent, recordInboundMessage, withEventContext, withSpan } from "../observability.js";
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

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  return client;
}
