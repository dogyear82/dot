import type { OutlookCalendarClient } from "../outlookCalendar.js";
import { handleCalendarCommand } from "../outlookCalendar.js";
import type { MicrosoftOutlookOAuthClient } from "../outlookOAuth.js";
import type { Persistence } from "../persistence.js";
import type { Command } from "./types.js";

export function createCalendarCommand(params: {
    calendarClient: OutlookCalendarClient;
    outlookOAuthClient: MicrosoftOutlookOAuthClient;
    persistence: Persistence;
}): Command {
    return {
        name: "calendar",
        description: "Handle calendar commands.",
        ownerOnly: true,
        matches(input) {
            return input.startsWith("!calendar");
        },
        execute(input) {
            return handleCalendarCommand({
                calendarClient: params.calendarClient,
                content: input,
                oauthClient: params.outlookOAuthClient,
                persistence: params.persistence
            });
        }
    };
}
