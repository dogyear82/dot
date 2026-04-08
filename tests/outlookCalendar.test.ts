import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { initializePersistence } from "../src/persistence.js";
import {
  buildCalendarReminderMessage,
  formatCalendarError,
  handleCalendarCommand,
  isCalendarCommand,
  MicrosoftGraphOutlookCalendarClient,
  OutlookConfigurationError
} from "../src/outlookCalendar.js";
import type { OutlookCalendarEvent } from "../src/types.js";

function createPersistence() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-outlook-"));
  const sqlitePath = path.join(tempDir, "dot.sqlite");
  const persistence = initializePersistence(tempDir, sqlitePath);

  return {
    persistence,
    cleanup() {
      persistence.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

function createEvent(overrides: Partial<OutlookCalendarEvent> = {}): OutlookCalendarEvent {
  return {
    id: "evt-1",
    subject: "Standup",
    startAt: "2026-04-08T10:00:00.000Z",
    endAt: "2026-04-08T10:30:00.000Z",
    webLink: null,
    ...overrides
  };
}

test("isCalendarCommand only matches supported calendar commands", () => {
  assert.equal(isCalendarCommand("calendar"), true);
  assert.equal(isCalendarCommand("calendar help"), true);
  assert.equal(isCalendarCommand("calendar show"), true);
  assert.equal(isCalendarCommand("calendar remind 1"), true);
  assert.equal(isCalendarCommand("calendar reminders"), false);
  assert.equal(isCalendarCommand("calendarish"), false);
});

test("handleCalendarCommand lists upcoming events", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reply = await handleCalendarCommand({
      calendarClient: {
        async listUpcomingEvents() {
          return [createEvent()];
        }
      },
      content: "calendar show",
      now: new Date("2026-04-08T09:00:00.000Z"),
      persistence
    });

    assert.match(reply, /Upcoming Outlook events/);
    assert.match(reply, /Standup/);
  } finally {
    cleanup();
  }
});

test("handleCalendarCommand can derive a reminder from an upcoming event", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reply = await handleCalendarCommand({
      calendarClient: {
        async listUpcomingEvents() {
          return [createEvent()];
        }
      },
      content: "calendar remind 1 15m",
      now: new Date("2026-04-08T09:00:00.000Z"),
      persistence
    });

    assert.match(reply, /Saved reminder #1/);
    const reminders = persistence.listPendingReminders();
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0]?.dueAt, "2026-04-08T09:45:00.000Z");
    assert.match(reminders[0]?.message ?? "", /Standup starts at 2026-04-08T10:00:00.000Z in 15m/);
  } finally {
    cleanup();
  }
});

test("handleCalendarCommand surfaces adapter failures without creating reminders", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reply = await handleCalendarCommand({
      calendarClient: {
        async listUpcomingEvents() {
          throw new OutlookConfigurationError("Outlook calendar integration is not configured.");
        }
      },
      content: "calendar remind 1",
      now: new Date("2026-04-08T09:00:00.000Z"),
      persistence
    });

    assert.match(reply, /not configured/);
    assert.equal(persistence.listPendingReminders().length, 0);
  } finally {
    cleanup();
  }
});

test("MicrosoftGraphOutlookCalendarClient requests calendar view and maps UTC events", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(String(input), "https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=2026-04-08T09%3A00%3A00.000Z&endDateTime=2026-04-15T09%3A00%3A00.000Z&%24top=5&%24orderby=start%2FdateTime&%24select=id%2Csubject%2Cstart%2Cend%2CwebLink");
    assert.equal(init?.headers instanceof Object, true);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer token-123");
    assert.equal(headers.Prefer, 'outlook.timezone="UTC"');

    return new Response(
      JSON.stringify({
        value: [
          {
            id: "evt-1",
            subject: "Budget review",
            start: { dateTime: "2026-04-08T10:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-04-08T11:00:00.0000000", timeZone: "UTC" },
            webLink: "https://example.test/event"
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const client = new MicrosoftGraphOutlookCalendarClient(
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_OWNER_USER_ID: "owner",
        OUTLOOK_ACCESS_TOKEN: "token-123"
      })
    );

    const events = await client.listUpcomingEvents(new Date("2026-04-08T09:00:00.000Z"));
    assert.deepEqual(events, [
      {
        id: "evt-1",
        subject: "Budget review",
        startAt: "2026-04-08T10:00:00.000Z",
        endAt: "2026-04-08T11:00:00.000Z",
        webLink: "https://example.test/event"
      }
    ]);
  } finally {
    fetchMock.mock.restore();
  }
});

test("buildCalendarReminderMessage describes the event and lead time", () => {
  assert.equal(
    buildCalendarReminderMessage(createEvent({ subject: "Doctor appointment" }), 600_000),
    "Doctor appointment starts at 2026-04-08T10:00:00.000Z in 10m"
  );
  assert.equal(formatCalendarError(new Error("boom")), "Outlook calendar request failed: boom");
  assert.equal(
    formatCalendarError(new Error("Outlook calendar request failed: 401 bad token")),
    "Outlook calendar request failed: 401 bad token"
  );
});
