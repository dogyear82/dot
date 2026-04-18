import type { EventBus } from "../eventBus.js";
import type { OutlookCalendarClient } from "../outlookCalendar.js";
import type { MicrosoftOutlookOAuthClient } from "../outlookOAuth.js";
import type { Persistence } from "../persistence.js";
import type { GroundedAnswerService } from "../toolInvocation.js";
import type { WorldLookupSourceName } from "../types.js";
import type { WorldLookupAdapter } from "../worldLookup.js";
import { createCalendarCommand } from "./calendarCommand.js";
import { createContactCommand } from "./contactCommand.js";
import { createEmailCommand } from "./emailCommand.js";
import { createExplicitToolCommand } from "./explicitToolCommand.js";
import { createNewsPreferencesCommand } from "./newsPreferencesCommand.js";
import { createPersonalityCommand } from "./personalityCommand.js";
import { createPolicyCommand } from "./policyCommand.js";
import { createSettingsCommand } from "./settingsCommand.js";
import type { Command } from "./types.js";

export function createCommandRegistry(params: {
    actorId: string;
    bus: EventBus;
    calendarClient: OutlookCalendarClient;
    conversationId: string;
    event: import("../events.js").InboundMessageReceivedEvent;
    groundedAnswerService?: GroundedAnswerService;
    outlookOAuthClient: MicrosoftOutlookOAuthClient;
    persistence: Persistence;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
}): Command[] {
    return [
        createSettingsCommand(params.persistence.settings),
        createNewsPreferencesCommand(params.persistence),
        createPersonalityCommand(params.persistence),
        createContactCommand(params.persistence, params.conversationId),
        createPolicyCommand(params.persistence, params.conversationId),
        createEmailCommand({
            actorId: params.actorId,
            bus: params.bus,
            conversationId: params.conversationId,
            persistence: params.persistence
        }),
        createExplicitToolCommand({
            calendarClient: params.calendarClient,
            conversationId: params.conversationId,
            event: params.event,
            groundedAnswerService: params.groundedAnswerService,
            persistence: params.persistence,
            worldLookupAdapters: params.worldLookupAdapters
        }),
        createCalendarCommand({
            calendarClient: params.calendarClient,
            outlookOAuthClient: params.outlookOAuthClient,
            persistence: params.persistence
        })
    ];
}
