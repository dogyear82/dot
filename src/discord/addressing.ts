import type { ConversationTurnRecord, IncomingMessage } from "../types.js";

const RECENT_ASSISTANT_CONTEXT_WINDOW_MS = 5 * 60 * 1000;

export function shouldTreatOwnerMessageAsAddressed(params: {
  message: IncomingMessage;
  defaultChannelPolicy: string | null;
  recentConversation: ConversationTurnRecord[];
  recentMessages: IncomingMessage[];
}): boolean {
  const { message, defaultChannelPolicy, recentConversation, recentMessages } = params;

  if (message.isDirectMessage || message.mentionedBot) {
    return true;
  }

  if (defaultChannelPolicy === "dm-only") {
    return false;
  }

  if (looksLikePlainTextDirectAddress(normalizeContent(message.content))) {
    return true;
  }

  const mostRecentTurn = recentConversation.at(-1);
  if (!mostRecentTurn || mostRecentTurn.role !== "assistant") {
    return false;
  }

  const currentCreatedAt = Date.parse(message.createdAt);
  const recentCreatedAt = Date.parse(mostRecentTurn.createdAt);
  if (Number.isNaN(currentCreatedAt) || Number.isNaN(recentCreatedAt)) {
    return false;
  }

  const mostRecentPriorInbound = recentMessages.find((recentMessage) => recentMessage.id !== message.id);
  if (mostRecentPriorInbound) {
    const priorInboundCreatedAt = Date.parse(mostRecentPriorInbound.createdAt);
    if (!Number.isNaN(priorInboundCreatedAt) && priorInboundCreatedAt > recentCreatedAt) {
      return false;
    }
  }

  return currentCreatedAt - recentCreatedAt <= RECENT_ASSISTANT_CONTEXT_WINDOW_MS;
}

function looksLikePlainTextDirectAddress(content: string): boolean {
  return /^(?:dot|hey dot|hi dot|hello dot|ok dot|okay dot|so dot|well dot)\b/.test(content);
}

function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/[,:;!?]+/g, "").replace(/\s+/g, " ");
}
