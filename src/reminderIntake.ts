import { normalizeDurationInput } from "./reminders.js";

export type ReminderIntakeStep =
  | "collect_message"
  | "choose_schedule_mode"
  | "collect_duration"
  | "collect_specific_date"
  | "collect_specific_time"
  | "confirm";

export type ReminderScheduleMode = "duration" | "specific";

export interface ReminderIntakeState {
  engine: "reminder.add.intake";
  step: ReminderIntakeStep;
  data: {
    message?: string;
    scheduleMode?: ReminderScheduleMode;
    duration?: string;
    specificDate?: string;
    specificTime?: string;
    dueAt?: string;
  };
}

export type ReminderIntakeOutcome =
  | { kind: "clarify"; prompt: string; state: ReminderIntakeState }
  | { kind: "requires_confirmation"; prompt: string; state: ReminderIntakeState }
  | { kind: "execute"; args: Record<string, string | number> };

export function startReminderIntake(params: {
  args: Record<string, string | number>;
  now?: Date;
}): ReminderIntakeOutcome {
  const now = params.now ?? new Date();
  const message = getStringArg(params.args, "message");
  const rawDuration = getStringArg(params.args, "duration") ?? getStringArg(params.args, "time") ?? getStringArg(params.args, "when");
  const dueAt = getStringArg(params.args, "dueAt");

  if (!message) {
    return {
      kind: "clarify",
      prompt: "OK sweetie. Let me fire up that intake form.\n\nWhat should the reminder say?",
      state: {
        engine: "reminder.add.intake",
        step: "collect_message",
        data: {}
      }
    };
  }

  if (dueAt) {
    const parsedDueAt = new Date(dueAt);
    if (!Number.isNaN(parsedDueAt.getTime()) && parsedDueAt.getTime() > now.getTime()) {
      return {
        kind: "requires_confirmation",
        prompt: `I've got a reminder to ${message} on ${formatSpecificDateTimeForConfirmation(parsedDueAt)}. Want me to save it?`,
        state: {
          engine: "reminder.add.intake",
          step: "confirm",
          data: {
            message,
            scheduleMode: "specific",
            dueAt
          }
        }
      };
    }

    return {
      kind: "clarify",
      prompt: "I couldn't pin down that specific time cleanly. What day should I use? You can say `today`, `tomorrow`, or a day like `the 14th`.",
      state: {
        engine: "reminder.add.intake",
        step: "collect_specific_date",
        data: {
          message,
          scheduleMode: "specific"
        }
      }
    };
  }

  if (rawDuration) {
    const normalizedDuration = normalizeDurationInput(rawDuration);
    if (normalizedDuration) {
      return buildDurationConfirmation(message, rawDuration, normalizedDuration);
    }
  }

  return {
    kind: "clarify",
    prompt: "OK sweetie. Let me fire up that intake form.\n\nDo you want a specific time or a duration from now?",
    state: {
      engine: "reminder.add.intake",
      step: "choose_schedule_mode",
      data: {
        message
      }
    }
  };
}

export function continueReminderIntake(params: {
  state: ReminderIntakeState;
  userMessage: string;
  now?: Date;
}): ReminderIntakeOutcome {
  const now = params.now ?? new Date();
  const input = params.userMessage.trim();
  const normalized = normalizeUserInput(input);
  const data = params.state.data;

  switch (params.state.step) {
    case "collect_message": {
      if (!input) {
        return {
          kind: "clarify",
          prompt: "What should the reminder say?",
          state: params.state
        };
      }
      return {
        kind: "clarify",
        prompt: "Do you want a specific time or a duration from now?",
        state: {
          engine: "reminder.add.intake",
          step: "choose_schedule_mode",
          data: {
            ...data,
            message: input
          }
        }
      };
    }
    case "choose_schedule_mode": {
      const scheduleMode = parseScheduleMode(normalized);
      if (!scheduleMode) {
        return {
          kind: "clarify",
          prompt: "Tell me `specific` for a date and time, or `duration` if you want it after some amount of time from now.",
          state: params.state
        };
      }

      if (scheduleMode === "duration") {
        return {
          kind: "clarify",
          prompt: "How long from now should I set it for?",
          state: {
            engine: "reminder.add.intake",
            step: "collect_duration",
            data: {
              ...data,
              scheduleMode
            }
          }
        };
      }

      return {
        kind: "clarify",
        prompt: "What day should I use? You can say `today`, `tomorrow`, or a day like `the 14th`.",
        state: {
          engine: "reminder.add.intake",
          step: "collect_specific_date",
          data: {
            ...data,
            scheduleMode
          }
        }
      };
    }
    case "collect_duration": {
      const normalizedDuration = normalizeDurationInput(input);
      if (!normalizedDuration) {
        return {
          kind: "clarify",
          prompt: "I need a duration from now, like `10 seconds`, `15 minutes`, `2 hours`, or `1 day`.",
          state: params.state
        };
      }
      return buildDurationConfirmation(data.message ?? "that", input, normalizedDuration);
    }
    case "collect_specific_date": {
      const parsedDate = parseSpecificDate(input, now);
      if (!parsedDate) {
        return {
          kind: "clarify",
          prompt: "Give me the day as `today`, `tomorrow`, or something like `the 14th`.",
          state: params.state
        };
      }

      return {
        kind: "clarify",
        prompt: "What time should I use? For example `9am`, `12:30pm`, or `21:15`.",
        state: {
          engine: "reminder.add.intake",
          step: "collect_specific_time",
          data: {
            ...data,
            specificDate: parsedDate.toISOString()
          }
        }
      };
    }
    case "collect_specific_time": {
      const specificDate = data.specificDate ? new Date(data.specificDate) : null;
      const timeParts = parseSpecificTime(input);
      if (!specificDate || !timeParts) {
        return {
          kind: "clarify",
          prompt: "Give me the time like `9am`, `12:30pm`, or `21:15`.",
          state: params.state
        };
      }

      const dueAt = new Date(
        specificDate.getFullYear(),
        specificDate.getMonth(),
        specificDate.getDate(),
        timeParts.hours,
        timeParts.minutes,
        0,
        0
      );

      if (Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= now.getTime()) {
        return {
          kind: "clarify",
          prompt: "That specific time is in the past. Give me a future time instead.",
          state: params.state
        };
      }

      return {
        kind: "requires_confirmation",
        prompt: `I've got a reminder to ${data.message ?? "that"} on ${formatSpecificDateTimeForConfirmation(dueAt)}. Want me to save it?`,
        state: {
          engine: "reminder.add.intake",
          step: "confirm",
          data: {
            ...data,
            specificTime: input,
            dueAt: dueAt.toISOString()
          }
        }
      };
    }
    case "confirm": {
      const confirmation = parseConfirmation(normalized);
      if (confirmation === "yes") {
        const executeArgs: Record<string, string | number> = {};
        if (data.message) {
          executeArgs.message = data.message;
        }
        if (data.duration) {
          executeArgs.duration = data.duration;
        }
        if (data.dueAt) {
          executeArgs.dueAt = data.dueAt;
        }
        executeArgs.confirmed = "yes";
        return { kind: "execute", args: executeArgs };
      }

      if (confirmation === "no") {
        return {
          kind: "clarify",
          prompt: "Alright, I won't save it. If you want to try again, start over with the reminder details.",
          state: {
            engine: "reminder.add.intake",
            step: "collect_message",
            data: {}
          }
        };
      }

      return {
        kind: "clarify",
        prompt: "Answer `yes` to save it or `no` to cancel it.",
        state: params.state
      };
    }
  }
}

