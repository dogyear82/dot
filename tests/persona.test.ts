import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { buildSystemPrompt } from "../src/chat/persona.js";
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

test("buildSystemPrompt includes sheltered persona guidance", () => {
  const store = createStore();
  const prompt = buildSystemPrompt({
    mode: "sheltered",
    balance: "balanced",
    settings: store
  });

  assert.match(prompt, /sheltered/i);
  assert.match(prompt, /Balance companionship and practical assistance evenly/i);
  assert.match(prompt, /Active personality preset: blue_lady/i);
  assert.match(prompt, /do not hide that fact or pretend to be human/i);
});

test("buildSystemPrompt includes diagnostic persona guidance", () => {
  const store = createStore();
  const prompt = buildSystemPrompt({
    mode: "diagnostic",
    balance: "assistant",
    settings: store
  });

  assert.match(prompt, /cold, detached, technical tone/i);
  assert.match(prompt, /practical help/i);
});
