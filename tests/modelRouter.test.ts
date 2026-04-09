import test from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3";

import type { AppConfig } from "../src/config.js";
import { createChatService, orderProviders } from "../src/chat/modelRouter.js";
import type { ChatMessage, ChatProvider } from "../src/chat/providers.js";
import { createSettingsStore } from "../src/settings.js";
import type { ChatTurn } from "../src/types.js";

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
    OUTLOOK_ACCESS_TOKEN: "",
    OUTLOOK_GRAPH_BASE_URL: "https://graph.microsoft.com/v1.0",
    OUTLOOK_CALENDAR_ID: "",
    OUTLOOK_LOOKAHEAD_DAYS: 7,
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

test("chat service includes bounded recent conversation turns before the current owner message", async () => {
  const store = createStore();
  store.set("models.primary", "ollama");

  const recentTurns: ChatTurn[] = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    channelId: "channel-1",
    actorRole: index % 2 === 0 ? "owner" : "bot",
    content: `turn-${index + 1}`,
    sourceMessageId: `msg-${index + 1}`,
    createdAt: `2026-04-09T00:00:${String(index).padStart(2, "0")}.000Z`
  }));

  const service = createChatService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", true, async (messages) => {
        assert.equal(messages[0]?.role, "system");
        assert.equal(messages.length, 10);
        assert.deepEqual(
          messages.slice(1, -1).map((message) => message.content),
          ["turn-3", "turn-4", "turn-5", "turn-6", "turn-7", "turn-8", "turn-9", "turn-10"]
        );
        assert.equal(messages.at(-1)?.role, "user");
        assert.equal(messages.at(-1)?.content, "current turn");
        return "reply with context";
      })
    ]
  });

  const result = await service.generateOwnerReply("current turn", recentTurns);
  assert.equal(result.reply, "reply with context");
});

test("chat service can infer a structured tool decision", async () => {
  const store = createStore();
  store.set("models.primary", "ollama");

  const service = createChatService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider(
        "ollama",
        true,
        async () =>
          '{"decision":"execute","toolName":"reminder.add","reason":"clear reminder intent","args":{"duration":"10m","message":"stretch"}}'
      )
    ]
  });

  const result = await service.inferToolDecision("remind me in ten minutes to stretch");
  assert.equal(result.provider, "ollama");
  assert.equal(result.decision.decision, "execute");
  if (result.decision.decision !== "execute") {
    throw new Error("expected execute tool decision");
  }
  assert.equal(result.decision.toolName, "reminder.add");
  assert.deepEqual(result.decision.args, { duration: "10m", message: "stretch" });
});

test("chat service falls back to the next provider for invalid inference output", async () => {
  const store = createStore();
  store.set("models.primary", "ollama");

  const service = createChatService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", true, async () => "not json"),
      new FakeProvider(
        "1minai",
        true,
        async () => '{"decision":"none","reason":"not enough confidence for a tool"}'
      )
    ]
  });

  const result = await service.inferToolDecision("hello there");
  assert.equal(result.provider, "1minai");
  assert.deepEqual(result.decision, { decision: "none", reason: "not enough confidence for a tool" });
});

test("chat service uses deterministic calendar inference for obvious schedule questions", async () => {
  const store = createStore();
  store.set("models.primary", "ollama");

  const service = createChatService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", true, async () => {
        throw new Error("model should not be called for deterministic calendar intent");
      })
    ]
  });

  const result = await service.inferToolDecision("what's my calendar looking like this week?");
  assert.equal(result.provider, "deterministic");
  assert.deepEqual(result.decision, {
    decision: "execute",
    toolName: "calendar.show",
    reason: "clear calendar-view intent from deterministic phrase matching",
    args: {}
  });
});
