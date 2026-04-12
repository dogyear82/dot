import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInMemoryEventBus } from "../src/eventBus.js";

import { initializePersistence } from "../src/persistence.js";
import {
  formatReminderNotification,
  getNextReminderNotificationAt,
  getReminderDeliveryRetryAt,
  handleReminderCommand,
  isReminderCommand,
  parseDuration,
  startReminderScheduler
} from "../src/reminders.js";
import type { ReminderRecord } from "../src/types.js";

function createReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: 1,
    message: "stretch",
    status: "pending",
    dueAt: "2026-04-08T00:00:00.000Z",
    nextNotificationAt: "2026-04-08T00:00:00.000Z",
    notificationCount: 0,
    lastNotifiedAt: null,
    acknowledgedAt: null,
    createdAt: "2026-04-08T00:00:00.000Z",
    ...overrides
  };
}

test("parseDuration accepts compact duration strings", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("10m"), 600_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.equal(parseDuration("abc"), null);
});

test("isReminderCommand only matches real reminder command prefixes", () => {
  assert.equal(isReminderCommand("!reminder"), true);
  assert.equal(isReminderCommand("!reminder add 10m stretch"), true);
  assert.equal(isReminderCommand("!reminder show"), true);
  assert.equal(isReminderCommand("!remind 10m stretch"), true);
  assert.equal(isReminderCommand("reminders are useful"), false);
  assert.equal(isReminderCommand("remind me in 10m to stretch"), false);
  assert.equal(isReminderCommand("reminder me later"), false);
});

