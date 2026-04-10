export type ActorRole = "owner" | "non-owner";

export interface AccessDecision {
  actorRole: ActorRole;
  canUsePrivilegedFeatures: boolean;
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
      canUsePrivilegedFeatures: true
    };
  }

  return {
    actorRole,
    canUsePrivilegedFeatures: false
  };
}
