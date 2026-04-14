import type { Persistence } from "./persistence.js";
import { SpanKind } from "@opentelemetry/api";
import { withSpan } from "./observability.js";
import { handleCalendarCommand, type OutlookCalendarClient } from "./outlookCalendar.js";
import { createPolicyEngine, type PolicyDecision } from "./policyEngine.js";
import { getNewsPreferences } from "./newsPreferences.js";
import { handleReminderCommand } from "./reminders.js";
import type {
  NewsPreferences,
  NewsBrowseSessionItemRecord,
  PolicyActionType,
  WorldLookupArticleRecord,
  WorldLookupQueryBucket,
  WorldLookupResult,
  WorldLookupSourceFailure,
  WorldLookupSourceName
} from "./types.js";
import { executeWorldLookup, type WorldLookupAdapter } from "./worldLookup.js";
import { HtmlWorldLookupArticleReader, type WorldLookupArticleReader } from "./worldLookupArticles.js";
import { createDefaultWorldLookupAdapters } from "./worldLookupAdapters.js";

export type ExplicitToolName =
  | "reminder.add"
  | "reminder.show"
  | "reminder.ack"
  | "calendar.show"
  | "calendar.remind"
  | "news.briefing"
  | "news.follow_up"
  | "world.lookup";

export type ConversationalIntentDecision =
  | {
      decision: "respond";
      reason: string;
      response: string;
    }
  | {
      decision: "execute_tool";
      toolName: ExplicitToolName;
      reason: string;
      confidence: "medium" | "high";
      args: Record<string, string | number>;
    };

export type ToolDecision =
  | {
      decision: "none";
      reason: string;
    }
  | {
      decision: "clarify";
      toolName: ExplicitToolName;
      reason: string;
      question: string;
    }
  | {
      decision: "execute";
      toolName: ExplicitToolName;
      reason: string;
      args: Record<string, string | number>;
    };

export interface ToolExecutionResult {
  toolName: ExplicitToolName;
  status: "executed" | "clarify" | "requires_confirmation" | "blocked";
  reply: string;
  detail?: string;
  policyDecision?: PolicyDecision;
  route?: ToolExecutionRoute;
}

export type ToolExecutionRoute = "none" | "deterministic" | "local" | "hosted";

export interface GroundedAnswerService {
  generateGroundedReply(params: {
    userMessage: string;
    evidence: WorldLookupResult["evidence"];
    articles?: WorldLookupArticleRecord[];
    bucket: WorldLookupQueryBucket;
    selectedSources: WorldLookupSourceName[];
    failures: WorldLookupSourceFailure[];
    outcome: WorldLookupResult["outcome"];
  }): Promise<{ route: ToolExecutionRoute; powerStatus: "off" | "standby" | "engaged"; reply: string }>;
  generateNewsBriefingReply?(params: {
    userMessage: string;
    evidence: WorldLookupResult["evidence"];
    selectedSources: WorldLookupSourceName[];
    failures: WorldLookupSourceFailure[];
    outcome: WorldLookupResult["outcome"];
  }): Promise<{ route: ToolExecutionRoute; powerStatus: "off" | "standby" | "engaged"; reply: string }>;
  generateStoryFollowUpReply?(params: {
    userMessage: string;
    selectedItem: NewsBrowseSessionItemRecord;
    evidence: WorldLookupResult["evidence"];
    articles?: WorldLookupArticleRecord[];
  }): Promise<{ route: ToolExecutionRoute; powerStatus: "off" | "standby" | "engaged"; reply: string }>;
}

interface ToolDefinition {
  toolName: ExplicitToolName;
  execute(params: {
    calendarClient: OutlookCalendarClient;
    args: Record<string, string | number>;
    persistence: Persistence;
    conversationId?: string;
    groundedAnswerService?: GroundedAnswerService;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
    articleReader?: WorldLookupArticleReader;
  }): Promise<string> | string;
  executeDetailed?(params: {
    args: Record<string, string | number>;
    persistence: Persistence;
    conversationId?: string;
    groundedAnswerService?: GroundedAnswerService;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
    articleReader?: WorldLookupArticleReader;
  }): Promise<ToolExecutionResult>;
  policy?: {
    actionType: PolicyActionType;
    getContactQuery(args: Record<string, string | number>): string | null;
  };
}

