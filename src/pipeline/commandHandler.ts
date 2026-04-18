import { recordToolExecution } from "../observability.js";
import type { Persistence } from "../persistence.js";
import { handleContactCommand, handlePolicyCommand } from "../contacts.js";
import { handleEmailCommand } from "../emailWorkflow.js";
import type { EventBus } from "../eventBus.js";
import { handleNewsPreferencesCommand } from "../newsPreferences.js";
import { handleSettingsCommand } from "../onboarding.js";
import { handleCalendarCommand, type OutlookCalendarClient } from "../outlookCalendar.js";
import type { MicrosoftOutlookOAuthClient } from "../outlookOAuth.js";
import { handlePersonalityCommand } from "../personality.js";
import { executeToolDecision, parseExplicitToolDecision } from "../toolInvocation.js";
import type { WorldLookupSourceName } from "../types.js";
import type { WorldLookupAdapter } from "../worldLookup.js";
import type { GroundedAnswerService } from "../toolInvocation.js";

export type CommandHandlerOutcome =
    | { handled: false }
    | {
        handled: true;
        pipelineOutcome: string;
        reply: string;
        route: import("../chat/modelRouter.js").LlmRoute;
        recordConversationTurn?: boolean;
    };

export async function handleOwnerCommand(params: {
    bus: EventBus;
    calendarClient: OutlookCalendarClient;
    content: string;
    conversationId: string;
    event: import("../events.js").InboundMessageReceivedEvent;
    groundedAnswerService?: GroundedAnswerService;
    outlookOAuthClient: MicrosoftOutlookOAuthClient;
    persistence: Persistence;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
}): Promise<CommandHandlerOutcome> {
    const content = params.content;

    if (content.startsWith("!settings")) {
        return {
            handled: true,
            pipelineOutcome: "settings_command",
            reply: handleSettingsCommand(params.persistence.settings, content),
            route: "none"
        };
    }

    if (content.startsWith("!news prefs")) {
        return {
            handled: true,
            pipelineOutcome: "news_preferences_command",
            reply: handleNewsPreferencesCommand(params.persistence, content),
            route: "none"
        };
    }

    if (content.startsWith("!personality")) {
        return {
            handled: true,
            pipelineOutcome: "personality_command",
            reply: handlePersonalityCommand(params.persistence, content),
            route: "none"
        };
    }

    if (content.startsWith("!contact")) {
        return {
            handled: true,
            pipelineOutcome: "contact_command",
            reply: handleContactCommand({
                content,
                conversationId: params.conversationId,
                persistence: params.persistence
            }),
            route: "none"
        };
    }

    if (content.startsWith("!policy")) {
        return {
            handled: true,
            pipelineOutcome: "policy_command",
            reply: handlePolicyCommand({
                content,
                conversationId: params.conversationId,
                persistence: params.persistence
            }),
            route: "none"
        };
    }

    if (content.startsWith("!email")) {
        return {
            handled: true,
            pipelineOutcome: "email_command",
            reply: await handleEmailCommand({
                actorId: params.event.payload.sender.actorId,
                bus: params.bus,
                content,
                conversationId: params.conversationId,
                persistence: params.persistence
            }),
            route: "none"
        };
    }

    const explicitToolDecision = parseExplicitToolDecision(content);
    if (explicitToolDecision?.decision === "execute") {
        const result = await executeToolDecision({
            calendarClient: params.calendarClient,
            conversationId: params.conversationId,
            decision: explicitToolDecision,
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
            detail: result.detail ?? explicitToolDecision.reason
        });
        recordToolExecution({ toolName: result.toolName, status: result.status });
        return {
            handled: true,
            pipelineOutcome: result.status === "executed" ? "tool_execute" : "tool_failed",
            reply: result.reply,
            route: result.route ?? "none"
        };
    }

    if (content.startsWith("!calendar")) {
        return {
            handled: true,
            pipelineOutcome: "calendar_command",
            reply: await handleCalendarCommand({
                calendarClient: params.calendarClient,
                content,
                oauthClient: params.outlookOAuthClient,
                persistence: params.persistence
            }),
            route: "none"
        };
    }

    return { handled: false };
}

export function isOwnerOnlyCommand(content: string): boolean {
    return (
        content.startsWith("!settings") ||
        content.startsWith("!personality") ||
        content.startsWith("!contact") ||
        content.startsWith("!policy") ||
        content.startsWith("!reminder") ||
        content.startsWith("!remind") ||
        content.startsWith("!calendar")
    );
}
