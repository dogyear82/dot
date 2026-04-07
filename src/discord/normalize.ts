import type { Message } from "discord.js";

import type { IncomingMessage } from "../types.js";

export function normalizeMessage(message: Message<boolean>, botUserId: string): IncomingMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId ?? null,
    authorId: message.author.id,
    authorUsername: message.author.username,
    content: message.content,
    isDirectMessage: message.guildId == null,
    mentionedBot: message.mentions.users.has(botUserId),
    createdAt: message.createdAt.toISOString()
  };
}
