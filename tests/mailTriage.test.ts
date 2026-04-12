import test from "node:test";
import assert from "node:assert/strict";

import { classifyDeterministically, createMailTriageService, parseWhitelist } from "../src/mailTriage.js";
import type { SettingsStore } from "../src/settings.js";

function createSettings(): SettingsStore {
  const values = new Map<string, string>([["llm.mode", "normal"]]);

  return {
    get(key) {
      return values.get(key) ?? null;
    },
    set(key, value) {
      values.set(key, value);
    },
    getAllUserEditable() {
      return Object.fromEntries(values);
    },
    hasCompletedOnboarding() {
      return values.get("onboarding.completed") === "true";
    },
    isConfigured(key) {
      return values.has(key);
    }
  };
}

test("parseWhitelist normalizes exact sender addresses", () => {
  const whitelist = parseWhitelist(" Trusted@Example.com,\nsecond@example.com ");
  assert.equal(whitelist.has("trusted@example.com"), true);
  assert.equal(whitelist.has("second@example.com"), true);
});

test("mail triage deterministically approves exact whitelist sender matches", () => {
  const decision = classifyDeterministically(
    {
      id: "message-1",
      subject: "Need your input",
      from: "Trusted@Example.com",
      receivedAt: "2026-04-11T00:00:00.000Z",
      bodyPreview: "Can you review this today?",
      parentFolderId: "inbox",
      webLink: null
    },
    new Set(["trusted@example.com"])
  );

  assert.equal(decision?.outcome, "dot_approved");
  assert.equal(decision?.source, "whitelist");
});

test("mail triage deterministically routes suspicious mail to needs attention", () => {
  const decision = classifyDeterministically(
    {
      id: "message-2",
      subject: "Urgent action required",
      from: "paypa1-security@example.com",
      receivedAt: "2026-04-11T00:00:00.000Z",
      bodyPreview: "Verify your account password immediately by clicking the link below.",
      parentFolderId: "inbox",
      webLink: null
    },
    new Set()
  );

  assert.equal(decision?.outcome, "needs_attention");
  assert.equal(decision?.source, "heuristic");
});

test("mail triage deterministically ignores obvious marketing mail", () => {
  const decision = classifyDeterministically(
    {
      id: "message-3",
      subject: "20% off this weekend only",
      from: "deals@example.com",
      receivedAt: "2026-04-11T00:00:00.000Z",
      bodyPreview: "Unsubscribe or manage preferences. Limited time sale, shop now.",
      parentFolderId: "inbox",
      webLink: null
    },
    new Set()
  );

  assert.equal(decision?.outcome, "ignore");
  assert.equal(decision?.source, "heuristic");
});

test("mail triage falls back to needs attention when LLM classification is unavailable", async () => {
  const service = createMailTriageService({
    config: {
      OLLAMA_BASE_URL: "http://ollama:11434",
      OLLAMA_MODEL: "model",
      MODEL_REQUEST_TIMEOUT_MS: 20000,
      ONEMINAI_BASE_URL: "",
      ONEMINAI_API_KEY: "",
      ONEMINAI_MODEL: "",
      OUTLOOK_MAIL_WHITELIST: ""
    } as never,
    settings: createSettings(),
    providers: [
      {
        name: "broken",
        route: "local",
        isAvailable() {
          return true;
        },
        async generate() {
          throw new Error("provider unavailable");
        }
      }
    ]
  });

  const decision = await service.triageMessage({
    id: "message-4",
    subject: "Question",
    from: "person@example.com",
    receivedAt: "2026-04-11T00:00:00.000Z",
    bodyPreview: "Can we chat tomorrow?",
    parentFolderId: "inbox",
    webLink: null
  });

  assert.equal(decision.outcome, "needs_attention");
  assert.equal(decision.source, "fallback");
  assert.equal(decision.route, "none");
});