const TOOL_DEFINITIONS: Record<ExplicitToolName, ToolDefinition> = {
  "reminder.add": {
    toolName: "reminder.add",
    execute({ args, persistence }) {
      const duration = getRequiredStringArg(args, "duration");
      const message = getRequiredStringArg(args, "message");
      return handleReminderCommand(persistence, `!reminder add ${duration} ${message}`);
    }
  },
  "reminder.show": {
    toolName: "reminder.show",
    execute({ persistence }) {
      return handleReminderCommand(persistence, "!reminder show");
    }
  },
  "reminder.ack": {
    toolName: "reminder.ack",
    execute({ args, persistence }) {
      const id = getRequiredNumericLikeArg(args, "id");
      return handleReminderCommand(persistence, `!reminder ack ${id}`);
    }
  },
  "calendar.show": {
    toolName: "calendar.show",
    execute({ calendarClient, persistence }) {
      return handleCalendarCommand({
        calendarClient,
        content: "!calendar show",
        persistence
      });
    }
  },
  "calendar.remind": {
    toolName: "calendar.remind",
    execute({ calendarClient, args, persistence }) {
      const index = getRequiredNumericLikeArg(args, "index");
      const leadTime = getOptionalStringArg(args, "leadTime");
      const content = leadTime ? `!calendar remind ${index} ${leadTime}` : `!calendar remind ${index}`;
      return handleCalendarCommand({
        calendarClient,
        content,
        persistence
      });
    }
  },
  "news.briefing": {
    toolName: "news.briefing",
    async executeDetailed({ args, persistence, conversationId, groundedAnswerService, worldLookupAdapters }) {
      const query = getRequiredStringArg(args, "query");
      const newsPreferences = getNewsPreferences(persistence.settings);
      const lookupResult = await executeWorldLookup({
        query,
        adapters: worldLookupAdapters ?? createDefaultWorldLookupAdapters(),
        preferences: newsPreferences,
        maxEvidenceCount: 8
      });

      const detail = buildNewsBriefingAuditDetail(lookupResult, newsPreferences);
      if (conversationId) {
        persistence.saveNewsBrowseSession({
          kind: "briefing",
          conversationId,
          query,
          savedAt: new Date().toISOString(),
          items: lookupResult.evidence.map((record, index) => ({
            ordinal: index + 1,
            title: record.title,
            url: record.url,
            source: record.source,
            publisher: record.publisher ?? null,
            snippet: record.snippet,
            publishedAt: record.publishedAt
          }))
        });
      }

      if (!groundedAnswerService?.generateNewsBriefingReply) {
        return {
          toolName: "news.briefing",
          status: "executed",
          reply: buildNewsBriefingFallbackReply(lookupResult),
          detail
        };
      }

      try {
        const grounded = await groundedAnswerService.generateNewsBriefingReply({
          userMessage: query,
          evidence: lookupResult.evidence,
          selectedSources: lookupResult.selectedSources,
          failures: lookupResult.failures,
          outcome: lookupResult.outcome
        });

        return {
          toolName: "news.briefing",
          status: "executed",
          reply: grounded.reply,
          detail,
          route: grounded.route
        };
      } catch {
        return {
          toolName: "news.briefing",
          status: "executed",
          reply: buildNewsBriefingFallbackReply(lookupResult),
          detail
        };
      }
    },
    execute() {
      throw new Error("news.briefing requires detailed execution");
    }
  },
  "news.follow_up": {
    toolName: "news.follow_up",
    async executeDetailed({ args, persistence, conversationId, groundedAnswerService, articleReader }) {
      const query = getRequiredStringArg(args, "query");
      const session = conversationId ? persistence.getLatestNewsBrowseSession(conversationId) : null;
      if (!session) {
        return {
          toolName: "news.follow_up",
          status: "clarify",
          reply: "I don't have a recent news list in this conversation to follow up on yet.",
          detail: "newsSession=missing"
        };
      }

      const selectedItem = resolveNewsSessionItem(session.items, query);
      if (!selectedItem) {
        return {
          toolName: "news.follow_up",
          status: "clarify",
          reply: "I couldn't tell which story you meant from the last news list. Give me the number or the outlet name.",
          detail: "newsSession=unresolved"
        };
      }

      const evidence = [
        {
          source: selectedItem.source,
          title: selectedItem.title,
          url: selectedItem.url,
          snippet: selectedItem.snippet,
          publishedAt: selectedItem.publishedAt,
          publisher: selectedItem.publisher,
          confidence: "high" as const
        }
      ];
      const articleReadResult =
        selectedItem.url && groundedAnswerService?.generateStoryFollowUpReply
          ? await (articleReader ?? new HtmlWorldLookupArticleReader()).read({ evidence })
          : { articles: [], failures: [] };

      if (!groundedAnswerService?.generateStoryFollowUpReply) {
        return {
          toolName: "news.follow_up",
          status: "executed",
          reply: buildNewsFollowUpFallbackReply(selectedItem),
          detail: `newsSession=resolved; ordinal=${selectedItem.ordinal}; title=${selectedItem.title}; source=${selectedItem.source}`
        };
      }

      const grounded = await groundedAnswerService.generateStoryFollowUpReply({
        userMessage: query,
        selectedItem,
        evidence,
        articles: articleReadResult.articles
      });

      return {
        toolName: "news.follow_up",
        status: "executed",
        reply: grounded.reply,
        route: grounded.route,
        detail: `newsSession=resolved; ordinal=${selectedItem.ordinal}; title=${selectedItem.title}; source=${selectedItem.source}; articleReadCount=${articleReadResult.articles.length}`
      };
    },
    execute() {
      throw new Error("news.follow_up requires detailed execution");
    }
  },
  "world.lookup": {
    toolName: "world.lookup",
    async executeDetailed({ args, persistence, conversationId, groundedAnswerService, worldLookupAdapters, articleReader }) {
      const query = getRequiredStringArg(args, "query");
      const newsPreferences = getNewsPreferences(persistence.settings);
      const lookupResult = await executeWorldLookup({
        query,
        adapters: worldLookupAdapters ?? createDefaultWorldLookupAdapters(),
        preferences: newsPreferences
      });
      const articleReadResult =
        lookupResult.bucket === "current_events" && lookupResult.evidence.length > 0
          ? await (articleReader ?? new HtmlWorldLookupArticleReader()).read({
              evidence: lookupResult.evidence
            })
          : { articles: [], failures: [] };

      const topicSessionSaved =
        Boolean(conversationId) &&
        lookupResult.bucket === "current_events" &&
        lookupResult.retrievalStrategy === "current_events_topic_ranked" &&
        lookupResult.evidence.length > 0;

      if (topicSessionSaved && conversationId) {
        persistence.saveNewsBrowseSession({
          kind: "topic_lookup",
          conversationId,
          query,
          savedAt: new Date().toISOString(),
          items: lookupResult.evidence.map((record, index) => ({
            ordinal: index + 1,
            title: record.title,
            url: record.url,
            source: record.source,
            publisher: record.publisher ?? null,
            snippet: record.snippet,
            publishedAt: record.publishedAt
          }))
        });
      }

      const detail = buildWorldLookupAuditDetail(lookupResult, articleReadResult, newsPreferences, {
        topicSessionSaved
      });

      if (!groundedAnswerService) {
        return {
          toolName: "world.lookup",
          status: "executed",
          reply: buildWorldLookupFallbackReply(lookupResult),
          detail
        };
      }

      try {
        const grounded = await groundedAnswerService.generateGroundedReply({
          userMessage: query,
          evidence: lookupResult.evidence,
          articles: articleReadResult.articles,
          bucket: lookupResult.bucket,
          selectedSources: lookupResult.selectedSources,
          failures: lookupResult.failures,
          outcome: lookupResult.outcome
        });

        return {
          toolName: "world.lookup",
          status: "executed",
          reply: grounded.reply,
          detail,
          route: grounded.route
        };
      } catch {
        return {
          toolName: "world.lookup",
          status: "executed",
          reply: buildWorldLookupFallbackReply(lookupResult),
          detail
        };
      }
    },
    execute() {
      throw new Error("world.lookup requires detailed execution");
    }
  }
};

