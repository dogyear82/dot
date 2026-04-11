import { resolveActorRole } from "../auth.js";
import type { InboundMessageReceivedEvent } from "../events.js";
import type { IncomingMessage } from "../types.js";
import { stripLeadingBotAddress, stripLeadingBotMention } from "./normalize.js";

export function createDiscordInboundMessageEvent(params: {
  message: IncomingMessage;
  botUserId: string;
  botUsername: string;
  ownerUserId: string;
}): InboundMessageReceivedEvent {
  const { message, botUserId, botUsername, ownerUserId } = params;
  const addressedContent = message.isDirectMessage
    ? message.content
    : message.mentionedBot
      ? stripLeadingBotMention(message.content, botUserId).replace(/^(?:<@&\d+>\s*)+/, "").trim()
      : stripLeadingBotAddress(message.content, { botUserId, botUsername });

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