function buildDurationConfirmation(message: string, rawDuration: string, normalizedDuration: string): ReminderIntakeOutcome {
  return {
    kind: "requires_confirmation",
    prompt: `I've got a reminder to ${message} in ${rawDuration.trim()}. Want me to save it?`,
    state: {
      engine: "reminder.add.intake",
      step: "confirm",
      data: {
        message,
        scheduleMode: "duration",
        duration: normalizedDuration
      }
    }
  };
}

function getStringArg(args: Record<string, string | number>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeUserInput(input: string): string {
  return input.trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
}

function parseScheduleMode(input: string): ReminderScheduleMode | null {
  if (input.includes("specific")) {
    return "specific";
  }
  if (input.includes("duration") || input.includes("after")) {
    return "duration";
  }
  return null;
}

function parseConfirmation(input: string): "yes" | "no" | null {
  if (["yes", "y", "confirm", "confirmed", "do it", "save it", "save"].includes(input)) {
    return "yes";
  }
  if (["no", "n", "cancel", "stop", "don't"].includes(input)) {
    return "no";
  }
  return null;
}

function parseSpecificDate(input: string, now: Date): Date | null {
  const normalized = normalizeUserInput(input);
  if (normalized === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (normalized === "tomorrow") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  }

  const match = normalized.match(/^(?:the\s+)?(\d{1,2})(st|nd|rd|th)?$/);
  if (!match?.[1]) {
    return null;
  }

  const day = Number(match[1]);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return null;
  }

  let year = now.getFullYear();
  let month = now.getMonth();
  let candidate = new Date(year, month, day);
  if (candidate.getDate() !== day) {
    return null;
  }
  if (candidate.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) {
    month += 1;
    candidate = new Date(year, month, day);
    if (candidate.getDate() !== day) {
      return null;
    }
  }
  return candidate;
}

function parseSpecificTime(input: string): { hours: number; minutes: number } | null {
  const normalized = normalizeUserInput(input);
  const ampm = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (ampm?.[1]) {
    let hours = Number(ampm[1]);
    const minutes = Number(ampm[2] ?? "0");
    const suffix = ampm[3];
    if (!Number.isInteger(hours) || hours < 1 || hours > 12 || minutes < 0 || minutes > 59 || !suffix) {
      return null;
    }
    if (suffix === "am") {
      hours = hours === 12 ? 0 : hours;
    } else {
      hours = hours === 12 ? 12 : hours + 12;
    }
    return { hours, minutes };
  }

  const twentyFourHour = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHour?.[1] && twentyFourHour[2]) {
    const hours = Number(twentyFourHour[1]);
    const minutes = Number(twentyFourHour[2]);
    if (!Number.isInteger(hours) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return null;
    }
    return { hours, minutes };
  }

  return null;
}

function formatSpecificDateTimeForConfirmation(dueAt: Date): string {
  const weekday = dueAt.toLocaleDateString("en-US", { weekday: "long" });
  const month = dueAt.toLocaleDateString("en-US", { month: "long" });
  const day = dueAt.getDate();
  const time = dueAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${weekday}, ${month} ${day} at ${time}`;
}
