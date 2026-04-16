import type { IncomingMessage } from "../types.js";

export interface AddressednessDecision {
  addressed: boolean;
  reason:
    | "direct_message"
    | "explicit_mention"
    | "reply_to_dot"
    | "explicit_command"
    | "active_pending_tool_session"
    | "llm_addressed"
    | "llm_not_addressed";
}

export function evaluateDeterministicAddressednessFastPath(params: {
  message: IncomingMessage;
  isExplicitCommand: boolean;
  hasPendingToolSession: boolean;
}): AddressednessDecision | null {
  const { message, isExplicitCommand, hasPendingToolSession } = params;

  if (message.isDirectMessage) {
    return { addressed: true, reason: "direct_message" };
  }

  if (isExplicitCommand) {
    return { addressed: true, reason: "explicit_command" };
  }

  if (message.mentionedBot) {
    return { addressed: true, reason: "explicit_mention" };
  }

  if (Boolean(message.repliedToBot)) {
    return { addressed: true, reason: "reply_to_dot" };
  }

  if (hasPendingToolSession) {
    return { addressed: true, reason: "active_pending_tool_session" };
  }

  return null;
}
