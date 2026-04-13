import type { ConversationTurnRecord, IncomingMessage } from "../types.js";

const RECENT_ASSISTANT_CONTEXT_WINDOW_MS = 2 * 60 * 1000;

export interface AddressednessDecision {
  addressed: boolean;
  reason:
    | "direct_message"
    | "explicit_mention"
    | "explicit_command"
    | "plain_text_direct_address"
    | "no_recent_assistant_turn"
    | "recent_turn_not_assistant"
    | "recent_turn_for_different_participant"
    | "invalid_timestamp"
    | "follow_up_context_stale"
    | "intervening_other_participant_message"
    | "recent_message_not_addressed_to_dot"
    | "follow_up_context_preserved";
}

export function evaluateAddressedness(params: {
  message: IncomingMessage;
  defaultChannelPolicy: string | null;
  recentConversation: ConversationTurnRecord[];
  recentMessages: IncomingMessage[];
}): AddressednessDecision {
  const { message, recentConversation, recentMessages } = params;

  if (message.isDirectMessage) {
    return { addressed: true, reason: "direct_message" };
  }

  if (message.mentionedBot) {
    return { addressed: true, reason: "explicit_mention" };
  }

  if (looksLikeExplicitCommand(message.content)) {
    return { addressed: true, reason: "explicit_command" };
  }

  if (looksLikePlainTextDirectAddress(normalizeContent(message.content))) {
    return { addressed: true, reason: "plain_text_direct_address" };
  }

  const mostRecentTurn = findMostRecentAssistantTurnForParticipant(recentConversation, message.authorId);
  if (!mostRecentTurn) {
    return { addressed: false, reason: "no_recent_assistant_turn" };
  }

  const currentCreatedAt = Date.parse(message.createdAt);
  const recentCreatedAt = Date.parse(mostRecentTurn.createdAt);
  if (Number.isNaN(currentCreatedAt) || Number.isNaN(recentCreatedAt)) {
    return { addressed: false, reason: "invalid_timestamp" };
  }

  if (currentCreatedAt - recentCreatedAt > RECENT_ASSISTANT_CONTEXT_WINDOW_MS) {
    return { addressed: false, reason: "follow_up_context_stale" };
  }

  const priorInboundMessages = recentMessages.filter((recentMessage) => recentMessage.id !== message.id);
  const assistantSourceMessageIds = new Set(
    recentConversation
      .filter((turn) => turn.role === "assistant" && turn.sourceMessageId != null)
      .map((turn) => turn.sourceMessageId as string)
  );

  for (const priorInboundMessage of priorInboundMessages) {
    if (assistantSourceMessageIds.has(priorInboundMessage.id)) {
      continue;
    }

    if (priorInboundMessage.authorId !== message.authorId) {
      return { addressed: false, reason: "intervening_other_participant_message" };
    }

    if (isMessageAddressedExplicitly(priorInboundMessage)) {
      return { addressed: true, reason: "follow_up_context_preserved" };
    }
  }

  return { addressed: false, reason: "recent_message_not_addressed_to_dot" };
}

export function shouldTreatOwnerMessageAsAddressed(params: {
  message: IncomingMessage;
  defaultChannelPolicy: string | null;
  recentConversation: ConversationTurnRecord[];
  recentMessages: IncomingMessage[];
}): boolean {
  return evaluateAddressedness(params).addressed;
}

function isMessageAddressedExplicitly(message: IncomingMessage): boolean {
  return (
    message.isDirectMessage ||
    message.mentionedBot ||
    looksLikeExplicitCommand(message.content) ||
    looksLikePlainTextDirectAddress(normalizeContent(message.content))
  );
}

function findMostRecentAssistantTurnForParticipant(
  recentConversation: ConversationTurnRecord[],
  participantActorId: string
): ConversationTurnRecord | null {
  for (let index = recentConversation.length - 1; index >= 0; index -= 1) {
    const turn = recentConversation[index];
    if (turn.role !== "assistant") {
      continue;
    }

    if (turn.participantActorId == null) {
      continue;
    }

    if (turn.participantActorId === participantActorId) {
      return turn;
    }
  }

  return null;
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
