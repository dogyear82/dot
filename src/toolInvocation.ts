import type { Persistence } from "./persistence.js";
import { handleCalendarCommand, type OutlookCalendarClient } from "./outlookCalendar.js";
import { handleReminderCommand } from "./reminders.js";

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
}): Promise<string> {
  const { calendarClient, decision, persistence } = params;

  switch (decision.toolName) {
    case "reminder.add": {
      const duration = getRequiredStringArg(decision.args, "duration");
      const message = getRequiredStringArg(decision.args, "message");
      return handleReminderCommand(persistence, `reminder add ${duration} ${message}`);
    }
    case "reminder.show":
      return handleReminderCommand(persistence, "reminder show");
    case "reminder.ack": {
      const id = getRequiredNumericLikeArg(decision.args, "id");
      return handleReminderCommand(persistence, `reminder ack ${id}`);
    }
    case "calendar.show":
      return handleCalendarCommand({
        calendarClient,
        content: "calendar show",
        persistence
      });
    case "calendar.remind": {
      const index = getRequiredNumericLikeArg(decision.args, "index");
      const leadTime = getOptionalStringArg(decision.args, "leadTime");
      const content = leadTime ? `calendar remind ${index} ${leadTime}` : `calendar remind ${index}`;
      return handleCalendarCommand({
        calendarClient,
        content,
        persistence
      });
    }
  }
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
