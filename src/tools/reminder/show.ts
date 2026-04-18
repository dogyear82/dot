import type { Tool } from "../types.js";

export const reminderShowTool: Tool = {
    name: "reminder.show",
    description: "Show reminders.",
    execute(_args, context) {
        const reminders = context.persistence.listPendingReminders();
        if (reminders.length === 0) {
            return {
                success: true,
                result: "No pending reminders."
            };
        }

        return {
            success: true,
            result: [
                "Pending reminders:",
                ...reminders.map((reminder) => `- #${reminder.id} due ${reminder.dueAt}: ${reminder.message}`)
            ].join("\n")
        };
    }
};
