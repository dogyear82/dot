import { SpanKind } from "@opentelemetry/api";

import type { LlmPowerStatus, LlmRoute } from "./chat/modelRouter.js";
import { handleReminderCommand } from "./reminders.js";
import { withSpan } from "./observability.js";
import type { Persistence } from "./persistence.js";
import type {
  ConversationTurnRecord,
  NewsBrowseSessionItemRecord,
  NewsPreferences,
  WorldLookupArticleRecord,
  WorldLookupResult,
  WorldLookupSourceFailure,
  WorldLookupSourceName
} from "./types.js";
import type { OutlookCalendarClient } from "./outlookCalendar.js";
import type { GroundedAnswerService } from "./toolInvocation.js";
import type { WorldLookupAdapter } from "./worldLookup.js";
import type { WorldLookupArticleReader } from "./worldLookupArticles.js";
import { executeWorldLookup } from "./worldLookup.js";
import { HtmlWorldLookupArticleReader } from "./worldLookupArticles.js";
import { createDefaultWorldLookupAdapters } from "./worldLookupAdapters.js";
import { getNewsPreferences } from "./newsPreferences.js";

export type ConversationalToolName =
  | "reminder.show"
  | "calendar.show"
  | "news.briefing"
  | "news.follow_up"
  | "world.lookup";
export type ConversationalToolStatus = "success" | "clarify" | "blocked" | "requires_confirmation" | "failed";
export type ConversationalToolPresentationMode = "final_text" | "llm_render";

export interface ToolRenderInstructions {
  systemPrompt: string;
  constraints?: string[];
  styleHints?: string[];
}

export interface ConversationalToolCall {
  toolName: ConversationalToolName;
  args: Record<string, string | number>;
  userMessage: string;
  conversationId?: string;
}

export interface ConversationalToolContext {
  calendarClient: OutlookCalendarClient;
  persistence: Persistence;
  groundedAnswerService?: GroundedAnswerService;
  worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
  articleReader?: WorldLookupArticleReader;
}

export interface ConversationalToolResult {
  toolName: ConversationalToolName;
  status: ConversationalToolStatus;
  presentation: ConversationalToolPresentationMode;
  payload: Record<string, unknown>;
  renderInstructions?: ToolRenderInstructions;
  detail?: string;
}

export interface ToolRenderService {
  renderToolResult(params: {
    userMessage: string;
    payload: Record<string, unknown>;
    renderInstructions: ToolRenderInstructions;
    recentConversation?: ConversationTurnRecord[];
  }): Promise<{ route: LlmRoute; powerStatus: LlmPowerStatus; reply: string }>;
}

export interface RenderedConversationalToolResult {
  toolName: ConversationalToolName;
  status: ConversationalToolStatus;
  reply: string;
  detail?: string;
  route?: LlmRoute;
}

export interface ConversationalTool {
  toolName: ConversationalToolName;
  execute(call: ConversationalToolCall, context: ConversationalToolContext): Promise<ConversationalToolResult>;
}

