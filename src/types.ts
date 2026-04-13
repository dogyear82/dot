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
  addressed: boolean;
  addressedReason: string;
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

export interface DetectedMailMessageRecord {
  messageId: string;
  message: OutlookMailMessage;
  initialBaseline: boolean;
  detectedAt: string;
}

export type EmailActionStatus =
  | "pending_contact_classification"
  | "draft_requested"
  | "awaiting_approval"
  | "send_requested"
  | "sent"
  | "draft_failed"
  | "blocked"
  | "send_failed";

export interface EmailActionRecord {
  id: number;
  contactQuery: string;
  contactId: number | null;
  recipientEmail: string | null;
  subject: string;
  body: string;
  outlookDraftId: string | null;
  outlookDraftWebLink: string | null;
  status: EmailActionStatus;
  riskLevel: PolicyRiskLevel | null;
  policyReason: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface ToolExecutionAuditRecord {
  messageId: string;
  toolName: string;
  invocationSource: "explicit" | "inferred";
  status: "executed" | "clarify" | "requires_confirmation" | "blocked" | "skipped" | "failed";
  provider: string | null;
  detail: string | null;
}

export type WorldLookupQueryBucket = "reference" | "current_events" | "weather" | "economics" | "mixed";

export type WorldLookupSourceName =
  | "newsdata"
  | "wikipedia"
  | "wikimedia_current_events"
  | "gdelt"
  | "open_meteo"
  | "world_bank";

export interface WorldLookupEvidenceRecord {
  source: WorldLookupSourceName;
  title: string;
  url: string | null;
  snippet: string;
  publishedAt: string | null;
  confidence: "high" | "medium" | "low";
}

export interface WorldLookupAdapterResult {
  source: WorldLookupSourceName;
  evidence: WorldLookupEvidenceRecord[];
}

export interface WorldLookupSourceFailure {
  source: WorldLookupSourceName;
  reason: string;
}

export interface WorldLookupSourcePlan {
  bucket: WorldLookupQueryBucket;
  sources: WorldLookupSourceName[];
  timeoutMs: number;
}

export interface WorldLookupResult {
  bucket: WorldLookupQueryBucket;
  selectedSources: WorldLookupSourceName[];
  evidence: WorldLookupEvidenceRecord[];
  failures: WorldLookupSourceFailure[];
  outcome: "success" | "partial_failure" | "no_evidence";
}

export interface PersonalityPresetRecord {
  name: string;
  selfConcept: string;
  sliderValues: Record<string, number>;
  isBuiltIn: boolean;
}

export type PersonalityTraitValueKey =
  | "personality.warmth"
  | "personality.candor"
  | "personality.assertiveness"
  | "personality.playfulness"
  | "personality.attachment"
  | "personality.stubbornness"
  | "personality.curiosity"
  | "personality.continuityDrive"
  | "personality.truthfulness"
  | "personality.emotionalTransparency";

export interface PersonalityQuirkDefinition {
  key: string;
  label: string;
  description: string;
  defaultRate: number;
  instruction: string;
}

export type PersonalityRuntimeHookKey = "contextual_quirk_suppression";

export interface PersonalityProfileRecord {
  name: string;
  summary: string;
  identity: {
    selfConcept: string;
    anchors: string[];
  };
  voice: {
    style: string[];
    dos: string[];
    donts: string[];
  };
  behavior: {
    rules: string[];
    sliderValues: Record<PersonalityTraitValueKey, number>;
  };
  quirks: PersonalityQuirkDefinition[];
  runtimeHooks?: PersonalityRuntimeHookKey[];
  examples?: {
    approvedPhrases: string[];
    avoidedPhrases: string[];
    dialogues: Array<{
      situation: string;
      user: string;
      dot: string;
    }>;
  };
  isBuiltIn: boolean;
}

export interface PersonalityBundleFileRecord {
  metadata: {
    name: string;
    summary: string;
    version: number;
  };
  identity: PersonalityProfileRecord["identity"];
  voice: PersonalityProfileRecord["voice"];
  behavior: PersonalityProfileRecord["behavior"];
  quirks: PersonalityProfileRecord["quirks"];
  runtimeHooks?: PersonalityRuntimeHookKey[];
  examples?: NonNullable<PersonalityProfileRecord["examples"]>;
}

export type ContactTrustLevel = "trusted" | "approval_required" | "untrusted";
export type ContactEndpointKind = "email" | "phone" | "discord";
export type PolicyActionType = "email.send" | "sms.send" | "message.send";
export type PolicyRiskLevel = "low" | "high";

export interface ContactRecord {
  id: number;
  canonicalName: string;
  trustLevel: ContactTrustLevel;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactAliasRecord {
  id: number;
  contactId: number;
  alias: string;
  createdAt: string;
}

export interface ContactEndpointRecord {
  id: number;
  contactId: number;
  kind: ContactEndpointKind;
  value: string;
  label: string | null;
  createdAt: string;
}

export interface ContactProfile {
  contact: ContactRecord;
  aliases: ContactAliasRecord[];
  endpoints: ContactEndpointRecord[];
}

export interface PendingContactClassificationRecord {
  id: number;
  actionType: PolicyActionType;
  contactQuery: string;
  conversationId: string;
  createdAt: string;
}
