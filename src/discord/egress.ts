import { Client, Events, GatewayIntentBits, type Message } from "discord.js";
import { SpanKind } from "@opentelemetry/api";

import type { Logger } from "pino";

import type { EventBus } from "../eventBus.js";
import {
  createOutboundMessageDeliveredEvent,
  createOutboundMessageDeliveryFailedEvent,
  type OutboundMessageRequestedEvent
} from "../events.js";
import { createSpanAttributesForEvent, recordOutboundMessage, withEventContext, withSpan } from "../observability.js";
import type { Persistence } from "../persistence.js";
import { normalizeMessage } from "./normalize.js";
import { splitDiscordMessage } from "./outboundChunking.js";

type DiscordEgressClient = Pick<Client, "channels" | "users"> & {
  user: Client["user"];
};

export function createDiscordEgressClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds]
  });
}

export function registerDiscordEgressConsumer(params: {
  bus: EventBus;
  client: DiscordEgressClient;
  logger: Logger;
  persistence: Persistence;
}) {
  const { bus, client, logger, persistence } = params;

  return bus.subscribeOutboundMessage(async (event) => {
    if (event.routing.transport !== "discord" || !client.user) {
      return;
    }

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

          try {
            const firstSent = await deliverDiscordMessage({
              client,
              event,
              persistence
            });

            await bus.publishOutboundMessageDelivered(
              createOutboundMessageDeliveredEvent({
                requestEvent: event,
                producerService: "discord-egress-service",
                transportMessageId: firstSent?.id ?? null
              })
            );
          } catch (error) {
            const reason = error instanceof Error ? error.message : "unknown discord delivery failure";
            logger.error({ err: error, eventId: event.eventId }, "Failed to deliver outbound Discord message");
            await bus.publishOutboundMessageDeliveryFailed(
              createOutboundMessageDeliveryFailedEvent({
                requestEvent: event,
                producerService: "discord-egress-service",
                reason
              })
            );
          }
        }
      );
    });
  });
}

async function deliverDiscordMessage(params: {
  client: DiscordEgressClient;
  event: OutboundMessageRequestedEvent;
  persistence: Persistence;
}): Promise<Message<boolean> | null> {
  const { client, event, persistence } = params;
  const chunks = splitDiscordMessage(event.payload.content);
  let firstSent: Message<boolean> | null = null;

  if (event.payload.delivery.kind === "reply") {
    const channel = await client.channels.fetch(event.payload.delivery.channelId);
    if (!channel || !channel.isSendable()) {
      throw new Error(`Unable to route outbound Discord message to channel ${event.payload.delivery.channelId}`);
    }

    const sent = await channel.send({
      content: chunks[0] ?? event.payload.content,
      reply: {
        messageReference: event.payload.delivery.replyTo,
        failIfNotExists: true
      }
    });
    firstSent = persistSentDiscordMessage({ client, persistence, sent });

    for (const chunk of chunks.slice(1)) {
      const followUp = await channel.send(chunk);
      persistSentDiscordMessage({ client, persistence, sent: followUp });
    }
  } else {
    const recipient = await client.users.fetch(event.payload.delivery.recipientActorId);
    const sent = await recipient.send(chunks[0] ?? event.payload.content);
    firstSent = persistSentDiscordMessage({ client, persistence, sent });

    if (!sent.channel.isSendable()) {
      throw new Error("Unable to send follow-up Discord direct-message chunk");
    }

    for (const chunk of chunks.slice(1)) {
      const followUp = await sent.channel.send(chunk);
      persistSentDiscordMessage({ client, persistence, sent: followUp });
    }
  }

  if (firstSent && event.payload.recordConversationTurn) {
    persistence.saveConversationTurn({
      conversationId: event.correlation.conversationId ?? "",
      role: "assistant",
      participantActorId: client.user!.id,
      participantDisplayName: client.user!.username,
      participantKind: "assistant",
      content: event.payload.content,
      sourceMessageId: firstSent.id,
      createdAt: firstSent.createdAt.toISOString()
    });
  }

  return firstSent;
}

function persistSentDiscordMessage(params: {
  client: DiscordEgressClient;
  persistence: Persistence;
  sent: Message<boolean>;
}) {
  const { client, persistence, sent } = params;
  const normalizedSent = normalizeMessage(sent, {
    botUserId: client.user!.id,
    botUsername: client.user!.username,
    botRoleIds: sent.guild?.members.me?.roles.cache.map((role) => role.id) ?? []
  });
  persistence.saveNormalizedMessage(normalizedSent);
  return sent;
}

export function registerDiscordEgressLifecycleLogging(params: {
  client: Client;
  logger: Logger;
}) {
  const { client, logger } = params;

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      {
        botUserId: readyClient.user.id,
        botUsername: readyClient.user.username
      },
      "Discord egress client connected"
    );
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord egress client error");
  });
}