export function parseExplicitToolDecision(content: string): ToolDecision | null {
  const parts = content.trim().split(/\s+/);

  if (parts[0] === "!remind") {
    if (parts.length < 3) {
      return {
        decision: "clarify",
        toolName: "reminder.add",
        reason: "owner used the reminder shorthand without both duration and message",
        question: "When should I remind you, and what should I remind you about?"
      };
    }

    return {
      decision: "execute",
      toolName: "reminder.add",
      reason: "owner used the explicit reminder shorthand command",
      args: {
        duration: parts[1] ?? "",
        message: parts.slice(2).join(" ")
      }
    };
  }

  if (parts[0] !== "!reminder" && parts[0] !== "!calendar") {
    return null;
  }

  if (parts[0] === "!reminder") {
    if (parts.length === 1 || parts[1] === "help") {
      return null;
    }

    if (parts[1] === "show") {
      return {
        decision: "execute",
        toolName: "reminder.show",
        reason: "owner used the explicit reminder show command",
        args: {}
      };
    }

    if (parts[1] === "add") {
      if (parts.length < 4) {
        return {
          decision: "clarify",
          toolName: "reminder.add",
          reason: "owner used reminder add without both duration and message",
          question: "When should I remind you, and what should I remind you about?"
        };
      }

      return {
        decision: "execute",
        toolName: "reminder.add",
        reason: "owner used the explicit reminder add command",
        args: {
          duration: parts[2] ?? "",
          message: parts.slice(3).join(" ")
        }
      };
    }

    if (parts[1] === "ack") {
      if (parts.length < 3) {
        return {
          decision: "clarify",
          toolName: "reminder.ack",
          reason: "owner used reminder ack without a reminder id",
          question: "Which reminder should I acknowledge?"
        };
      }

      return {
        decision: "execute",
        toolName: "reminder.ack",
        reason: "owner used the explicit reminder acknowledge command",
        args: {
          id: parts[2] ?? ""
        }
      };
    }
  }

  if (parts[0] === "!calendar") {
    if (parts.length === 1 || parts[1] === "help" || parts[1] === "auth") {
      return null;
    }

    if (parts[1] === "show") {
      return {
        decision: "execute",
        toolName: "calendar.show",
        reason: "owner used the explicit calendar show command",
        args: {}
      };
    }

    if (parts[1] === "remind") {
      if (parts.length < 3) {
        return {
          decision: "clarify",
          toolName: "calendar.remind",
          reason: "owner used calendar remind without an event index",
          question: "Which calendar event should I create a reminder for? Use the index from `!calendar show`."
        };
      }

      return {
        decision: "execute",
        toolName: "calendar.remind",
        reason: "owner used the explicit calendar remind command",
        args: {
          index: parts[2] ?? "",
          ...(parts[3] ? { leadTime: parts[3] } : {})
        }
      };
    }
  }

  return null;
}

