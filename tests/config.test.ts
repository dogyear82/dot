import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.js";

test("loadConfig applies defaults for optional values", () => {
  const config = loadConfig({
    DISCORD_BOT_TOKEN: "token",
    DISCORD_OWNER_USER_ID: "owner-1"
  });

  assert.equal(config.NODE_ENV, "development");
  assert.equal(config.EVENT_BUS_ADAPTER, "in-memory");
  assert.equal(config.LOG_FILE_PATH, "");
  assert.equal(config.NATS_URL, "nats://localhost:4222");
  assert.equal(config.OLLAMA_BASE_URL, "http://ollama:11434");
  assert.equal(config.OLLAMA_MODEL, "llama3.1:8b");
  assert.equal(config.OUTLOOK_TENANT_ID, "common");
  assert.equal(config.OUTLOOK_OAUTH_SCOPES, "offline_access openid profile User.Read Calendars.Read Mail.ReadWrite");
  assert.equal(config.OUTLOOK_MAIL_APPROVED_FOLDER, "Dot Approved");
  assert.equal(config.OUTLOOK_MAIL_SYNC_INTERVAL_MS, 300000);
});
