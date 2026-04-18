import type { Tool } from "../types.js";
import { getPositiveIntArg } from "../shared/args.js";

export const reminderAckTool: Tool = {
    name: "reminder.ack",
    description: "Acknowledge a reminder.",
    execute(args, context) {
        const id = getPositiveIntArg(args, "id");
        if (id == null) {
            return {
                success: false,
                reason: "Which reminder should I acknowledge?"
            };
        }

        const acknowledged = context.persistence.acknowledgeReminder(id);
        return {
            success: true,
            result: acknowledged
                ? `Acknowledged reminder #${id}.`
                : `Reminder #${id} was not found or is already acknowledged.`
        };
    }
};
