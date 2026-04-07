export type ActorRole = "owner" | "non-owner";

export interface AccessDecision {
  actorRole: ActorRole;
  canUsePrivilegedFeatures: boolean;
  shouldReply: boolean;
  responseMessage?: string;
}

export function resolveActorRole(authorId: string, ownerUserId: string): ActorRole {
  return authorId === ownerUserId ? "owner" : "non-owner";
}

export function evaluateAccess(params: {
  authorId: string;
  ownerUserId: string;
  isDirectMessage: boolean;
  mentionedBot: boolean;
}): AccessDecision {
  const actorRole = resolveActorRole(params.authorId, params.ownerUserId);

  if (actorRole === "owner") {
    return {
      actorRole,
      canUsePrivilegedFeatures: true,
      shouldReply: false
    };
  }

  const shouldReply = params.isDirectMessage || params.mentionedBot;

  return {
    actorRole,
    canUsePrivilegedFeatures: false,
    shouldReply,
    responseMessage: shouldReply
      ? "I can only help non-owner users get in touch with the owner. I can't run commands or privileged actions for you."
      : undefined
  };
}