export function buildToolInferencePrompt(userMessage: string): string {
  return [
    "You decide whether Dot should answer directly or execute one of Dot's existing tools.",
    "Return only strict JSON with one of two decisions: respond or execute_tool.",
    "Use execute_tool only when the owner is reasonably clearly asking for an available tool.",
    "If the owner is simply chatting, correcting Dot, or asking something that does not clearly require a tool, return respond.",
    "If the owner seems to want a tool but key parameters are missing, return respond with a brief clarifying question.",
    "Supported tools and args:",
    "- reminder.add: duration, message",
    "- reminder.show: no args",
    "- reminder.ack: id",
    "- calendar.show: no args",
    "- calendar.remind: index, optional leadTime",
    "- news.briefing: query",
    "- news.follow_up: query",
    "- world.lookup: query",
    "Use news.briefing for generic requests like latest headlines, what's in the news today, or brief me on the news.",
    "Use news.follow_up when the owner is clearly referring back to a story from the latest news list.",
    "Use world.lookup for questions that need public factual grounding, current events, weather, economics, or information that may be outdated in-model.",
    "You may use the recent conversation context to recover the subject of a follow-up or correction when the latest message is elliptical.",
    "If the owner is correcting a stale or history-focused answer and asking for current events or news, prefer execute_tool world.lookup with a repaired query grounded in the recent conversation instead of a plain conversational response.",
    "When you choose world.lookup, preserve the owner's original wording as closely as possible in args.query.",
    "Do not collapse current-events phrasing like 'right now', 'latest', 'today', or 'what is happening' into a generic topic label.",
    "Never invent unsupported tools or free-form side effects.",
    "If you choose execute_tool, confidence must be either medium or high. Do not emit low confidence.",
    "Return strict JSON only in one of these shapes:",
    '{"decision":"respond","reason":"...","response":"..."}',
    '{"decision":"execute_tool","toolName":"reminder.add","reason":"...","confidence":"high","args":{"duration":"10m","message":"stretch"}}',
    '{"decision":"execute_tool","toolName":"calendar.show","reason":"owner is asking to see upcoming calendar items","confidence":"high","args":{}}',
    '{"decision":"execute_tool","toolName":"news.briefing","reason":"owner is asking for a news briefing","confidence":"high","args":{"query":"give me the latest headlines"}}',
    '{"decision":"execute_tool","toolName":"news.follow_up","reason":"owner is referring back to a story from the latest news list","confidence":"high","args":{"query":"tell me more about the second one"}}',
    '{"decision":"execute_tool","toolName":"world.lookup","reason":"owner is asking for public factual or current information","confidence":"high","args":{"query":"when is zebra mating season"}}',
    'Examples that should usually map to execute_tool calendar.show:',
    '- "what\'s my calendar looking like this week?"',
    '- "do i have any meetings or appointments today?"',
    '- "what is on my schedule tomorrow?"',
    'Examples that should usually map to execute_tool news.briefing:',
    '- "give me the latest headlines"',
    '- "what is in the news today?"',
    '- "brief me on the news"',
    'Examples that should usually map to execute_tool news.follow_up:',
    '- "tell me more about the second one"',
    '- "what about the Reuters one?"',
    'Examples that should usually map to execute_tool world.lookup:',
    '- "when are zebras mating season?"',
    '- "what is happening in Myanmar right now?"',
    '- "what\'s the weather in Phoenix tomorrow?"',
    '- "how is Argentina\'s economy doing?"',
    'Examples that should usually map to respond:',
    '- "how are you?"',
    '- "you got that one wrong"',
    '- "thanks"',
    `Owner message: ${JSON.stringify(userMessage)}`
  ].join("\n");
}

