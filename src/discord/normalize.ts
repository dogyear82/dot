import type { Message } from "discord.js";

import type { IncomingMessage } from "../types.js";

export function normalizeMessage(
  message: Message<boolean>,
  params: { botUserId: string; botUsername: string }
): IncomingMessage {
  const { botUserId, botUsername } = params;
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId ?? null,
    authorId: message.author.id,
    authorUsername: message.author.username,
    content: message.content,
    isDirectMessage: message.guildId == null,
    mentionedBot: mentionsBotUserOrMatchingRole(message, { botUserId, botUsername }),
    createdAt: message.createdAt.toISOString()
  };
}

export function stripLeadingBotAddress(content: string, params: { botUserId: string; botUsername: string }): string {
  const { botUserId, botUsername } = params;
  const mentionPattern = new RegExp(`^(?:(?:<@!?${botUserId}>|<@&\\d+>)\\s*)+`);
  const strippedMention = content.replace(mentionPattern, "").trim();
  if (strippedMention !== content.trim()) {
    return strippedMention;
  }

  if (!botUsername.trim()) {
    return content.trim();
  }

  const escapedUsername = escapeRegExp(botUsername.trim());
  const plainTextPattern = new RegExp(`^@?${escapedUsername}\\b[,:;!?-]*\\s*`, "i");
  return content.replace(plainTextPattern, "").trim();
}

export function stripLeadingBotMention(content: string, botUserId: string): string {
  const mentionPattern = new RegExp(`^(?:<@!?${botUserId}>\\s*)+`);
  return content.replace(mentionPattern, "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsBotUserOrMatchingRole(
  message: Message<boolean>,
  params: { botUserId: string; botUsername: string }
): boolean {
  if (message.mentions.users.has(params.botUserId)) {
    return true;
  }

  const normalizedBotName = params.botUsername.trim().toLowerCase();
  if (!normalizedBotName) {
    return false;
  }

  return message.mentions.roles.some((role) => role.name.trim().toLowerCase() === normalizedBotName);
}
