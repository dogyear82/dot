import type { Persistence } from "./persistence.js";
import { SpanKind } from "@opentelemetry/api";
import { withSpan } from "./observability.js";
import { handleCalendarCommand, type OutlookCalendarClient } from "./outlookCalendar.js";
import { createPolicyEngine, type PolicyDecision } from "./policyEngine.js";
import { handleReminderCommand } from "./reminders.js";
import type { PolicyActionType } from "./types.js";

export type ExplicitToolName =
  | "reminder.add"
  | "reminder.show"
  | "reminder.ack"
  | "calendar.show"
  | "calendar.remind";

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
  policyDecision?: PolicyDecision;
}

interface ToolDefinition {
  toolName: ExplicitToolName;
  execute(params: {
    calendarClient: OutlookCalendarClient;
    args: Record<string, string | number>;
    persistence: Persistence;
  }): Promise<string> | string;
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
  }
};

export function inferDeterministicToolDecision(userMessage: string): ToolDecision | null {
  const normalized = normalizeUserMessage(userMessage);

  if (looksLikeCalendarShowIntent(normalized)) {
    return {
      decision: "execute",
      toolName: "calendar.show",
      reason: "clear calendar-view intent from deterministic phrase matching",
      args: {}
    };
  }

  return null;
}

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
    "You decide whether an owner message should invoke one of Dot's existing tools.",
    "Only choose a tool when the owner is reasonably clearly asking for it.",
    "If you are unsure, return decision none.",
    "If the owner clearly wants a tool but required parameters are missing, return decision clarify with a concise question.",
    "Supported tools and args:",
    "- reminder.add: duration, message",
    "- reminder.show: no args",
    "- reminder.ack: id",
    "- calendar.show: no args",
    "- calendar.remind: index, optional leadTime",
    "Never invent unsupported tools or free-form side effects.",
    "Return strict JSON only in one of these shapes:",
    '{"decision":"none","reason":"..."}',
    '{"decision":"clarify","toolName":"reminder.add","reason":"...","question":"When should I remind you?"}',
    '{"decision":"execute","toolName":"reminder.add","reason":"...","args":{"duration":"10m","message":"stretch"}}',
    '{"decision":"execute","toolName":"calendar.show","reason":"owner is asking to see upcoming calendar items","args":{}}',
    'Examples that should usually map to calendar.show:',
    '- "what\'s my calendar looking like this week?"',
    '- "do i have any meetings or appointments today?"',
    '- "what is on my schedule tomorrow?"',
    `Owner message: ${JSON.stringify(userMessage)}`
  ].join("\n");
}

export function parseToolDecision(payload: string): ToolDecision {
  const parsed = JSON.parse(extractJsonObject(payload)) as Partial<ToolDecision>;
  if (parsed.decision === "none" && typeof parsed.reason === "string") {
    return { decision: "none", reason: parsed.reason };
  }

  if (
    parsed.decision === "clarify" &&
    isToolName(parsed.toolName) &&
    typeof parsed.reason === "string" &&
    typeof parsed.question === "string"
  ) {
    return {
      decision: "clarify",
      toolName: parsed.toolName,
      reason: parsed.reason,
      question: parsed.question
    };
  }

  if (
    parsed.decision === "execute" &&
    isToolName(parsed.toolName) &&
    typeof parsed.reason === "string" &&
    parsed.args &&
    typeof parsed.args === "object"
  ) {
    return {
      decision: "execute",
      toolName: parsed.toolName,
      reason: parsed.reason,
      args: parsed.args as Record<string, string | number>
    };
  }

  throw new Error("Tool inference returned an invalid response");
}

export async function executeToolDecision(params: {
  calendarClient: OutlookCalendarClient;
  decision: Extract<ToolDecision, { decision: "execute" }>;
  persistence: Persistence;
  registry?: Partial<Record<ExplicitToolName, ToolDefinition>>;
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

      const reply = await definition.execute({
        calendarClient,
        args: decision.args,
        persistence
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
    value === "calendar.remind"
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

function looksLikeCalendarShowIntent(normalized: string): boolean {
  if (
    /(?:what(?:'s| is) my calendar(?: looking like)?|show my calendar|check my calendar)/.test(normalized) ||
    /(?:what(?:'s| is) on my schedule|show my schedule|check my schedule)/.test(normalized)
  ) {
    return true;
  }

  if (
    /do i have/.test(normalized) &&
    /\b(meeting|meetings|appointment|appointments|event|events)\b/.test(normalized)
  ) {
    return true;
  }

  if (
    /\b(calendar|schedule)\b/.test(normalized) &&
    /\b(today|tomorrow|tonight|this week|this afternoon|this morning|upcoming|coming up)\b/.test(normalized)
  ) {
    return true;
  }

  return false;
}

function normalizeUserMessage(userMessage: string): string {
  return userMessage.trim().toLowerCase().replace(/\s+/g, " ");
}
