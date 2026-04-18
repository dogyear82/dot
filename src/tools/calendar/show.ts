import { handleCalendarCommand } from "../../outlookCalendar.js";
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

        return {
            success: true,
            result: await handleCalendarCommand({
                calendarClient: context.calendarClient,
                content: "!calendar show",
                persistence: context.persistence
            })
        };
    }
};
