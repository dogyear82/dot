import test from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3";

import type { AppConfig } from "../src/config.js";
import {
  appendPowerIndicator,
  buildCurrentDateTimeInstruction,
  createLlmService,
  formatPowerIndicator,
  getLlmMode,
  orderProvidersForMode,
  type LlmMode
} from "../src/chat/modelRouter.js";
import type { ChatMessage, ChatProvider } from "../src/chat/providers.js";
import { createSettingsStore } from "../src/settings.js";
import type { ConversationTurnRecord } from "../src/types.js";

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: "test",
    DISCORD_BOT_TOKEN: "token",
    DISCORD_OWNER_USER_ID: "owner",
    DISCORD_CLIENT_ID: "",
    LOG_LEVEL: "info",
    LOG_FILE_PATH: "",
    OTEL_SERVICE_NAME: "dot-test",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    METRICS_HOST: "127.0.0.1",
    METRICS_PORT: 9464,
    EVENT_BUS_ADAPTER: "in-memory",
    NATS_URL: "nats://localhost:4222",
    DATA_DIR: "./data",
    SQLITE_PATH: "./data/test.sqlite",
    OLLAMA_BASE_URL: "http://ollama:11434",
    OLLAMA_MODEL: "llama3.1:8b",
    ONEMINAI_API_KEY: "",
    ONEMINAI_BASE_URL: "",
    ONEMINAI_MODEL: "",
    MODEL_REQUEST_TIMEOUT_MS: 20000,
    OUTLOOK_ACCESS_TOKEN: "",
    OUTLOOK_CLIENT_ID: "",
    OUTLOOK_TENANT_ID: "common",
    OUTLOOK_OAUTH_SCOPES: "offline_access openid profile User.Read Calendars.Read Mail.ReadWrite",
    OUTLOOK_GRAPH_BASE_URL: "https://graph.microsoft.com/v1.0",
    OUTLOOK_REQUEST_TIMEOUT_MS: 20000,
    OUTLOOK_CALENDAR_ID: "",
    OUTLOOK_LOOKAHEAD_DAYS: 7,
    OUTLOOK_MAIL_APPROVED_FOLDER: "Dot Approved",
    OUTLOOK_MAIL_NEEDS_ATTENTION_FOLDER: "Needs Attention",
    OUTLOOK_MAIL_WHITELIST: "",
    OUTLOOK_MAIL_INITIAL_LOOKBACK_DAYS: 7,
    OUTLOOK_MAIL_SYNC_INTERVAL_MS: 300000,
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
    public readonly route: "local" | "hosted",
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

test("orderProvidersForMode routes local-only in lite mode", () => {
  const ordered = orderProvidersForMode(
    [
      new FakeProvider("1minai", "hosted", true, async () => "hosted"),
      new FakeProvider("ollama", "local", true, async () => "local")
    ],
    "lite"
  );

  assert.deepEqual(ordered.map((provider) => provider.route), ["local"]);
});

test("orderProvidersForMode uses local-first routing in normal mode", () => {
  const ordered = orderProvidersForMode(
    [
      new FakeProvider("1minai", "hosted", true, async () => "hosted"),
      new FakeProvider("ollama", "local", true, async () => "local")
    ],
    "normal"
  );

  assert.deepEqual(ordered.map((provider) => provider.route), ["local", "hosted"]);
});

test("orderProvidersForMode uses hosted-first routing in power mode", () => {
  const ordered = orderProvidersForMode(
    [
      new FakeProvider("ollama", "local", true, async () => "local"),
      new FakeProvider("1minai", "hosted", true, async () => "hosted")
    ],
    "power"
  );

  assert.deepEqual(ordered.map((provider) => provider.route), ["hosted", "local"]);
});

test("llm service keeps chat local-only in lite mode", async () => {
  const store = createStore();
  store.set("llm.mode", "lite");

  const service = createLlmService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", "local", true, async (messages) => {
        assert.equal(messages[0]?.role, "system");
        assert.match(messages[0]?.content ?? "", /Current date and time: .*Z \([^)]+\)\./);
        return "local reply";
      }),
      new FakeProvider("1minai", "hosted", true, async () => "hosted reply")
    ]
  });

  const result = await service.generateOwnerReply({ userMessage: "hello" });
  assert.equal(result.route, "local");
  assert.equal(result.reply, "local reply");
  assert.equal(result.powerStatus, "off");
});

test("llm service uses hosted fallback in normal mode only after local hard failure", async () => {
  const store = createStore();
  store.set("llm.mode", "normal");

  const service = createLlmService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", "local", true, async () => {
        throw new Error("local unavailable");
      }),
      new FakeProvider("1minai", "hosted", true, async () => "hosted reply")
    ]
  });

  const result = await service.generateOwnerReply({ userMessage: "hello" });
  assert.equal(result.route, "hosted");
  assert.equal(result.reply, "hosted reply");
  assert.equal(result.powerStatus, "engaged");
});

