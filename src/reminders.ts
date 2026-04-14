import type { Logger } from "pino";

import type { EventBus } from "./eventBus.js";
import { createOwnerDiscordDirectMessageNotification } from "./notifications.js";
import type { Persistence } from "./persistence.js";
import type { ReminderRecord } from "./types.js";

const REMINDER_POLL_INTERVAL_MS = 5000;
const NAG_FOLLOW_UP_MS = 5 * 60 * 1000;
const DELIVERY_RETRY_MS = 60 * 1000;
const MAX_NAG_NOTIFICATIONS = 3;

export function isReminderCommand(content: string): boolean {
  return (
    content === "!reminder" ||
    content === "!reminder help" ||
    content === "!reminder show" ||
    content.startsWith("!reminder add ") ||
    content.startsWith("!reminder ack ") ||
    content.startsWith("!remind ")
  );
}

export function handleReminderCommand(persistence: Persistence, content: string, now = new Date()): string {
  const parts = normalizeReminderCommand(content).split(/\s+/);

  if (parts[0] === "remind") {
    return handleReminderAdd(persistence, parts.slice(1), now);
  }

  if (parts.length === 1 || parts[1] === "help") {
    return [
      "Reminder commands:",
      "- `!reminder add <duration> <message>`",
      "- `!remind <duration> <message>`",
      "- `!reminder show`",
      "- `!reminder ack <id>`"
    ].join("\n");
  }

  if (parts[1] === "add") {
    return handleReminderAdd(persistence, parts.slice(2), now);
  }

  if (parts[1] === "show") {
    const reminders = persistence.listPendingReminders();
    if (reminders.length === 0) {
      return "No pending reminders.";
    }

    return [
      "Pending reminders:",
      ...reminders.map((reminder) => `- #${reminder.id} due ${reminder.dueAt}: ${reminder.message}`)
    ].join("\n");
  }

  if (parts[1] === "ack" && parts[2]) {
    const id = Number(parts[2]);
    if (!Number.isInteger(id) || id <= 0) {
      return "Reminder IDs must be positive integers.";
    }

    return persistence.acknowledgeReminder(id)
      ? `Acknowledged reminder #${id}.`
      : `Reminder #${id} was not found or is already acknowledged.`;
  }

  return "Invalid reminder command. Use `!reminder help`.";
}

export function getNextReminderNotificationAt(
  reminder: ReminderRecord,
  escalationPolicy: string,
  now = new Date()
): string | null {
  if (escalationPolicy === "nag-only" || escalationPolicy === "discord-then-sms") {
    if (escalationPolicy === "discord-then-sms") {
      return null;
    }

    if (reminder.notificationCount + 1 >= MAX_NAG_NOTIFICATIONS) {
      return null;
    }

    return new Date(now.getTime() + NAG_FOLLOW_UP_MS).toISOString();
  }

  return null;
}

export function formatReminderNotification(reminder: ReminderRecord): string {
  const prefix = reminder.notificationCount === 0 ? "Reminder" : `Reminder follow-up ${reminder.notificationCount}`;
  return `${prefix} #${reminder.id}: ${reminder.message}\nReply with \`reminder ack ${reminder.id}\` when handled.`;
}

export function getReminderDeliveryRetryAt(now = new Date()): string {
  return new Date(now.getTime() + DELIVERY_RETRY_MS).toISOString();
}

