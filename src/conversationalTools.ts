import { SpanKind } from "@opentelemetry/api";

import type { LlmPowerStatus, LlmRoute } from "./chat/modelRouter.js";
import { handleReminderCommand } from "./reminders.js";
import { withSpan } from "./observability.js";
import type { Persistence } from "./persistence.js";
import type { ConversationTurnRecord, WorldLookupSourceName } from "./types.js";
import type { OutlookCalendarClient } from "./outlookCalendar.js";
import type { GroundedAnswerService } from "./toolInvocation.js";
import type { WorldLookupAdapter } from "./worldLookup.js";
import type { WorldLookupArticleReader } from "./worldLookupArticles.js";

export type ConversationalToolName = "reminder.show" | "calendar.show";
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
