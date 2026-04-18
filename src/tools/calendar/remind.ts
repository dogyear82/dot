import { handleCalendarCommand } from "../../outlookCalendar.js";
import type { Tool } from "../types.js";
import { getPositiveIntArg, getStringArg } from "../shared/args.js";

export const calendarRemindTool: Tool = {
    name: "calendar.remind",
    description: "Create a reminder for a calendar item.",
    async execute(args, context) {
        if (!context.calendarClient) {
            return {
                success: false,
                reason: "Calendar is not configured."
            };
        }

        const index = getPositiveIntArg(args, "index");
        if (index == null) {
            return {
                success: false,
                reason: "Which calendar item should I remind you about?"
            };
        }

        const leadTime = getStringArg(args, "leadTime");
        const content = leadTime ? `!calendar remind ${index} ${leadTime}` : `!calendar remind ${index}`;

        return {
            success: true,
            result: await handleCalendarCommand({
                calendarClient: context.calendarClient,
                content,
                persistence: context.persistence
            })
        };
    }
};
