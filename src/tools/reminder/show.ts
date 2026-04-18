import { handleReminderCommand } from "../../reminders.js";
import type { Tool } from "../types.js";

export const reminderShowTool: Tool = {
    name: "reminder.show",
    description: "Show reminders.",
    execute(_args, context) {
        return {
            success: true,
            result: handleReminderCommand(context.persistence, "!reminder show")
        };
    }
};