export function parseToolDecision(payload: string): ConversationalIntentDecision {
  const parsed = JSON.parse(extractJsonObject(payload)) as Partial<ConversationalIntentDecision> & {
    confidence?: unknown;
  };
  if (
    parsed.decision === "respond" &&
    typeof parsed.reason === "string" &&
    typeof parsed.response === "string" &&
    parsed.response.trim().length > 0
  ) {
    return {
      decision: "respond",
      reason: parsed.reason,
      response: parsed.response.trim()
    };
  }

  if (
    parsed.decision === "execute_tool" &&
    isToolName(parsed.toolName) &&
    typeof parsed.reason === "string" &&
    (parsed.confidence === "medium" || parsed.confidence === "high") &&
    parsed.args &&
    typeof parsed.args === "object"
  ) {
    return {
      decision: "execute_tool",
      toolName: parsed.toolName,
      reason: parsed.reason,
      confidence: parsed.confidence,
      args: parsed.args as Record<string, string | number>
    };
  }

  throw new Error("Conversational intent inference returned an invalid response");
}

export async function executeToolDecision(params: {
  calendarClient: OutlookCalendarClient;
  decision: Extract<ToolDecision, { decision: "execute" }>;
  persistence: Persistence;
  conversationId?: string;
  groundedAnswerService?: GroundedAnswerService;
  registry?: Partial<Record<ExplicitToolName, ToolDefinition>>;
  worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
  articleReader?: WorldLookupArticleReader;
}): Promise<ToolExecutionResult> {
  return withSpan(
    "tool.execute",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "dot.tool.name": params.decision.toolName
      }
    },
    async () => {
      const { calendarClient, decision, persistence } = params;
      const definition = params.registry?.[decision.toolName] ?? TOOL_DEFINITIONS[decision.toolName];
      if (!definition) {
        throw new Error(`Unsupported tool: ${decision.toolName}`);
      }

      if (definition.policy) {
        const contactQuery = definition.policy.getContactQuery(decision.args);
        if (contactQuery) {
          const policyDecision = createPolicyEngine(persistence).evaluateOutboundAction({
            actionType: definition.policy.actionType,
            contactQuery
          });

          if (policyDecision.decision === "block") {
            return {
              toolName: decision.toolName,
              status: "blocked",
              reply: `Tool execution blocked.\n${policyDecision.reason}`,
              policyDecision
            };
          }

          if (policyDecision.decision === "requires_confirmation") {
            return {
              toolName: decision.toolName,
              status: "requires_confirmation",
              reply: `Tool execution requires explicit approval.\n${policyDecision.reason}`,
              policyDecision
            };
          }

          if (policyDecision.decision === "needs_contact_classification") {
            return {
              toolName: decision.toolName,
              status: "clarify",
              reply: `Tool execution requires contact classification.\n${policyDecision.reason}`,
              policyDecision
            };
          }
        }
      }

      if (definition.executeDetailed) {
        return definition.executeDetailed({
          args: decision.args,
          persistence,
          conversationId: params.conversationId,
          groundedAnswerService: params.groundedAnswerService,
          worldLookupAdapters: params.worldLookupAdapters,
          articleReader: params.articleReader
        });
      }

      const reply = await definition.execute({
        calendarClient,
        args: decision.args,
        persistence,
        conversationId: params.conversationId,
        groundedAnswerService: params.groundedAnswerService,
        worldLookupAdapters: params.worldLookupAdapters,
        articleReader: params.articleReader
      });

      return {
        toolName: decision.toolName,
        status: "executed",
        reply
      };
    }
  );
}

