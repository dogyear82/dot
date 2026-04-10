import type { ConversationTurnRecord, IncomingMessage } from "../types.js";

const RECENT_ASSISTANT_CONTEXT_WINDOW_MS = 5 * 60 * 1000;

export function shouldTreatOwnerMessageAsAddressed(params: {
  message: IncomingMessage;
  defaultChannelPolicy: string | null;
  recentConversation: ConversationTurnRecord[];
  recentMessages: IncomingMessage[];
}): boolean {
  const { message, recentConversation, recentMessages } = params;

  if (message.isDirectMessage || message.mentionedBot) {
    return true;
  }

  if (looksLikeExplicitCommand(message.content)) {
    return true;
  }

  if (looksLikePlainTextDirectAddress(normalizeContent(message.content))) {
    return true;
  }

  const mostRecentTurn = recentConversation.at(-1);
  if (!mostRecentTurn || mostRecentTurn.role !== "assistant") {
    return false;
  }

  if (mostRecentTurn.participantActorId == null || mostRecentTurn.participantActorId !== message.authorId) {
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

function looksLikeExplicitCommand(content: string): boolean {
  return content.trimStart().startsWith("!");
}

function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/[,:;!?]+/g, "").replace(/\s+/g, " ");
}