export function startReminderScheduler(params: {
  bus: EventBus;
  logger: Logger;
  ownerUserId: string;
  pollIntervalMs?: number;
  persistence: Persistence;
}) {
  const { bus, logger, ownerUserId, persistence, pollIntervalMs = REMINDER_POLL_INTERVAL_MS } = params;
  let running = false;
  const inflightReminders = new Map<number, number>();

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      const dueReminders = persistence
        .listDueReminders(new Date().toISOString())
        .filter((reminder) => {
          const inflightStartedAt = inflightReminders.get(reminder.id);
          if (inflightStartedAt == null) {
            return true;
          }

          if (Date.now() - inflightStartedAt >= DELIVERY_RETRY_MS) {
            inflightReminders.delete(reminder.id);
            return true;
          }

          return false;
        });
      if (dueReminders.length === 0) {
        return;
      }

      for (const reminder of dueReminders) {
        try {
          inflightReminders.set(reminder.id, Date.now());
          await bus.publishOutboundMessage(
            createOwnerDiscordDirectMessageNotification({
              content: formatReminderNotification(reminder),
              ownerUserId,
              producerService: "reminders",
              correlationId: `reminder:${reminder.id}`,
              actorId: ownerUserId,
              deliveryContext: {
                kind: "reminder",
                reminderId: reminder.id
              }
            })
          );
          logger.info({ reminderId: reminder.id }, "Published reminder delivery request");
        } catch (error) {
          inflightReminders.delete(reminder.id);
          const retryAt = getReminderDeliveryRetryAt(new Date());
          persistence.recordReminderDeliveryFailure(
            reminder.id,
            retryAt,
            error instanceof Error ? error.message : "unknown delivery failure"
          );
          logger.error({ err: error, reminderId: reminder.id, retryAt }, "Failed to send reminder notification");
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Failed to process reminder notifications");
    } finally {
      running = false;
    }
  };

  const unsubscribeDelivered = bus.subscribeOutboundMessageDelivered(async (event) => {
    const context = event.payload.deliveryContext;
    if (context?.kind !== "reminder") {
      return;
    }

    inflightReminders.delete(context.reminderId);

    const reminder = persistence.listPendingReminders().find((candidate) => candidate.id === context.reminderId);
    if (!reminder) {
      return;
    }

    const nextNotificationAt = getNextReminderNotificationAt(
      reminder,
      persistence.settings.get("reminders.escalationPolicy") ?? "discord-only",
      new Date()
    );
    if (persistence.recordReminderNotification(reminder.id, nextNotificationAt, reminder.message)) {
      logger.info({ reminderId: reminder.id, nextNotificationAt }, "Sent reminder notification");
    }
  });

  const unsubscribeFailed = bus.subscribeOutboundMessageDeliveryFailed(async (event) => {
    const context = event.payload.deliveryContext;
    if (context?.kind !== "reminder") {
      return;
    }

    inflightReminders.delete(context.reminderId);
    const retryAt = getReminderDeliveryRetryAt(new Date());
    persistence.recordReminderDeliveryFailure(context.reminderId, retryAt, event.payload.reason);
    logger.error(
      { reminderId: context.reminderId, retryAt, reason: event.payload.reason },
      "Failed to send reminder notification"
    );
  });

  const intervalId = setInterval(() => {
    void tick();
  }, pollIntervalMs);

  return {
    stop() {
      clearInterval(intervalId);
      unsubscribeDelivered();
      unsubscribeFailed();
    }
  };
}

function handleReminderAdd(persistence: Persistence, args: string[], now: Date): string {
  const durationInput = args[0];
  const reminderMessage = args.slice(1).join(" ").trim();

  if (!durationInput || !reminderMessage) {
    return "Usage: `!reminder add <duration> <message>` or `!remind <duration> <message>`.";
  }

  const durationMs = parseDuration(durationInput);

  if (durationMs == null) {
    return "Duration must look like `30s`, `10m`, `2h`, or `1d`.";
  }

  const dueAt = new Date(now.getTime() + durationMs).toISOString();
  const reminder = persistence.createReminder(reminderMessage, dueAt);
  return `Saved reminder #${reminder.id} for ${dueAt}: ${reminder.message}`;
}

export function parseDuration(input: string): number | null {
  const normalized = normalizeDurationInput(input);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(\d+)(s|m|h|d)$/i);

  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();

  if (!Number.isInteger(value) || value <= 0 || !unit) {
    return null;
  }

  const unitMs = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  }[unit];

  if (unitMs == null) {
    return null;
  }

  return value * unitMs;
}

export function normalizeDurationInput(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const compactMatch = trimmed.match(/^(\d+)\s*(s|m|h|d)$/i);
  if (compactMatch) {
    return `${compactMatch[1]}${compactMatch[2]?.toLowerCase()}`;
  }

  const phraseMatch = trimmed.match(/^in\s+(\d+)\s*(seconds?|minutes?|hours?|days?)$/i) ?? trimmed.match(/^(\d+)\s*(seconds?|minutes?|hours?|days?)$/i);
  if (!phraseMatch) {
    return null;
  }

  const value = phraseMatch[1];
  const unit = phraseMatch[2]?.toLowerCase();
  if (!value || !unit) {
    return null;
  }

  switch (unit) {
    case "second":
    case "seconds":
      return `${value}s`;
    case "minute":
    case "minutes":
      return `${value}m`;
    case "hour":
    case "hours":
      return `${value}h`;
    case "day":
    case "days":
      return `${value}d`;
    default:
      return null;
  }
}

function normalizeReminderCommand(content: string) {
  return content.trim().replace(/^!/, "");
}
