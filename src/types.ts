export interface IncomingMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  authorUsername: string;
  content: string;
  isDirectMessage: boolean;
  mentionedBot: boolean;
  createdAt: string;
}

export interface AccessAuditRecord {
  messageId: string;
  actorRole: "owner" | "non-owner";
  canUsePrivilegedFeatures: boolean;
  decision: "owner-allowed" | "non-owner-routed";
}