function getRequiredStringArg(args: Record<string, string | number>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required tool argument: ${key}`);
  }
  return value.trim();
}

function getOptionalStringArg(args: Record<string, string | number>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getRequiredNumericLikeArg(args: Record<string, string | number>, key: string): number {
  const value = args[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Missing required numeric tool argument: ${key}`);
  }
  return parsed;
}

function isToolName(value: unknown): value is ExplicitToolName {
  return (
    value === "reminder.add" ||
    value === "reminder.show" ||
    value === "reminder.ack" ||
    value === "calendar.show" ||
    value === "calendar.remind" ||
    value === "news.briefing" ||
    value === "news.follow_up" ||
    value === "world.lookup"
  );
}

function buildNewsBriefingAuditDetail(result: WorldLookupResult, preferences: NewsPreferences): string {
  const chosenEvidence = result.evidence
    .map((record) => `${record.source}:${record.title}${record.rankingSignals?.length ? `[${record.rankingSignals.join(",")}]` : ""}`)
    .join(" | ");
  return `outcome=${result.outcome}; selectedSources=${result.selectedSources.join(",")}; candidateCount=${result.candidateCount}; evidenceCount=${result.evidence.length}; chosenEvidence=${chosenEvidence || "none"}; preferenceCounts=interested:${preferences.interestedTopics.length},uninterested:${preferences.uninterestedTopics.length},preferred:${preferences.preferredOutlets.length},blocked:${preferences.blockedOutlets.length}; failureCount=${result.failures.length}`;
}

function buildNewsBriefingFallbackReply(result: WorldLookupResult): string {
  if (result.evidence.length === 0) {
    return "I couldn't pull together a reliable news briefing from the public sources I checked just now.";
  }

  const lines = result.evidence.slice(0, 5).map((record, index) => {
    const sourceLabel = record.publisher ?? formatWorldLookupSource(record.source);
    return `${index + 1}. ${record.title} (${sourceLabel})`;
  });
  const links = result.evidence
    .filter((record): record is typeof record & { url: string } => typeof record.url === "string" && record.url.length > 0)
    .slice(0, 5)
    .map((record) => `- ${record.url}`)
    .join("\n");
  return `Here are the main headlines I found:\n${lines.join("\n")}${links ? `\n\nLinks:\n${links}` : ""}`;
}

