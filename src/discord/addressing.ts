import type { IncomingMessage } from "../types.js";

const RECENT_BOT_CONTEXT_WINDOW_MS = 5 * 60 * 1000;
const RECENT_CHANNEL_MESSAGE_LIMIT = 3;

export function shouldTreatOwnerMessageAsAddressed(params: {
  message: IncomingMessage;
  botUserId: string;
  defaultChannelPolicy: string | null;
  recentMessages: IncomingMessage[];
}): boolean {
  const { message, botUserId, defaultChannelPolicy, recentMessages } = params;

  if (message.isDirectMessage || message.mentionedBot) {
    return true;
  }

  if (defaultChannelPolicy === "dm-only") {
    return false;
  }

  const normalizedContent = normalizeContent(message.content);
  if (looksLikePlainTextDirectAddress(normalizedContent)) {
    return true;
  }

  const recentRelevantMessages = recentMessages
    .filter((recentMessage) => recentMessage.id !== message.id)
    .slice(0, RECENT_CHANNEL_MESSAGE_LIMIT);
  const mostRecentMessage = recentRelevantMessages[0];

  if (!mostRecentMessage || mostRecentMessage.authorId !== botUserId) {
    return false;
  }

  const currentCreatedAt = Date.parse(message.createdAt);
  const recentCreatedAt = Date.parse(mostRecentMessage.createdAt);
  if (Number.isNaN(currentCreatedAt) || Number.isNaN(recentCreatedAt)) {
    return false;
  }

  return currentCreatedAt - recentCreatedAt <= RECENT_BOT_CONTEXT_WINDOW_MS;
}

function looksLikePlainTextDirectAddress(content: string): boolean {
  return /^(?:dot|hey dot|hi dot|hello dot|ok dot|okay dot|so dot|well dot)\b/.test(content);
}

function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/[,:;!?]+/g, "").replace(/\s+/g, " ");
}