test("llm service treats invalid inference output as a hard failure in normal mode", async () => {
  const store = createStore();
  store.set("llm.mode", "normal");

  const service = createLlmService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", "local", true, async () => "not json"),
      new FakeProvider(
        "1minai",
        "hosted",
        true,
        async () => '{"decision":"none","reason":"not enough confidence for a tool"}'
      )
    ]
  });

  const result = await service.inferToolDecision("hello there");
  assert.equal(result.route, "hosted");
  assert.equal(result.powerStatus, "engaged");
  assert.deepEqual(result.decision, { decision: "none", reason: "not enough confidence for a tool" });
});

test("llm service uses hosted as a first-class route in power mode", async () => {
  const store = createStore();
  store.set("llm.mode", "power");

  const service = createLlmService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", "local", true, async () => "local reply"),
      new FakeProvider("1minai", "hosted", true, async () => "hosted reply")
    ]
  });

  const result = await service.generateOwnerReply({ userMessage: "hello" });
  assert.equal(result.route, "hosted");
  assert.equal(result.reply, "hosted reply");
  assert.equal(result.powerStatus, "engaged");
});

test("llm service includes recent local conversation turns before the current user message", async () => {
  const store = createStore();
  const capturedMessages: ChatMessage[][] = [];
  const recentConversation: ConversationTurnRecord[] = [
    {
      id: 1,
      conversationId: "channel-1",
      role: "user",
      participantActorId: "owner-1",
      content: "earlier question",
      sourceMessageId: "m1",
      createdAt: "2026-04-09T10:00:00.000Z"
    },
    {
      id: 2,
      conversationId: "channel-1",
      role: "assistant",
      participantActorId: "owner-1",
      content: "earlier answer",
      sourceMessageId: "m2",
      createdAt: "2026-04-09T10:00:05.000Z"
    }
  ];

  const service = createLlmService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", "local", true, async (messages) => {
        capturedMessages.push(messages);
        return "local reply";
      })
    ]
  });

  await service.generateOwnerReply({
    userMessage: "current question",
    recentConversation
  });

  assert.deepEqual(capturedMessages[0]?.slice(1), [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: "current question" }
  ]);
});

test("llm service can infer a structured tool decision", async () => {
  const store = createStore();
  store.set("llm.mode", "normal");

  const service = createLlmService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider(
        "ollama",
        "local",
        true,
        async () =>
          '{"decision":"execute","toolName":"reminder.add","reason":"clear reminder intent","args":{"duration":"10m","message":"stretch"}}'
      )
    ]
  });

  const result = await service.inferToolDecision("remind me in ten minutes to stretch");
  assert.equal(result.route, "local");
  assert.equal(result.powerStatus, "standby");
  assert.equal(result.decision.decision, "execute");
  if (result.decision.decision !== "execute") {
    throw new Error("expected execute tool decision");
  }
  assert.equal(result.decision.toolName, "reminder.add");
  assert.deepEqual(result.decision.args, { duration: "10m", message: "stretch" });
});

test("llm service uses deterministic calendar inference for obvious schedule questions", async () => {
  const store = createStore();
  store.set("llm.mode", "normal");

  const service = createLlmService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", "local", true, async () => {
        throw new Error("model should not be called for deterministic calendar intent");
      })
    ]
  });

  const result = await service.inferToolDecision("what's my calendar looking like this week?");
  assert.equal(result.route, "deterministic");
  assert.equal(result.powerStatus, "standby");
  assert.deepEqual(result.decision, {
    decision: "execute",
    toolName: "calendar.show",
    reason: "clear calendar-view intent from deterministic phrase matching",
    args: {}
  });
});

test("llm service can generate a grounded reply and append source links", async () => {
  const store = createStore();
  const capturedMessages: ChatMessage[][] = [];

  const service = createLlmService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", "local", true, async (messages) => {
        capturedMessages.push(messages);
        return "According to Wikipedia, zebras breed seasonally.";
      })
    ]
  });

  const result = await service.generateGroundedReply?.({
    userMessage: "When is zebra mating season?",
    bucket: "reference",
    selectedSources: ["wikipedia"],
    failures: [],
    outcome: "success",
    evidence: [
      {
        source: "wikipedia",
        title: "Zebra",
        url: "https://en.wikipedia.org/wiki/Zebra",
        snippet: "Zebras breed seasonally.",
        publishedAt: null,
        confidence: "high"
      }
    ]
  });

  assert(result);
  assert.equal(result.route, "local");
  assert.match(result.reply, /According to Wikipedia, zebras breed seasonally\./);
  assert.match(result.reply, /Links:\n- https:\/\/en\.wikipedia\.org\/wiki\/Zebra/);
  assert.match(capturedMessages[0]?.[0]?.content ?? "", /Use the supplied external evidence when answering/);
  assert.match(capturedMessages[0]?.[1]?.content ?? "", /Selected sources: Wikipedia/);
  assert.match(capturedMessages[0]?.[1]?.content ?? "", /Article extracts:\nNo article text could be extracted/);
});

