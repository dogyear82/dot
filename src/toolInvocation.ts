import type { Persistence } from "./persistence.js";
import { SpanKind } from "@opentelemetry/api";
import { withSpan } from "./observability.js";
import { handleCalendarCommand, type OutlookCalendarClient } from "./outlookCalendar.js";
import type { ConversationalToolName } from "./conversationalTools.js";
import { createPolicyEngine, type PolicyDecision } from "./policyEngine.js";
import { handleReminderCommand } from "./reminders.js";
import type {
  NewsBrowseSessionItemRecord,
  PolicyActionType,
  WorldLookupArticleRecord,
  WorldLookupQueryBucket,
  WorldLookupResult,
  WorldLookupSourceFailure,
  WorldLookupSourceName
} from "./types.js";
import type { WorldLookupAdapter } from "./worldLookup.js";
import type { WorldLookupArticleReader } from "./worldLookupArticles.js";

export type ExplicitToolName =
  | "reminder.add"
  | "reminder.show"
  | "reminder.ack"
  | "calendar.show"
  | "calendar.remind";

export type ConversationalIntentDecision =
  | {
      decision: "respond";
      reason: string;
      response: string;
    }
  | {
      decision: "execute_tool";
      toolName: ConversationalToolName;
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
    "If the owner seems to want a tool but some parameters are missing, still return execute_tool with the tool name and any arguments you can confidently infer. The tool itself will ask for clarification if needed.",
    "For reminder.add and calendar.remind, do not invent missing scheduling details, indices, or reminder text. Leave missing fields out of args.",
    "When the owner gives a specific reminder date/time clearly enough, prefer args.dueAt as an ISO 8601 timestamp over a duration.",
    "Use args.dueAt only when you can confidently ground it from the owner's words and the provided current date/time reference.",
    "Interpret relative reminder phrases like `today`, `tomorrow`, and day-of-month references in the timezone named by the current date/time reference, not as raw UTC calendar dates.",
    "Supported tools and args:",
    "- reminder.add: message, optional duration, optional dueAt",
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
    '{"decision":"execute_tool","toolName":"reminder.add","reason":"...","confidence":"high","args":{"message":"return the lens protector","dueAt":"2026-04-16T01:00:00.000Z"}}',
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

export function buildPendingToolResolutionPrompt(params: {
  userMessage: string;
  toolName: ConversationalToolName;
  existingArgs: Record<string, string | number>;
  originalUserMessage: string;
  pendingStatus: "clarify" | "requires_confirmation";
  pendingPrompt: string;
}): string {
  return [
    "You are resuming a pending Dot tool call after the tool previously asked the owner for missing information or confirmation.",
    "Return only strict JSON with one of two decisions: respond or execute_tool.",
    "If the owner is continuing the pending tool flow, return execute_tool for the SAME tool with merged or newly supplied args.",
    "Do not switch to a different tool unless the owner clearly abandons the pending flow and asks for something else entirely.",
    "If the owner is cancelling, abandoning, or changing the subject, return respond with a short final reply in Dot's normal voice.",
    "If the owner supplies only one missing field, return only that field in args. Existing args will be merged outside the model.",
    "If the pending step is requires_confirmation and the owner confirms, return execute_tool for the same tool with args containing only {\"confirmed\":\"yes\"}.",
    "If the pending step is requires_confirmation and the owner declines or cancels, return respond with a short acknowledgment instead of executing the tool.",
    "Do not invent missing reminder time, message, or any other tool arguments during pending resolution.",
    "Do not invent unsupported tools or side effects.",
    `Pending tool: ${params.toolName}`,
    `Pending status: ${params.pendingStatus}`,
    `Original user request: ${JSON.stringify(params.originalUserMessage)}`,
    `Pending prompt: ${JSON.stringify(params.pendingPrompt)}`,
    `Existing args already captured: ${JSON.stringify(params.existingArgs)}`,
    `Latest owner reply: ${JSON.stringify(params.userMessage)}`,
    "Return strict JSON only in one of these shapes:",
    '{"decision":"respond","reason":"...","response":"..."}',
    `{"decision":"execute_tool","toolName":"${params.toolName}","reason":"owner supplied missing information","confidence":"high","args":{"message":"stretch"}}`,
    `{"decision":"execute_tool","toolName":"${params.toolName}","reason":"owner confirmed the pending reminder details","confidence":"high","args":{"confirmed":"yes"}}`
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

function isToolName(value: unknown): value is ConversationalToolName {
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
