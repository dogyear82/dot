import { normalizeDurationInput, handleReminderCommand } from "../../reminders.js";
import type { Tool } from "../types.js";
import { getStringArg } from "../shared/args.js";

export const reminderAddTool: Tool = {
    name: "reminder.add",
    description: "Add a reminder.",
    execute(args, context) {
        const rawDuration = getStringArg(args, "duration") ?? getStringArg(args, "time") ?? getStringArg(args, "when");
        const dueAt = getStringArg(args, "dueAt");
        const message = getStringArg(args, "message");

        if (!rawDuration && !dueAt && !message) {
            return {
                success: false,
                reason: "When should I remind you, and what should I remind you about?"
            };
        }

        if (!rawDuration && !dueAt) {
            return {
                success: false,
                reason: "What duration from now should I set the reminder for?"
            };
        }

        if (!message) {
            return {
                success: false,
                reason: "What should the reminder say?"
            };
        }

        if (dueAt) {
            const reminder = context.persistence.createReminder(message, dueAt);
            return {
                success: true,
                result: `Saved reminder #${reminder.id} for ${reminder.dueAt}: ${reminder.message}`
            };
        }

        const normalizedDuration = rawDuration ? normalizeDurationInput(rawDuration) : null;
        if (!normalizedDuration) {
            return {
                success: false,
                reason: "I need a duration like 10 seconds, 15 minutes, 2 hours, or 1 day."
            };
        }

        return {
            success: true,
            result: handleReminderCommand(context.persistence, `!reminder add ${normalizedDuration} ${message}`)
        };
    }
};