test("handleReminderCommand can add, show, and acknowledge reminders", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-reminders-"));
  const sqlitePath = path.join(tempDir, "dot.sqlite");
  const persistence = initializePersistence(tempDir, sqlitePath);
  const now = new Date("2026-04-08T00:00:00.000Z");

  const addReply = handleReminderCommand(persistence, "!reminder add 10m stretch", now);
  assert.match(addReply, /Saved reminder #1/);

  const showReply = handleReminderCommand(persistence, "!reminder show", now);
  assert.match(showReply, /Pending reminders/);
  assert.match(showReply, /stretch/);

  const eventsBeforeAck = persistence.listReminderEvents(1);
  assert.equal(eventsBeforeAck[0]?.eventType, "created");

  const ackReply = handleReminderCommand(persistence, "!reminder ack 1", now);
  assert.match(ackReply, /Acknowledged reminder #1/);
  assert.equal(persistence.listPendingReminders().length, 0);

  const eventsAfterAck = persistence.listReminderEvents(1);
  assert.equal(eventsAfterAck.at(-1)?.eventType, "acknowledged");

  persistence.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("recordReminderNotification updates counts and audit trail", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-reminders-"));
  const sqlitePath = path.join(tempDir, "dot.sqlite");
  const persistence = initializePersistence(tempDir, sqlitePath);
  const reminder = persistence.createReminder("take a break", "2026-04-08T00:00:00.000Z");

  persistence.recordReminderNotification(reminder.id, null, reminder.message);

  const updated = persistence.listDueReminders("2026-04-09T00:00:00.000Z");
  assert.equal(updated.length, 0);
  const events = persistence.listReminderEvents(reminder.id);
  assert.equal(events.map((event) => event.eventType).join(","), "created,notified");

  persistence.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("acknowledged reminders do not record later notification or failure events", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-reminders-"));
  const sqlitePath = path.join(tempDir, "dot.sqlite");
  const persistence = initializePersistence(tempDir, sqlitePath);
  const reminder = persistence.createReminder("call mom", "2026-04-08T00:00:00.000Z");

  assert.equal(persistence.acknowledgeReminder(reminder.id), true);
  assert.equal(persistence.recordReminderNotification(reminder.id, null, reminder.message), false);
  assert.equal(
    persistence.recordReminderDeliveryFailure(reminder.id, getReminderDeliveryRetryAt(new Date("2026-04-08T00:00:00.000Z")), "dm failed"),
    false
  );

  const events = persistence.listReminderEvents(reminder.id);
  assert.equal(events.map((event) => event.eventType).join(","), "created,acknowledged");

  persistence.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("recordReminderDeliveryFailure backs off the next retry and audits the failure", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-reminders-"));
  const sqlitePath = path.join(tempDir, "dot.sqlite");
  const persistence = initializePersistence(tempDir, sqlitePath);
  const reminder = persistence.createReminder("submit report", "2026-04-08T00:00:00.000Z");
  const retryAt = "2026-04-08T00:01:00.000Z";

  assert.equal(persistence.recordReminderDeliveryFailure(reminder.id, retryAt, "dm blocked"), true);

  const dueImmediately = persistence.listDueReminders("2026-04-08T00:00:30.000Z");
  assert.equal(dueImmediately.length, 0);
  const dueAfterRetry = persistence.listDueReminders("2026-04-08T00:01:30.000Z");
  assert.equal(dueAfterRetry.length, 1);
  const events = persistence.listReminderEvents(reminder.id);
  assert.equal(events.map((event) => event.eventType).join(","), "created,delivery_failed");

  persistence.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("getNextReminderNotificationAt respects escalation policy", () => {
  const now = new Date("2026-04-08T00:00:00.000Z");

  assert.equal(getNextReminderNotificationAt(createReminder(), "discord-only", now), null);
  assert.equal(
    getNextReminderNotificationAt(createReminder(), "nag-only", now),
    "2026-04-08T00:05:00.000Z"
  );
  assert.equal(getNextReminderNotificationAt(createReminder(), "discord-then-sms", now), null);
  assert.equal(
    getNextReminderNotificationAt(createReminder({ notificationCount: 2 }), "nag-only", now),
    null
  );
});

test("formatReminderNotification includes acknowledgement guidance", () => {
  const notification = formatReminderNotification(createReminder({ id: 3, message: "drink water" }));
  assert.match(notification, /Reminder #3/);
  assert.match(notification, /reminder ack 3/);
});

test("reminder scheduler routes notifications through the outbound bus and records delivery on success", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-reminders-"));
  const sqlitePath = path.join(tempDir, "dot.sqlite");
  const persistence = initializePersistence(tempDir, sqlitePath);
  const bus = createInMemoryEventBus();
  const published: string[] = [];

  persistence.settings.set("reminders.escalationPolicy", "nag-only");
  const reminder = persistence.createReminder("stretch", "2000-01-01T00:00:00.000Z");

  bus.subscribeOutboundMessage(async (event) => {
    published.push(event.payload.content);
    await bus.publishOutboundMessageDelivered({
      eventId: `${event.eventId}:delivered`,
      eventType: "outbound.message.delivered",
      eventVersion: "1.0.0",
      occurredAt: "2026-04-12T00:00:00.000Z",
      producer: { service: "discord-transport" },
      correlation: {
        correlationId: event.correlation.correlationId,
        causationId: event.eventId,
        conversationId: event.correlation.conversationId,
        actorId: event.correlation.actorId
      },
      routing: event.routing,
      diagnostics: {
        severity: "info",
        category: "outbound.delivery"
      },
      payload: {
        requestEventId: event.eventId,
        participantActorId: event.payload.participantActorId,
        delivery: event.payload.delivery,
        deliveryContext: event.payload.deliveryContext,
        transportMessageId: "dm-1"
      }
    });
  });

  const scheduler = startReminderScheduler({
    bus,
    logger: { info() {}, warn() {}, error() {} } as never,
    ownerUserId: "owner-1",
    pollIntervalMs: 5,
    persistence
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(published.length, 1);

    const pending = persistence.listPendingReminders();
    assert.equal(pending[0]?.notificationCount, 1);
    assert.notEqual(pending[0]?.nextNotificationAt, null);
    const events = persistence.listReminderEvents(reminder.id);
    assert.equal(events.map((event) => event.eventType).join(","), "created,notified");
  } finally {
    scheduler.stop();
    persistence.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
