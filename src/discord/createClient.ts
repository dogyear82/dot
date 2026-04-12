import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import { SpanKind } from "@opentelemetry/api";

import type { Logger } from "pino";

import type { EventBus } from "../eventBus.js";
import { createOutboundMessageDeliveredEvent, createOutboundMessageDeliveryFailedEvent } from "../events.js";
import { createSpanAttributesForEvent, recordInboundMessage, recordOutboundMessage, withEventContext, withSpan } from "../observability.js";
import { normalizeMessage } from "./normalize.js";
import type { Persistence } from "../persistence.js";
import { createDiscordInboundMessageEvent } from "./events.js";
import { splitDiscordMessage } from "./outboundChunking.js";

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

  const persistSentDiscordMessage = (sent: Message<boolean>) => {
    const normalizedSent = normalizeMessage(sent, {
      botUserId: client.user!.id,
      botUsername: client.user!.username,
      botRoleIds: sent.guild?.members.me?.roles.cache.map((role) => role.id) ?? []
    });
    persistence.saveNormalizedMessage(normalizedSent);
  };

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

          const chunks = splitDiscordMessage(event.payload.content);
          let firstSent: Message<boolean> | null = null;

          try {
            if (event.payload.delivery.kind === "reply") {
              const replyTo = replyRegistry.get(event.payload.delivery.replyTo);
              if (replyTo) {
                const sent = await replyTo.reply(chunks[0] ?? event.payload.content);
                persistSentDiscordMessage(sent);
                firstSent = sent;
                for (const chunk of chunks.slice(1)) {
                  const followUp = await sent.channel.send(chunk);
                  persistSentDiscordMessage(followUp);
                }
              } else {
                const channel = await client.channels.fetch(event.payload.delivery.channelId);
                if (!channel || !channel.isSendable()) {
                  throw new Error(`Unable to route outbound Discord message to channel ${event.payload.delivery.channelId}`);
                }

                for (const chunk of chunks) {
                  const sent = await channel.send(chunk);
                  if ("author" in sent) {
                    persistSentDiscordMessage(sent);
                    firstSent ??= sent;
                  }
                }
              }
            } else {
              const recipient = await client.users.fetch(event.payload.delivery.recipientActorId);
              const sent = await recipient.send(chunks[0] ?? event.payload.content);
              persistSentDiscordMessage(sent);
              firstSent = sent;
              if (!sent.channel.isSendable()) {
                throw new Error("Unable to send follow-up Discord direct-message chunk");
              }
              for (const chunk of chunks.slice(1)) {
                const followUp = await sent.channel.send(chunk);
                persistSentDiscordMessage(followUp);
              }
            }

            if (firstSent && event.payload.recordConversationTurn) {
              persistence.saveConversationTurn({
                conversationId: event.correlation.conversationId ?? "",
                role: "assistant",
                participantActorId: event.payload.participantActorId,
                content: event.payload.content,
                sourceMessageId: firstSent.id,
                createdAt: firstSent.createdAt.toISOString()
              });
            }

            await bus.publishOutboundMessageDelivered(
              createOutboundMessageDeliveredEvent({
                requestEvent: event,
                transportMessageId: firstSent?.id ?? null
              })
            );
          } catch (error) {
            const reason = error instanceof Error ? error.message : "unknown discord delivery failure";
            logger.error({ err: error, eventId: event.eventId }, "Failed to deliver outbound Discord message");
            await bus.publishOutboundMessageDeliveryFailed(
              createOutboundMessageDeliveryFailedEvent({
                requestEvent: event,
                reason
              })
            );
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
