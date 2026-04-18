import { recordToolExecution } from "../observability.js";
import type { OutlookCalendarClient } from "../outlookCalendar.js";
import type { Persistence } from "../persistence.js";
import { executeToolDecision, parseExplicitToolDecision, type GroundedAnswerService } from "../toolInvocation.js";
import type { WorldLookupSourceName } from "../types.js";
import type { WorldLookupAdapter } from "../worldLookup.js";
import type { Command } from "./types.js";

export function createExplicitToolCommand(params: {
    calendarClient: OutlookCalendarClient;
    conversationId: string;
    event: import("../events.js").InboundMessageReceivedEvent;
    groundedAnswerService?: GroundedAnswerService;
    persistence: Persistence;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
}): Command {
    return {
        name: "explicit.tool",
        description: "Handle explicit tool commands.",
        ownerOnly: true,
        matches(input) {
            return parseExplicitToolDecision(input) !== null;
        },
        async execute(input) {
            const decision = parseExplicitToolDecision(input);
            if (!decision || decision.decision !== "execute") {
                return "Invalid explicit tool command.";
            }

            const result = await executeToolDecision({
                calendarClient: params.calendarClient,
                conversationId: params.conversationId,
                decision,
                groundedAnswerService: params.groundedAnswerService,
                persistence: params.persistence,
                worldLookupAdapters: params.worldLookupAdapters
            });
            params.persistence.saveToolExecutionAudit({
                messageId: params.event.payload.messageId,
                toolName: result.toolName,
                invocationSource: "explicit",
                status: result.status,
                provider: result.route ?? null,
                detail: result.detail ?? decision.reason
            });
            recordToolExecution({ toolName: result.toolName, status: result.status });
            return result.reply;
        }
    };
}
