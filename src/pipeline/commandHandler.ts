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
import type { ReplyPublisher } from "./types.js";

export type CommandHandlerOutcome =
    | { handled: false }
    | { handled: true; pipelineOutcome: string };

export async function handleOwnerCommand(params: {
    bus: EventBus;
    calendarClient: OutlookCalendarClient;
    content: string;
    conversationId: string;
    event: import("../events.js").InboundMessageReceivedEvent;
    groundedAnswerService?: GroundedAnswerService;
    outlookOAuthClient: MicrosoftOutlookOAuthClient;
    persistence: Persistence;
    publisher: ReplyPublisher;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
}): Promise<CommandHandlerOutcome> {
    const content = params.content;

    if (content.startsWith("!settings")) {
        await params.publisher.publishReply(handleSettingsCommand(params.persistence.settings, content));
        return { handled: true, pipelineOutcome: "settings_command" };
    }

    if (content.startsWith("!news prefs")) {
        await params.publisher.publishReply(handleNewsPreferencesCommand(params.persistence, content));
        return { handled: true, pipelineOutcome: "news_preferences_command" };
    }

    if (content.startsWith("!personality")) {
        await params.publisher.publishReply(handlePersonalityCommand(params.persistence, content));
        return { handled: true, pipelineOutcome: "personality_command" };
    }

    if (content.startsWith("!contact")) {
        await params.publisher.publishReply(
            handleContactCommand({
                content,
                conversationId: params.conversationId,
                persistence: params.persistence
            }),
            "none"
        );
        return { handled: true, pipelineOutcome: "contact_command" };
    }

    if (content.startsWith("!policy")) {
        await params.publisher.publishReply(
            handlePolicyCommand({
                content,
                conversationId: params.conversationId,
                persistence: params.persistence
            }),
            "none"
        );
        return { handled: true, pipelineOutcome: "policy_command" };
    }

    if (content.startsWith("!email")) {
        await params.publisher.publishReply(
            await handleEmailCommand({
                actorId: params.event.payload.sender.actorId,
                bus: params.bus,
                content,
                conversationId: params.conversationId,
                persistence: params.persistence
            }),
            "none"
        );
        return { handled: true, pipelineOutcome: "email_command" };
    }

    const explicitToolDecision = parseExplicitToolDecision(content);
    if (explicitToolDecision?.decision === "clarify") {
        params.persistence.saveToolExecutionAudit({
            messageId: params.event.payload.messageId,
            toolName: explicitToolDecision.toolName,
            invocationSource: "explicit",
            status: "clarify",
            provider: null,
            detail: explicitToolDecision.reason
        });
        recordToolExecution({ toolName: explicitToolDecision.toolName, status: "clarify" });
        await params.publisher.publishReply(explicitToolDecision.question, "none");
        return { handled: true, pipelineOutcome: "tool_clarify" };
    }

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
            detail: result.policyDecision?.reason ?? result.detail ?? explicitToolDecision.reason
        });
        recordToolExecution({ toolName: result.toolName, status: result.status });
        await params.publisher.publishReply(result.reply, result.route ?? "none");
        return {
            handled: true,
            pipelineOutcome: result.status === "executed" ? "tool_execute" : "tool_clarify"
        };
    }

    if (content.startsWith("!calendar")) {
        await params.publisher.publishReply(
            await handleCalendarCommand({
                calendarClient: params.calendarClient,
                content,
                oauthClient: params.outlookOAuthClient,
                persistence: params.persistence
            })
        );
        return { handled: true, pipelineOutcome: "calendar_command" };
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
