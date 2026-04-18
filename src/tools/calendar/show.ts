import type { Tool } from "../types.js";

export const calendarShowTool: Tool = {
    name: "calendar.show",
    description: "Show calendar items.",
    async execute(_args, context) {
        if (!context.calendarClient) {
            return {
                success: false,
                reason: "Calendar is not configured."
            };
        }

        const events = await context.calendarClient.listUpcomingEvents();
        if (events.length === 0) {
            return {
                success: true,
                result: "No upcoming Outlook calendar events were found in the configured lookahead window."
            };
        }

        return {
            success: true,
            result: [
                "Upcoming Outlook events:",
                ...events.map((event, index) => `- #${index + 1} ${event.subject} (${event.startAt} to ${event.endAt})`)
            ].join("\n")
        };
    }
};
