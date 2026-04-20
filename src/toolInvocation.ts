import type { Persistence } from "./persistence.js";
import { SpanKind } from "@opentelemetry/api";
import { withSpan } from "./observability.js";
import type { OutlookCalendarClient } from "./outlookCalendar.js";
import type { ToolName } from "./toolExecutor.js";
import { executeTool } from "./toolExecutor.js";
import type {
    WorldLookupSourceName
} from "./types.js";
import type { WorldLookupAdapter } from "./worldLookup.js";
import type { WorldLookupArticleReader } from "./worldLookupArticles.js";

export type ExplicitToolName =
    | "news.briefing";

export type MessageRoute =
    | {
        name: "respond";
        reason: string;
        instructions: string;
    }
    | {
        name: "execute_tool";
        toolName: ToolName;
        reason: string;
        args: Record<string, string | number>;
    };

export type AddressedToolIntentDecision =
    | {
        addressed: false;
        reason: string;
    }
    | ({
        addressed: true;
    } & MessageRoute);

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
    status: "executed" | "failed";
    reply: string;
    detail?: string;
    route?: ToolExecutionRoute;
}

export type ToolExecutionRoute = "none" | "deterministic" | "local" | "hosted";

export interface GroundedAnswerService {}

export function parseExplicitToolDecision(content: string): ToolDecision | null {
    const parts = content.trim().split(/\s+/);

    if (parts[0] !== "!news.briefing") {
        return null;
    }

    return {
        decision: "execute",
        toolName: "news.briefing",
        reason: "owner used the explicit news briefing command",
        args: {
            query: parts.slice(1).join(" ")
        }
    };
}

export function buildAddressedToolInferencePrompt(
    isSureDotIsAddressed: boolean
): string {
    const toolsPrompt = [
        "Available tools and args:",
        "- news.briefing: query"
    ];

    const addressednessCheckPrompt = isSureDotIsAddressed
        ? ["You have been addressed directly by the user, so always set 'addressed' to true in your reply"]
        : ["If the latest message is not addressed to you, reply with:",
        '{"addressed":false,"reason":"..."}']

    return [
        ...toolsPrompt,
        "Your name is Dot, and you are a neutral intent classifier for messages in a chat channel where you are present. Using the provided transcript of your current conversation with the other participants, you will use the entirety of the transcript to determine whether the latest message in the transcript to choose the appropriate repy.",
        ...addressednessCheckPrompt,
        "If the latest message is requesting a tool or needs a tool to formulate a reponse, reply with:",
        '{"addressed":true,"decision":"execute_tool","toolName":"news.briefing","reason":"...","confidence":"medium","args":{"query":"..."}}',
        "for example, if the user asks, 'What's the latest on Ukraine?', an appropriate reply would be:",
        '{"addressed":true,"decision":"execute_tool","toolName":"news.briefing","reason":"the user is asking for news on Ukraine","confidence":"high","args":{"query":"Ukraine today"}}',
    ].join("\n");
}

