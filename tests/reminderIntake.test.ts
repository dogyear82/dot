import test from "node:test";
import assert from "node:assert/strict";

import { continueReminderIntake, startReminderIntake, type ReminderIntakeState } from "../src/reminderIntake.js";

const NOW = new Date("2026-04-14T08:00:00.000Z");

test("reminder intake starts in schedule mode selection when message is known but schedule is missing", () => {
  const outcome = startReminderIntake({
    args: {
      message: "buy tomatoes and eggs"
    },
    now: NOW
  });

  assert.equal(outcome.kind, "clarify");
  assert.match(outcome.prompt, /specific time or a duration from now/i);
  assert.equal(outcome.state.step, "choose_schedule_mode");
  assert.equal(outcome.state.data.message, "buy tomatoes and eggs");
});

test("reminder intake skips schedule intake when message and dueAt are already provided", () => {
  const outcome = startReminderIntake({
    args: {
      message: "walk the dog",
      dueAt: "2026-04-15T16:00:00.000Z"
    },
    now: NOW
  });

  assert.equal(outcome.kind, "requires_confirmation");
  assert.equal(outcome.state.step, "confirm");
  assert.equal(outcome.state.data.message, "walk the dog");
  assert.equal(outcome.state.data.dueAt, "2026-04-15T16:00:00.000Z");
  assert.match(outcome.prompt, /walk the dog/i);
  assert.match(outcome.prompt, /want me to save it\?/i);
});

test("reminder intake asks for a specific date when provided dueAt resolves to the past", () => {
  const outcome = startReminderIntake({
    args: {
      message: "walk the dog",
      dueAt: "2026-04-14T07:00:00.000Z"
    },
    now: NOW
  });

  assert.equal(outcome.kind, "clarify");
  assert.equal(outcome.state.step, "collect_specific_date");
  assert.equal(outcome.state.data.message, "walk the dog");
  assert.equal(outcome.state.data.scheduleMode, "specific");
  assert.match(outcome.prompt, /What day should I use\?/i);
});

test("reminder intake duration path collects duration and returns confirmation", () => {
  const start = startReminderIntake({
    args: {
      message: "stretch"
    },
    now: NOW
  });
  assert.equal(start.kind, "clarify");

  const chooseDuration = continueReminderIntake({
    state: start.state,
    userMessage: "duration",
    now: NOW
  });
  assert.equal(chooseDuration.kind, "clarify");
  assert.equal(chooseDuration.state.step, "collect_duration");

  const durationResult = continueReminderIntake({
    state: chooseDuration.state,
    userMessage: "14 hours",
    now: NOW
  });
  assert.equal(durationResult.kind, "requires_confirmation");
  assert.equal(durationResult.state.step, "confirm");
  assert.equal(durationResult.state.data.duration, "14h");
  assert.match(durationResult.prompt, /stretch in 14 hours/i);
});

test("reminder intake specific-time path collects date and time then returns dueAt confirmation", () => {
  const start = startReminderIntake({
    args: {
      message: "pick my nose"
    },
    now: NOW
  });
  assert.equal(start.kind, "clarify");

  const chooseSpecific = continueReminderIntake({
    state: start.state,
    userMessage: "specific",
    now: NOW
  });
  assert.equal(chooseSpecific.kind, "clarify");
  assert.equal(chooseSpecific.state.step, "collect_specific_date");

  const dateResult = continueReminderIntake({
    state: chooseSpecific.state,
    userMessage: "tomorrow",
    now: NOW
  });
  assert.equal(dateResult.kind, "clarify");
  assert.equal(dateResult.state.step, "collect_specific_time");

  const timeResult = continueReminderIntake({
    state: dateResult.state,
    userMessage: "9am",
    now: NOW
  });
  assert.equal(timeResult.kind, "requires_confirmation");
  assert.equal(timeResult.state.step, "confirm");
  assert.equal(timeResult.state.data.dueAt, "2026-04-15T16:00:00.000Z");
  assert.match(timeResult.prompt, /wednesday, april 15 at 9:00 am/i);
});

test("reminder intake confirmation returns executable args", () => {
  const state: ReminderIntakeState = {
    engine: "reminder.add.intake",
    step: "confirm",
    data: {
      message: "stretch",
      scheduleMode: "duration",
      duration: "10m"
    }
  };

  const result = continueReminderIntake({
    state,
    userMessage: "yes",
    now: NOW
  });

  assert.equal(result.kind, "execute");
  assert.deepEqual(result.args, {
    message: "stretch",
    duration: "10m",
    confirmed: "yes"
  });
});
