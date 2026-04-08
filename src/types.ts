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

export interface ReminderRecord {
  id: number;
  message: string;
  status: "pending" | "acknowledged";
  dueAt: string;
  nextNotificationAt: string | null;
  notificationCount: number;
  lastNotifiedAt: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface ReminderEvent {
  id: number;
  reminderId: number;
  eventType: "created" | "notified" | "acknowledged" | "delivery_failed";
  detail: string | null;
  createdAt: string;
}

export interface OutlookCalendarEvent {
  id: string;
  subject: string;
  startAt: string;
  endAt: string;
  webLink: string | null;
}
