import { resolveActorRole } from "../auth.js";
import type { InboundMessageReceivedEvent } from "../events.js";
import type { IncomingMessage } from "../types.js";
import { stripLeadingBotMention } from "./normalize.js";

export function createDiscordInboundMessageEvent(params: {
  message: IncomingMessage;
  botUserId: string;
  ownerUserId: string;
}): InboundMessageReceivedEvent {
  const { message, botUserId, ownerUserId } = params;
  const addressedContent =
    message.isDirectMessage || !message.mentionedBot
      ? message.content
      : stripLeadingBotMention(message.content, botUserId);

  return {
    eventId: `discord:${message.id}`,
    eventType: "inbound.message.received",
    occurredAt: message.createdAt,
    transport: "discord",
    conversationId: message.channelId,
    sourceMessageId: message.id,
    correlationId: message.id,
    sender: {
      actorId: message.authorId,
      displayName: message.authorUsername,
      actorRole: resolveActorRole(message.authorId, ownerUserId)
    },
    replyRoute: {
      transport: "discord",
      channelId: message.channelId,
      guildId: message.guildId,
      replyToMessageId: message.id
    },
    payload: {
      content: message.content,
      addressedContent,
      isDirectMessage: message.isDirectMessage,
      mentionedBot: message.mentionedBot
    }
  };
}
