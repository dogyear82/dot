import test from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3";

import { handleOnboardingReply, handleSettingsCommand } from "../src/onboarding.js";
import { createSettingsStore } from "../src/settings.js";

function createStore() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return createSettingsStore(db);
}

test("settings store applies defaults and persists updates", () => {
  const store = createStore();

  assert.equal(store.get("persona.mode"), "sheltered");
  store.set("persona.mode", "diagnostic");
  assert.equal(store.get("persona.mode"), "diagnostic");
});

test("onboarding collects settings and marks completion", () => {
  const store = createStore();

  let result = handleOnboardingReply(store, "diagnostic");
  assert.equal(result.onboardingComplete, false);
  assert.match(result.reply, /Assistant balance/);

  result = handleOnboardingReply(store, "assistant");
  result = handleOnboardingReply(store, "mention-only");
  result = handleOnboardingReply(store, "discord-only");
  result = handleOnboardingReply(store, "ollama");

  assert.equal(result.onboardingComplete, true);
  assert.equal(store.hasCompletedOnboarding(), true);
});

test("settings commands can show and update persisted settings", () => {
  const store = createStore();
  store.set("onboarding.completed", "true");

  const showReply = handleSettingsCommand(store, "settings show");
  assert.match(showReply, /persona.mode/);

  const setReply = handleSettingsCommand(store, "settings set channels.defaultPolicy whitelist");
  assert.match(setReply, /channels.defaultPolicy/);
  assert.equal(store.get("channels.defaultPolicy"), "whitelist");
});

test("settings command returns a validation error instead of throwing", () => {
  const store = createStore();
  store.set("onboarding.completed", "true");

  const reply = handleSettingsCommand(store, "settings set persona.mode invalid");
  assert.match(reply, /Invalid value/);
});