const DEFAULT_CONVERSATIONAL_TOOLS: Record<ConversationalToolName, ConversationalTool> = {
  "reminder.show": {
    toolName: "reminder.show",
    async execute(_call, context) {
      return {
        toolName: "reminder.show",
        status: "success",
        presentation: "final_text",
        payload: {
          text: handleReminderCommand(context.persistence, "!reminder show")
        },
        detail: "presentation=final_text"
      };
    }
  },
  "calendar.show": {
    toolName: "calendar.show",
    async execute(call, context) {
      const events = await context.calendarClient.listUpcomingEvents();
      return {
        toolName: "calendar.show",
        status: "success",
        presentation: "llm_render",
        payload: {
          events: events.map((event, index) => ({
            index: index + 1,
            subject: event.subject,
            startAt: event.startAt,
            endAt: event.endAt,
            webLink: event.webLink ?? null
          }))
        },
        renderInstructions: {
          systemPrompt:
            "Render the provided calendar events into a concise user-facing response in Dot's normal voice.",
          constraints: [
            "Use only the supplied calendar payload.",
            "If there are no events, say so plainly.",
            "Do not invent event details or extra scheduling advice.",
            "Keep the answer tight and focused on upcoming events."
          ],
          styleHints: ["Name the next few events clearly.", "Preserve event ordering from the payload."]
        },
        detail: `presentation=llm_render; eventCount=${events.length}; originalMessage=${call.userMessage}`
      };
    }
  },
  "news.briefing": {
    toolName: "news.briefing",
    async execute(call, context) {
      const query = getRequiredStringArg(call.args, "query");
      const newsPreferences = getNewsPreferences(context.persistence.settings);
      const lookupResult = await executeWorldLookup({
        query,
        adapters: context.worldLookupAdapters ?? createDefaultWorldLookupAdapters(),
        preferences: newsPreferences,
        maxEvidenceCount: 8
      });

      const detail = buildNewsBriefingAuditDetail(lookupResult, newsPreferences);
      if (call.conversationId) {
        context.persistence.saveNewsBrowseSession({
          kind: "briefing",
          conversationId: call.conversationId,
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

      if (lookupResult.evidence.length === 0) {
        return {
          toolName: "news.briefing",
          status: "success",
          presentation: "final_text",
          payload: {
            text: buildNewsBriefingFallbackReply(lookupResult)
          },
          detail
        };
      }

      return {
        toolName: "news.briefing",
        status: "success",
        presentation: "llm_render",
        payload: {
          mode: "news_briefing",
          query,
          outcome: lookupResult.outcome,
          selectedSources: lookupResult.selectedSources,
          failures: lookupResult.failures,
          evidence: lookupResult.evidence
        },
        renderInstructions: {
          systemPrompt:
            "Render the supplied news briefing payload into Dot's natural voice. This is a headline briefing, not a raw result dump.",
          constraints: [
            "Use only the supplied payload.",
            "Identify the standout stories instead of echoing the first few links.",
            "Blend major world news with likely-interest stories when the evidence supports it.",
            "Answer as a concise briefing, not as an authority who already knew this information.",
            "Name sources naturally in prose when summarizing stories.",
            "Do not quote long passages or regurgitate article snippets.",
            "Append a Links section at the bottom using the most relevant 3 to 5 story URLs."
          ],
          styleHints: [
            "Lead with what matters most.",
            "Brief each chosen story in one or two sentences.",
            "If the evidence is thin, say so plainly instead of pretending confidence."
          ]
        },
        detail
      };
    }
  },
  "news.follow_up": {
    toolName: "news.follow_up",
    async execute(call, context) {
      const query = getRequiredStringArg(call.args, "query");
      const session = call.conversationId ? context.persistence.getLatestNewsBrowseSession(call.conversationId) : null;
      if (!session) {
        return {
          toolName: "news.follow_up",
          status: "clarify",
          presentation: "final_text",
          payload: {
            text: "I don't have a recent news list in this conversation to follow up on yet."
          },
          detail: "newsSession=missing"
        };
      }

      const selectedItem = resolveNewsSessionItem(session.items, query);
      if (!selectedItem) {
        return {
          toolName: "news.follow_up",
          status: "clarify",
          presentation: "final_text",
          payload: {
            text: "I couldn't tell which story you meant from the last news list. Give me the number or the outlet name."
          },
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
      const articleReadResult = selectedItem.url
        ? await (context.articleReader ?? new HtmlWorldLookupArticleReader()).read({ evidence })
        : { articles: [], failures: [] };

      if (!selectedItem.url && articleReadResult.articles.length === 0) {
        return {
          toolName: "news.follow_up",
          status: "success",
          presentation: "final_text",
          payload: {
            text: buildNewsFollowUpFallbackReply(selectedItem)
          },
          detail: `newsSession=resolved; ordinal=${selectedItem.ordinal}; title=${selectedItem.title}; source=${selectedItem.source}`
        };
      }

      return {
        toolName: "news.follow_up",
        status: "success",
        presentation: "llm_render",
        payload: {
          mode: "news_follow_up",
          query,
          selectedItem,
          evidence,
          articles: articleReadResult.articles
        },
        renderInstructions: {
          systemPrompt:
            "Render the supplied follow-up news payload into Dot's natural voice. The owner is asking for more detail about a previously selected story.",
          constraints: [
            "Use only the supplied payload.",
            "Answer the follow-up first instead of restating the whole briefing.",
            "Make it clear Dot looked this up by attributing the story naturally in prose.",
            "Prefer article content when present; otherwise fall back to the saved evidence snippet.",
            "Do not invent details beyond the payload.",
            "Append a Links section at the bottom when a source URL is available."
          ],
          styleHints: [
            "Keep the answer focused on the selected story.",
            "If article content is sparse, acknowledge that plainly."
          ]
        },
        detail: `newsSession=resolved; ordinal=${selectedItem.ordinal}; title=${selectedItem.title}; source=${selectedItem.source}; articleReadCount=${articleReadResult.articles.length}`
      };
    }
  },
  "world.lookup": {
    toolName: "world.lookup",
    async execute(call, context) {
      const query = getRequiredStringArg(call.args, "query");
      const newsPreferences = getNewsPreferences(context.persistence.settings);
      const lookupResult = await executeWorldLookup({
        query,
        adapters: context.worldLookupAdapters ?? createDefaultWorldLookupAdapters(),
        preferences: newsPreferences
      });
      const articleReadResult =
        lookupResult.bucket === "current_events" && lookupResult.evidence.length > 0
          ? await (context.articleReader ?? new HtmlWorldLookupArticleReader()).read({
              evidence: lookupResult.evidence
            })
          : { articles: [], failures: [] };

      const topicSessionSaved =
        Boolean(call.conversationId) &&
        lookupResult.bucket === "current_events" &&
        lookupResult.retrievalStrategy === "current_events_topic_ranked" &&
        lookupResult.evidence.length > 0;

      if (topicSessionSaved && call.conversationId) {
        context.persistence.saveNewsBrowseSession({
          kind: "topic_lookup",
          conversationId: call.conversationId,
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

      if (lookupResult.evidence.length === 0) {
        return {
          toolName: "world.lookup",
          status: "success",
          presentation: "final_text",
          payload: {
            text: buildWorldLookupFallbackReply(lookupResult)
          },
          detail
        };
      }

      return {
        toolName: "world.lookup",
        status: "success",
        presentation: "llm_render",
        payload: {
          mode: "world_lookup",
          query,
          bucket: lookupResult.bucket,
          outcome: lookupResult.outcome,
          selectedSources: lookupResult.selectedSources,
          failures: lookupResult.failures,
          evidence: lookupResult.evidence,
          articles: articleReadResult.articles
        },
        renderInstructions: {
          systemPrompt:
            "Render the supplied grounded lookup payload into Dot's natural voice. Use the tool evidence to answer the user's question directly.",
          constraints: [
            "Use only the supplied payload.",
            "Answer the specific question asked and no more.",
            "Make it clear Dot looked this up by attributing sources naturally in prose.",
            "For current events, use 2 or 3 articles only when they materially improve confidence.",
            "Do not present the answer as if Dot is the original authority.",
            "Do not quote long passages or dump snippets verbatim.",
            "Append a Links section at the bottom with the most relevant 1 to 3 URLs."
          ],
          styleHints: [
            "Prefer article content over snippets when articles are present.",
            "If evidence conflicts or is thin, acknowledge uncertainty plainly."
          ]
        },
        detail
      };
    }
  }
};

export async function executeConversationalToolCall(params: {
  call: ConversationalToolCall;
  context: ConversationalToolContext;
  registry?: Partial<Record<ConversationalToolName, ConversationalTool>>;
}): Promise<ConversationalToolResult> {
  return withSpan(
    "conversational_tool.execute",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "dot.tool.name": params.call.toolName
      }
    },
    async () => {
      const definition = params.registry?.[params.call.toolName] ?? DEFAULT_CONVERSATIONAL_TOOLS[params.call.toolName];
      if (!definition) {
        throw new Error(`Unsupported conversational tool: ${params.call.toolName}`);
      }

      return definition.execute(params.call, params.context);
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

function normalizeUserMessage(userMessage: string): string {
  return userMessage
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ");
}

function resolveNewsSessionItem(items: NewsBrowseSessionItemRecord[], query: string): NewsBrowseSessionItemRecord | null {
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

export async function renderConversationalToolResult(params: {
  result: ConversationalToolResult;
  userMessage: string;
  renderService: ToolRenderService;
  recentConversation?: ConversationTurnRecord[];
}): Promise<RenderedConversationalToolResult> {
  switch (params.result.presentation) {
    case "final_text": {
      const text = params.result.payload.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error(`Tool ${params.result.toolName} returned final_text without a text payload`);
      }

      return {
        toolName: params.result.toolName,
        status: params.result.status,
        reply: text,
        detail: params.result.detail
      };
    }
    case "llm_render": {
      if (!params.result.renderInstructions) {
        throw new Error(`Tool ${params.result.toolName} returned llm_render without render instructions`);
      }

      const rendered = await params.renderService.renderToolResult({
        userMessage: params.userMessage,
        payload: params.result.payload,
        renderInstructions: params.result.renderInstructions,
        recentConversation: params.recentConversation
      });

      return {
        toolName: params.result.toolName,
        status: params.result.status,
        reply: rendered.reply,
        detail: params.result.detail,
        route: rendered.route
      };
    }
  }
}