test("llm service includes article extracts for grounded current-events answers", async () => {
  const store = createStore();
  const capturedMessages: ChatMessage[][] = [];

  const service = createLlmService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", "local", true, async (messages) => {
        capturedMessages.push(messages);
        return "According to Reuters, Myanmar remains under military rule.";
      })
    ]
  });

  const result = await service.generateGroundedReply?.({
    userMessage: "What is happening in Myanmar right now?",
    bucket: "current_events",
    selectedSources: ["newsdata", "gdelt"],
    failures: [],
    outcome: "success",
    evidence: [
      {
        source: "newsdata",
        title: "Myanmar junta extends emergency rule",
        url: "https://example.test/myanmar",
        snippet: "Recent reporting from Reuters.",
        publishedAt: "2026-04-11T08:00:00Z",
        confidence: "high"
      }
    ],
    articles: [
      {
        source: "newsdata",
        title: "Myanmar junta extends emergency rule",
        url: "https://example.test/myanmar",
        publisher: "Reuters",
        publishedAt: "2026-04-11T08:00:00Z",
        excerpt: "Myanmar's military government extended emergency rule while opposition groups reported continued fighting in several regions."
      }
    ]
  });

  assert(result);
  assert.match(result.reply, /According to Reuters/);
  assert.match(capturedMessages[0]?.[0]?.content ?? "", /Make it clear this information was looked up/);
  assert.match(capturedMessages[0]?.[1]?.content ?? "", /Article extracts:/);
  assert.match(capturedMessages[0]?.[1]?.content ?? "", /publisher=Reuters/);
});

test("llm service can generate a news briefing in the active voice", async () => {
  const store = createStore();
  const capturedMessages: ChatMessage[][] = [];

  const service = createLlmService({
    config: createConfig(),
    settings: store,
    providers: [
      new FakeProvider("ollama", "local", true, async (messages) => {
        capturedMessages.push(messages);
        return "Well, deary, here are the main headlines.\n1. According to Reuters, Myanmar's junta extended emergency rule.";
      })
    ]
  });

  const result = await service.generateNewsBriefingReply?.({
    userMessage: "give me the latest headlines",
    selectedSources: ["newsdata", "gdelt"],
    failures: [],
    outcome: "success",
    evidence: [
      {
        source: "newsdata",
        title: "Myanmar junta extends emergency rule",
        url: "https://example.test/myanmar",
        snippet: "Reuters reports the military government extended emergency rule.",
        publishedAt: "2026-04-11T08:00:00Z",
        publisher: "Reuters",
        rankingSignals: ["interested:myanmar"],
        confidence: "high"
      }
    ]
  });

  assert(result);
  assert.match(result.reply, /main headlines/i);
  assert.match(result.reply, /Links:\n- https:\/\/example\.test\/myanmar/);
  assert.match(capturedMessages[0]?.[0]?.content ?? "", /preparing a concise news briefing/i);
  assert.match(capturedMessages[0]?.[1]?.content ?? "", /Briefing evidence:/);
  assert.match(capturedMessages[0]?.[1]?.content ?? "", /rankingSignals=interested:myanmar/);
});

test("getLlmMode defaults to normal when unset", () => {
  const store = createStore();
  assert.equal(getLlmMode(store), "normal");
});

test("power indicator formatting is stable", () => {
  assert.equal(formatPowerIndicator("engaged"), "[mode: power]");
  assert.equal(appendPowerIndicator("hello", "standby"), "hello\n\n[mode: normal]");
  assert.equal(appendPowerIndicator("hello\n\n[mode: normal]", "standby"), "hello\n\n[mode: normal]");
});

test("current date time instruction includes an ISO timestamp and timezone", () => {
  const instruction = buildCurrentDateTimeInstruction(new Date("2026-04-10T18:42:00.000Z"));
  assert.match(instruction, /^Current date and time: 2026-04-10T18:42:00.000Z \([^)]+\)\. Use this as the authoritative current time reference unless newer explicit context is provided\.$/);
});

test("llm service reports standby power for non-hosted paths outside lite mode", () => {
  const store = createStore();
  store.set("llm.mode", "power");
  const service = createLlmService({
    config: createConfig(),
    settings: store,
    providers: []
  });

  assert.equal(service.getPowerStatus("none"), "standby");
  assert.equal(service.getPowerStatus("local"), "standby");
  assert.equal(service.getPowerStatus("hosted"), "engaged");
});
