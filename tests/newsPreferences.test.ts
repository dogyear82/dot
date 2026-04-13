import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { handleNewsPreferencesCommand, getNewsPreferences } from "../src/newsPreferences.js";
import { createSettingsStore } from "../src/settings.js";

function createPersistenceLike() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return {
    settings: createSettingsStore(db)
  };
}

test("news preference commands show defaults and persist add/remove operations", () => {
  const persistence = createPersistenceLike();

  const showReply = handleNewsPreferencesCommand(persistence as never, "!news prefs show");
  assert.match(showReply, /interestedTopics: \(none\)/);

  const addTopicReply = handleNewsPreferencesCommand(persistence as never, "!news prefs add interested myanmar");
  assert.match(addTopicReply, /Saved `myanmar`/);
  assert.deepEqual(getNewsPreferences(persistence.settings).interestedTopics, ["myanmar"]);

  handleNewsPreferencesCommand(persistence as never, "!news prefs add preferred reuters");
  handleNewsPreferencesCommand(persistence as never, "!news prefs add blocked fox");
  handleNewsPreferencesCommand(persistence as never, "!news prefs add uninterested celebrity gossip");

  const preferences = getNewsPreferences(persistence.settings);
  assert.deepEqual(preferences.preferredOutlets, ["reuters"]);
  assert.deepEqual(preferences.blockedOutlets, ["fox"]);
  assert.deepEqual(preferences.uninterestedTopics, ["celebrity gossip"]);

  const removeReply = handleNewsPreferencesCommand(persistence as never, "!news prefs remove blocked fox");
  assert.match(removeReply, /Removed `fox`/);
  assert.deepEqual(getNewsPreferences(persistence.settings).blockedOutlets, []);
});
