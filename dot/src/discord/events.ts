import { resolveActorRole } from "../auth.js";
import { DOT_EVENT_VERSION, type InboundMessageReceivedEvent } from "../events.js";
import { renderBotReferences, stripLeadingBotAddress } from "./normalize.js";
import type { IncomingMessage } from "../types.js";

export function createDiscordInboundMessageEvent(params: {
  message: IncomingMessage;
  botUserId: string;
  botUsername: string;
  botRoleIds?: string[];
  ownerUserId: string;
}): InboundMessageReceivedEvent {
  const { message, botUserId, botUsername, botRoleIds = [], ownerUserId } = params;
  const renderedContent = renderBotReferences(message.content, {
    botUserId,
    botUsername,
    botRoleIds
  });
  const addressedContent = stripLeadingBotAddress(renderedContent, {
    botUserId,
    botUsername,
    botRoleIds: []
  });

  return {
    eventId: `discord:${message.id}`,
    eventType: "inbound.message.received",
    eventVersion: DOT_EVENT_VERSION,
    occurredAt: message.createdAt,
    producer: {
      service: "discord-ingress"
    },
    correlation: {
      correlationId: message.id,
      causationId: null,
      conversationId: message.channelId,
      actorId: message.authorId
    },
    routing: {
      transport: "discord",
      channelId: message.channelId,
      guildId: message.guildId,
      replyTo: message.id
    },
    diagnostics: {
      severity: "info",
      category: "discord.inbound"
    },
    payload: {
      messageId: message.id,
      sender: {
        actorId: message.authorId,
        displayName: message.authorUsername,
        actorRole: resolveActorRole(message.authorId, ownerUserId)
      },
      content: renderedContent,
      addressedContent,
      isDirectMessage: message.isDirectMessage,
      mentionedBot: message.mentionedBot,
      repliedToMessageId: message.repliedToMessageId ?? null,
      repliedToBot: Boolean(message.repliedToBot),
      replyRoute: {
        transport: "discord",
        channelId: message.channelId,
        guildId: message.guildId,
        replyTo: message.id
      }
    }
  };
}