export function buildPendingToolResolutionPrompt(params: {
    userMessage: string;
    toolName: ToolName;
    existingArgs: Record<string, string | number>;
    originalUserMessage: string;
    pendingStatus: "clarify" | "requires_confirmation";
    pendingPrompt: string;
    includeLatestMessage?: boolean;
    latestMessageLabel?: string;
}): string {
    const includeLatestMessage = params.includeLatestMessage ?? true;
    const latestMessageLabel = params.latestMessageLabel ?? "Latest owner reply";
    return [
        "You are resuming a pending tool flow after the tool previously asked for missing information or confirmation.",
        "Return only strict JSON with one of two decisions: respond or execute_tool.",
        "If the owner is continuing the pending tool flow, return execute_tool for the same tool with only the newly supplied or corrected args.",
        "Do not switch to a different tool unless the owner clearly abandons the pending flow and asks for something else entirely.",
        "If the owner is cancelling, abandoning, or changing the subject, return respond with a short final reply in your normal voice as Dot.",
        "Respond is a non-operational conversation path only. If you choose respond, do not claim or imply that you already performed a real side-effecting action.",
        "Any reply that says you sent, set, scheduled, created, updated, granted, deleted, changed, or otherwise completed a real action must come from execute_tool, not respond.",
        "Use only the exact tool name already provided and only the exact arg keys that tool supports, except that the reserved meta-arg `confirmed` may be returned during pending confirmation. Do not invent extra arg keys.",
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
        ...(includeLatestMessage ? [`${latestMessageLabel}: ${JSON.stringify(params.userMessage)}`] : []),
        "Return strict JSON only in one of these shapes:",
        '{"decision":"respond","reason":"...","response":"..."}',
        `{"decision":"execute_tool","toolName":"${params.toolName}","reason":"owner supplied missing information","confidence":"high","args":{"message":"stretch"}}`,
        `{"decision":"execute_tool","toolName":"${params.toolName}","reason":"owner confirmed the pending tool details","confidence":"high","args":{"confirmed":"yes"}}`,
        '{"decision":"respond","reason":"owner cancelled the pending tool flow","response":"Alright, sweetie. I won\'t do it."}'
    ].join("\n");
}

export function parseToolDecision(payload: string): MessageRoute {
    const parsed = JSON.parse(extractJsonObject(payload)) as Partial<MessageRoute> & {
        confidence?: unknown;
    };
    if (
        parsed.name === "respond" &&
        typeof parsed.reason === "string" &&
        typeof parsed.response === "string" &&
        parsed.response.trim().length > 0
    ) {
        return {
            name: "respond",
            reason: parsed.reason,
            response: parsed.response.trim()
        };
    }

    if (
        parsed.name === "execute_tool" &&
        isToolName(parsed.toolName) &&
        typeof parsed.reason === "string" &&
        (parsed.confidence === "medium" || parsed.confidence === "high") &&
        parsed.args &&
        typeof parsed.args === "object"
    ) {
        return {
            name: "execute_tool",
            toolName: parsed.toolName,
            reason: parsed.reason,
            confidence: parsed.confidence,
            args: parsed.args as Record<string, string | number>
        };
    }

    throw new Error("Conversational intent inference returned an invalid response");
}

export function parseAddressedToolDecision(payload: string): AddressedToolIntentDecision {
    const parsed = JSON.parse(extractJsonObject(payload)) as Partial<AddressedToolIntentDecision> &
        Partial<MessageRoute> & {
            confidence?: unknown;
        };
    if (parsed.addressed === false && typeof parsed.reason === "string") {
        return {
            addressed: false,
            reason: parsed.reason
        };
    }

    if (
        parsed.addressed === true &&
        parsed.name === "respond" &&
        typeof parsed.reason === "string" &&
        typeof parsed.response === "string" &&
        parsed.response.trim().length > 0
    ) {
        return {
            addressed: true,
            name: "respond",
            reason: parsed.reason,
            response: parsed.response.trim()
        };
    }

    if (
        parsed.addressed === true &&
        parsed.name === "execute_tool" &&
        isToolName(parsed.toolName) &&
        typeof parsed.reason === "string" &&
        (parsed.confidence === "medium" || parsed.confidence === "high") &&
        parsed.args &&
        typeof parsed.args === "object"
    ) {
        return {
            addressed: true,
            name: "execute_tool",
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
            const decision = params.decision;
            const result = await executeTool(
                decision.toolName,
                Object.entries(decision.args).map(([key, value]) => `${key}=${String(value)}`),
                {
                    calendarClient: params.calendarClient,
                    persistence: params.persistence,
                    conversationId: params.conversationId,
                    worldLookupAdapters: params.worldLookupAdapters,
                    articleReader: params.articleReader
                }
            );

            if (result.success) {
                return {
                    toolName: decision.toolName,
                    status: "executed",
                    reply: result.result
                };
            }

            return {
                toolName: decision.toolName,
                status: "failed",
                reply: result.reason
            };
        }
    );
}

function isToolName(value: unknown): value is ToolName {
    return value === "news.briefing";
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
