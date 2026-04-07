import test from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3";

import type { AppConfig } from "../src/config.js";
import { createChatService, orderProviders } from "../src/chat/modelRouter.js";
import type { ChatMessage, ChatProvider } from "../src/chat/providers.js";
import { createSettingsStore } from "../src/settings.js";

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: "test",
    DISCORD_BOT_TOKEN: "token",
    DISCORD_OWNER_USER_ID: "owner",
    DISCORD_CLIENT_ID: "",
    LOG_LEVEL: "info",
    DATA_DIR: "./data",
    SQLITE_PATH: "./data/test.sqlite",
    OLLAMA_BASE_URL: "http://ollama:11434",
    OLLAMA_MODEL: "llama3.1:8b",
    ONEMINAI_API_KEY: "",
    ONEMINAI_BASE_URL: "",
    ONEMINAI_MODEL: "",
    MODEL_REQUEST_TIMEOUT_MS: 20000,
    ...overrides
  };
}

function createStore() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const store = createSettingsStore(db);
  store.set("onboarding.completed", "true");
  return store;
}

class FakeProvider implements ChatProvider {
  constructor(
    public readonly name: string,
    private readonly available: boolean,
    private readonly responseFactory: (messages: ChatMessage[]) => Promise<string>
  ) {}

  isAvailable(): boolean {
    return this.available;
  }

  generate(messages: ChatMessage[]): Promise<string> {
    return this.responseFactory(messages);
  }
}

test("orderProviders puts the preferred provider first", () => {
  const ordered = orderProviders(
    [
      new FakeProvider("1minai", true, async () => "hosted"),
      new FakeProvider("ollama", true, async () => "local")
    ],
    "ollama"
  );

  assert.equal(ordered[0]?.name, "ollama");
});

test("chat service prefers the configured primary provider", async () => {
  const store = createStore();
  store.set("models.primary", "ollama");

  const service = createChatService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", true, async (messages) => {
        assert.equal(messages[0]?.role, "system");
        return "local reply";
      }),
      new FakeProvider("1minai", true, async () => "hosted reply")
    ]
  });

  const result = await service.generateOwnerReply("hello");
  assert.equal(result.provider, "ollama");
  assert.equal(result.reply, "local reply");
});

test("chat service falls back when the preferred provider fails", async () => {
  const store = createStore();
  store.set("models.primary", "ollama");

  const service = createChatService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", true, async () => {
        throw new Error("local unavailable");
      }),
      new FakeProvider("1minai", true, async () => "hosted reply")
    ]
  });

  const result = await service.generateOwnerReply("hello");
  assert.equal(result.provider, "1minai");
  assert.equal(result.reply, "hosted reply");
});
