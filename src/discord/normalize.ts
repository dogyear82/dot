import type { Message } from "discord.js";

import type { IncomingMessage } from "../types.js";

export function normalizeMessage(
  message: Message<boolean>,
  params: { botUserId: string; botUsername: string; botRoleIds?: string[] }
): IncomingMessage {
  const { botUserId, botUsername, botRoleIds = [] } = params;
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId ?? null,
    authorId: message.author.id,
    authorUsername: message.author.username,
    content: message.content,
    isDirectMessage: message.guildId == null,
    mentionedBot: mentionsBotUserOrRole(message, { botUserId, botRoleIds }),
    createdAt: message.createdAt.toISOString()
  };
}

export function stripLeadingBotAddress(content: string, params: { botUserId: string; botUsername: string; botRoleIds?: string[] }): string {
  const { botUserId, botUsername, botRoleIds = [] } = params;
  const roleAlternation = botRoleIds.map((roleId) => `<@&${escapeRegExp(roleId)}>`).join("|");
  const mentionAlternation = [`<@!?${escapeRegExp(botUserId)}>`];
  if (roleAlternation) {
    mentionAlternation.push(roleAlternation);
  }
  const mentionPattern = new RegExp(`^(?:(${mentionAlternation.join("|")})\\s*)+`);
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

function mentionsBotUserOrRole(
  message: Message<boolean>,
  params: { botUserId: string; botRoleIds: string[] }
): boolean {
  if (message.mentions.users.has(params.botUserId)) {
    return true;
  }

  if (params.botRoleIds.length === 0) {
    return false;
  }

  return message.mentions.roles.some((role) => params.botRoleIds.includes(role.id));
}
