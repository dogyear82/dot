import type { EventBus } from "../eventBus.js";
import type { OutlookCalendarClient } from "../outlookCalendar.js";
import type { MicrosoftOutlookOAuthClient } from "../outlookOAuth.js";
import type { Persistence } from "../persistence.js";
import type { WorldLookupSourceName } from "../types.js";
import type { WorldLookupAdapter } from "../worldLookup.js";
import type { GroundedAnswerService } from "../toolInvocation.js";
import { createCommandRegistry } from "../commands/registry.js";

export type CommandHandlerOutcome =
    | { handled: false }
    | {
        handled: true;
        pipelineOutcome: string;
        reply: string;
        route: import("../chat/modelRouter.js").LlmRoute;
        recordConversationTurn?: boolean;
    };

export async function handleCommand(params: {
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
    const commands = createCommandRegistry({
        actorId: params.event.payload.sender.actorId,
        bus: params.bus,
        calendarClient: params.calendarClient,
        conversationId: params.conversationId,
        event: params.event,
        groundedAnswerService: params.groundedAnswerService,
        outlookOAuthClient: params.outlookOAuthClient,
        persistence: params.persistence,
        worldLookupAdapters: params.worldLookupAdapters
    });
    const command = commands.find((candidate) => candidate.matches(params.content));
    if (!command) {
        return { handled: false };
    }

    return {
        handled: true,
        pipelineOutcome: "command_executed",
        reply: await command.execute(params.content),
        route: "none"
    };
}

export function isOwnerOnlyCommand(content: string): boolean {
    const commands = createCommandRegistry({
        actorId: "",
        bus: {} as EventBus,
        calendarClient: {} as OutlookCalendarClient,
        conversationId: "",
        event: {} as import("../events.js").InboundMessageReceivedEvent,
        outlookOAuthClient: {} as MicrosoftOutlookOAuthClient,
        persistence: {} as Persistence
    });
    const command = commands.find((candidate) => candidate.matches(content));
    return command?.ownerOnly === true;
}

export function isRegisteredExplicitCommand(content: string): boolean {
    const commands = createCommandRegistry({
        actorId: "",
        bus: {} as EventBus,
        calendarClient: {} as OutlookCalendarClient,
        conversationId: "",
        event: {} as import("../events.js").InboundMessageReceivedEvent,
        outlookOAuthClient: {} as MicrosoftOutlookOAuthClient,
        persistence: {} as Persistence
    });
    return commands.some((candidate) => candidate.matches(content));
}