function buildNewsFollowUpFallbackReply(item: NewsBrowseSessionItemRecord): string {
  const sourceLabel = item.publisher ?? formatWorldLookupSource(item.source);
  const linkBlock = item.url ? `\n\nLinks:\n- ${item.url}` : "";
  return `From ${sourceLabel}, ${item.snippet}${linkBlock}`;
}

function buildWorldLookupAuditDetail(
  result: WorldLookupResult,
  articleReadResult: { articles: WorldLookupArticleRecord[]; failures: string[] } = { articles: [], failures: [] },
  preferences: NewsPreferences = {
    interestedTopics: [],
    uninterestedTopics: [],
    preferredOutlets: [],
    blockedOutlets: []
  },
  options: {
    topicSessionSaved?: boolean;
  } = {}
): string {
  const citedSources = Array.from(new Set(result.evidence.map((record) => record.source))).join(",");
  const chosenEvidence = result.evidence
    .map((record) => `${record.source}:${record.title}${record.rankingSignals?.length ? `[${record.rankingSignals.join(",")}]` : ""}`)
    .join(" | ");
  const articleTitles = articleReadResult.articles.map((article) => article.title).join(" | ");
  return `bucket=${result.bucket}; outcome=${result.outcome}; selectedSources=${result.selectedSources.join(",")}; candidateCount=${result.candidateCount}; retrievalStrategy=${result.retrievalStrategy}; evidenceCount=${result.evidence.length}; chosenEvidence=${chosenEvidence || "none"}; citedSources=${citedSources || "none"}; articleReadCount=${articleReadResult.articles.length}; articleTitles=${articleTitles || "none"}; articleReadFailures=${articleReadResult.failures.length}; topicSessionSaved=${options.topicSessionSaved ? "yes" : "no"}; preferenceCounts=interested:${preferences.interestedTopics.length},uninterested:${preferences.uninterestedTopics.length},preferred:${preferences.preferredOutlets.length},blocked:${preferences.blockedOutlets.length}; failureCount=${result.failures.length}`;
}

function buildWorldLookupFallbackReply(result: WorldLookupResult): string {
  if (result.evidence.length === 0) {
    return "I couldn't verify that from the public sources I checked just now.";
  }

  const first = result.evidence[0];
  const sourceLabel = formatWorldLookupSource(first.source);
  const linkBlock = first.url ? `\n\nLinks:\n- ${first.url}` : "";
  return `According to ${sourceLabel}, ${first.snippet}${linkBlock}`;
}

function formatWorldLookupSource(source: WorldLookupSourceName): string {
  switch (source) {
    case "newsdata":
      return "NewsData.io";
    case "wikipedia":
      return "Wikipedia";
    case "wikimedia_current_events":
      return "Wikinews";
    case "gdelt":
      return "GDELT";
    case "open_meteo":
      return "Open-Meteo";
    case "world_bank":
      return "World Bank";
  }
}

function extractJsonObject(payload: string): string {
  const trimmed = payload.trim();
  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error("Tool inference returned non-JSON output");
}

function normalizeUserMessage(userMessage: string): string {
  return userMessage
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ");
}

function resolveNewsSessionItem(
  items: NewsBrowseSessionItemRecord[],
  query: string
): NewsBrowseSessionItemRecord | null {
  const normalized = normalizeUserMessage(query);
  const ordinal = parseOrdinalReference(normalized);
  if (ordinal != null) {
    return items.find((item) => item.ordinal === ordinal) ?? null;
  }

  return (
    items.find((item) => {
      const publisher = item.publisher ? normalizeUserMessage(item.publisher) : "";
      const title = normalizeUserMessage(item.title);
      return (publisher.length > 0 && normalized.includes(publisher)) || normalized.includes(title);
    }) ?? null
  );
}

function parseOrdinalReference(normalized: string): number | null {
  const mapping: Record<string, number> = {
    first: 1,
    "1st": 1,
    second: 2,
    "2nd": 2,
    third: 3,
    "3rd": 3,
    fourth: 4,
    "4th": 4,
    fifth: 5,
    "5th": 5
  };

  for (const [label, ordinal] of Object.entries(mapping)) {
    if (normalized.includes(label)) {
      return ordinal;
    }
  }

  return null;
}
