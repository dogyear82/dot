import type { AppConfig } from "./config.js";
import type { Persistence } from "./persistence.js";
import { parseDuration } from "./reminders.js";
import type { OutlookCalendarEvent } from "./types.js";

const DEFAULT_EVENT_LIMIT = 5;

export interface OutlookCalendarClient {
  listUpcomingEvents(now?: Date, limit?: number): Promise<OutlookCalendarEvent[]>;
}

interface MicrosoftGraphEvent {
  id: string;
  subject?: string | null;
  webLink?: string | null;
  start?: {
    dateTime?: string | null;
    timeZone?: string | null;
  } | null;
  end?: {
    dateTime?: string | null;
    timeZone?: string | null;
  } | null;
}

interface MicrosoftGraphCalendarViewResponse {
  value?: MicrosoftGraphEvent[];
}

export class OutlookConfigurationError extends Error {}

export class MicrosoftGraphOutlookCalendarClient implements OutlookCalendarClient {
  constructor(private readonly config: Pick<AppConfig, "OUTLOOK_ACCESS_TOKEN" | "OUTLOOK_GRAPH_BASE_URL" | "OUTLOOK_CALENDAR_ID" | "OUTLOOK_LOOKAHEAD_DAYS">) {}

  async listUpcomingEvents(now = new Date(), limit = DEFAULT_EVENT_LIMIT): Promise<OutlookCalendarEvent[]> {
    if (!this.config.OUTLOOK_ACCESS_TOKEN) {
      throw new OutlookConfigurationError(
        "Outlook calendar integration is not configured. Set `OUTLOOK_ACCESS_TOKEN` before using calendar commands."
      );
    }

    const start = now.toISOString();
    const end = new Date(now.getTime() + this.config.OUTLOOK_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const calendarPath = this.config.OUTLOOK_CALENDAR_ID
      ? `/me/calendars/${encodeURIComponent(this.config.OUTLOOK_CALENDAR_ID)}/calendarView`
      : "/me/calendarView";
    const url = new URL(`${this.config.OUTLOOK_GRAPH_BASE_URL}${calendarPath}`);
    url.searchParams.set("startDateTime", start);
    url.searchParams.set("endDateTime", end);
    url.searchParams.set("$top", String(limit));
    url.searchParams.set("$orderby", "start/dateTime");
    url.searchParams.set("$select", "id,subject,start,end,webLink");

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.config.OUTLOOK_ACCESS_TOKEN}`,
        Prefer: 'outlook.timezone="UTC"'
      }
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Outlook calendar request failed: ${response.status} ${detail}`.trim());
    }

    const payload = (await response.json()) as MicrosoftGraphCalendarViewResponse;
    return (payload.value ?? [])
      .map((event) => mapMicrosoftGraphEvent(event))
      .filter((event): event is OutlookCalendarEvent => event != null);
  }
}

export function isCalendarCommand(content: string): boolean {
  return (
    content === "!calendar" ||
    content === "!calendar help" ||
    content === "!calendar show" ||
    content.startsWith("!calendar remind ")
  );
}

export async function handleCalendarCommand(params: {
  calendarClient: OutlookCalendarClient;
  content: string;
  now?: Date;
  persistence: Persistence;
}): Promise<string> {
  const { calendarClient, content, now = new Date(), persistence } = params;
  const parts = normalizeCalendarCommand(content).split(/\s+/);

  if (parts.length === 1 || parts[1] === "help") {
    return [
      "Calendar commands:",
      "- `!calendar show`",
      "- `!calendar remind <index> [lead-time]`",
      "Examples:",
      "- `!calendar remind 1`",
      "- `!calendar remind 2 15m`"
    ].join("\n");
  }

  if (parts[1] === "show") {
    try {
      const events = await calendarClient.listUpcomingEvents(now, DEFAULT_EVENT_LIMIT);
      if (events.length === 0) {
        return "No upcoming Outlook calendar events were found in the configured lookahead window.";
      }

      return [
        "Upcoming Outlook events:",
        ...events.map((event, index) => formatEventSummary(index + 1, event))
      ].join("\n");
    } catch (error) {
      return formatCalendarError(error);
    }
  }

  if (parts[1] === "remind" && parts[2]) {
    const index = Number(parts[2]);
    if (!Number.isInteger(index) || index <= 0) {
      return "Calendar event indexes must be positive integers. Use `!calendar show` first.";
    }

    const leadTime = parts[3] ? parseDuration(parts[3]) : 0;
    if (parts[3] && leadTime == null) {
      return "Lead time must look like `30s`, `10m`, `2h`, or `1d`.";
    }

    try {
      const events = await calendarClient.listUpcomingEvents(now, DEFAULT_EVENT_LIMIT);
      const selectedEvent = events[index - 1];
      if (!selectedEvent) {
        return `Calendar event #${index} was not found. Use \`!calendar show\` to refresh the list.`;
      }

      const dueAt = new Date(new Date(selectedEvent.startAt).getTime() - (leadTime ?? 0));
      if (Number.isNaN(dueAt.getTime())) {
        return `Calendar event #${index} has an invalid start time.`;
      }

      if (dueAt.getTime() <= now.getTime()) {
        return `Calendar event #${index} starts too soon for that reminder lead time.`;
      }

      const reminderMessage = buildCalendarReminderMessage(selectedEvent, leadTime ?? 0);
      const reminder = persistence.createReminder(reminderMessage, dueAt.toISOString());
      return `Saved reminder #${reminder.id} for Outlook event #${index} at ${dueAt.toISOString()}: ${reminder.message}`;
    } catch (error) {
      return formatCalendarError(error);
    }
  }

  return "Invalid calendar command. Use `!calendar help`.";
}

export function formatEventSummary(index: number, event: OutlookCalendarEvent): string {
  return `- #${index} ${event.subject} (${event.startAt} to ${event.endAt})`;
}

export function buildCalendarReminderMessage(event: OutlookCalendarEvent, leadTimeMs: number): string {
  const leadDescription = leadTimeMs > 0 ? ` in ${formatLeadTime(leadTimeMs)}` : "";
  return `${event.subject} starts at ${event.startAt}${leadDescription}`;
}

export function formatCalendarError(error: unknown): string {
  if (error instanceof OutlookConfigurationError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message.startsWith("Outlook calendar request failed:")
      ? error.message
      : `Outlook calendar request failed: ${error.message}`;
  }

  return "Outlook calendar request failed.";
}

function mapMicrosoftGraphEvent(event: MicrosoftGraphEvent): OutlookCalendarEvent | null {
  if (!event.id || !event.start?.dateTime || !event.end?.dateTime) {
    return null;
  }

  const startAt = normalizeGraphDateTime(event.start.dateTime, event.start.timeZone);
  const endAt = normalizeGraphDateTime(event.end.dateTime, event.end.timeZone);
  if (!startAt || !endAt) {
    return null;
  }

  return {
    id: event.id,
    subject: event.subject?.trim() || "Untitled event",
    startAt,
    endAt,
    webLink: event.webLink ?? null
  };
}

function normalizeGraphDateTime(dateTime: string, timeZone?: string | null): string | null {
  const normalizedInput =
    timeZone === "UTC" && !/[zZ]|[+-]\d{2}:\d{2}$/.test(dateTime) ? `${dateTime}Z` : dateTime;
  const parsed = new Date(normalizedInput);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
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

function normalizeCalendarCommand(content: string) {
  return content.trim().replace(/^!/, "");
}
