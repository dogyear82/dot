import { parseDuration } from "../../reminders.js";
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
        const leadTimeMs = leadTime ? parseDuration(leadTime) : 0;
        if (leadTime && leadTimeMs == null) {
            return {
                success: false,
                reason: "Lead time must look like 30s, 10m, 2h, or 1d."
            };
        }

        const events = await context.calendarClient.listUpcomingEvents();
        const selectedEvent = events[index - 1];
        if (!selectedEvent) {
            return {
                success: false,
                reason: `Calendar event #${index} was not found.`
            };
        }

        const dueAt = new Date(new Date(selectedEvent.startAt).getTime() - (leadTimeMs ?? 0));
        if (Number.isNaN(dueAt.getTime())) {
            return {
                success: false,
                reason: `Calendar event #${index} has an invalid start time.`
            };
        }

        if (dueAt.getTime() <= Date.now()) {
            return {
                success: false,
                reason: `Calendar event #${index} starts too soon for that reminder lead time.`
            };
        }

        const reminderMessage = buildCalendarReminderMessage(selectedEvent.subject, selectedEvent.startAt, leadTimeMs ?? 0);
        const reminder = context.persistence.createReminder(reminderMessage, dueAt.toISOString());

        return {
            success: true,
            result: `Saved reminder #${reminder.id} for Outlook event #${index} at ${dueAt.toISOString()}: ${reminder.message}`
        };
    }
};

function buildCalendarReminderMessage(subject: string, startAt: string, leadTimeMs: number): string {
    const leadDescription = leadTimeMs > 0 ? ` in ${formatLeadTime(leadTimeMs)}` : "";
    return `${subject} starts at ${startAt}${leadDescription}`;
}

function formatLeadTime(durationMs: number): string {
    const units = [
        { label: "d", ms: 24 * 60 * 60 * 1000 },
        { label: "h", ms: 60 * 60 * 1000 },
        { label: "m", ms: 60 * 1000 },
        { label: "s", ms: 1000 }
    ];

    for (const unit of units) {
        if (durationMs % unit.ms === 0) {
            return `${durationMs / unit.ms}${unit.label}`;
        }
    }

    return `${durationMs}ms`;
}
