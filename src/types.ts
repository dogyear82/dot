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

export interface ConversationTurnRecord {
  id: number;
  conversationId: string;
  role: "user" | "assistant";
  participantActorId: string | null;
  content: string;
  sourceMessageId: string | null;
  createdAt: string;
}

export type ServiceHealthStatus = "good" | "bad" | "offline";

export interface ServiceHealthSnapshotRecord {
  service: string;
  checkName: string;
  status: ServiceHealthStatus;
  state: string | null;
  detail: string | null;
  observedLatencyMs: number | null;
  sourceEventId: string | null;
  lastEventId: string;
  updatedAt: string;
}

export interface DiagnosticEventRecord {
  eventId: string;
  eventType: string;
  producerService: string;
  correlationId: string | null;
  causationId: string | null;
  conversationId: string | null;
  actorId: string | null;
  severity: "debug" | "info" | "warn" | "error";
  category: string | null;
  occurredAt: string;
}

export interface AccessAuditRecord {
  messageId: string;
  actorRole: "owner" | "non-owner";
  canUsePrivilegedFeatures: boolean;
  decision: "owner-allowed" | "non-owner-routed";
  transport: string;
  conversationId: string;
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

export interface OutlookMailMessage {
  id: string;
  subject: string;
  from: string | null;
  receivedAt: string;
  bodyPreview: string;
  parentFolderId: string | null;
  webLink: string | null;
}

export interface OutlookMailFolder {
  id: string;
  displayName: string;
}

export type MailTriageOutcome = "dot_approved" | "needs_attention" | "ignore";
export type MailTriageSource = "whitelist" | "heuristic" | "llm" | "fallback";

export interface MailTriageDecisionRecord {
  messageId: string;
  senderEmail: string | null;
  outcome: MailTriageOutcome;
  source: MailTriageSource;
  reason: string;
  route: "none" | "deterministic" | "local" | "hosted";
  sourceFolderId: string | null;
  destinationFolderId: string | null;
  triagedAt: string;
  movedAt: string | null;
}

export interface OAuthTokenRecord {
  provider: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scope: string | null;
  tokenType: string;
}

export interface OAuthDeviceFlowRecord {
  provider: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: string;
  intervalSeconds: number;
  message: string;
}

export interface ToolExecutionAuditRecord {
  messageId: string;
  toolName: string;
  invocationSource: "explicit" | "inferred";
  status: "executed" | "clarify" | "skipped" | "failed";
  provider: string | null;
  detail: string | null;
}

export interface PersonalityPresetRecord {
  name: string;
  selfConcept: string;
  sliderValues: Record<string, number>;
  isBuiltIn: boolean;
}
