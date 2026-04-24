import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createInMemoryEventBus } from "../src/eventBus.js";
import { createOutlookMailMessageDetectedEvent } from "../src/events.js";
import { classifyDeterministically, createMailTriageService, parseWhitelist, registerMailTriageConsumer } from "../src/mailTriage.js";
import { initializePersistence } from "../src/persistence.js";
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

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-mail-triage-"));
  const sqlitePath = path.join(dataDir, "dot.sqlite");
  const persistence = initializePersistence(dataDir, sqlitePath);

  return {
    persistence,
    cleanup() {
      persistence.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
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

test("mail triage consumer ensures folders and routes detected mail into the approved folder", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const moved: Array<{ messageId: string; destinationFolderId: string }> = [];

  try {
    const unsubscribe = await registerMailTriageConsumer({
      approvedFolderName: "Dot Approved",
      bus,
      logger: {
        info() {},
        warn() {},
        error() {}
      } as never,
      mailClient: {
        async ensureFolder(displayName) {
          return {
            id: displayName === "Dot Approved" ? "folder-approved" : "folder-needs-attention",
            displayName
          };
        },
        async moveMessageToFolder(messageId, destinationFolderId) {
          moved.push({ messageId, destinationFolderId });
        },
        async syncInboxDelta() {
          throw new Error("not used");
        },
        async createDraft() {
          throw new Error("not used");
        },
        async sendDraft() {
          throw new Error("not used");
        }
      },
      needsAttentionFolderName: "Needs Attention",
      persistence,
      triageService: {
        async triageMessage() {
          return {
            outcome: "dot_approved",
            source: "whitelist",
            reason: "Trusted sender whitelist match",
            route: "deterministic"
          };
        }
      }
    });

    try {
      await bus.publish(
        createOutlookMailMessageDetectedEvent({
          initialBaseline: false,
          message: {
            id: "message-1",
            subject: "Need your input",
            from: "trusted@example.com",
            receivedAt: "2026-04-11T00:00:00.000Z",
            bodyPreview: "Can you review this?",
            parentFolderId: "inbox",
            webLink: null
          }
        })
      );

      assert.deepEqual(moved, [{ messageId: "message-1", destinationFolderId: "folder-approved" }]);
      assert.equal(persistence.getMailTriageDecision("message-1")?.outcome, "dot_approved");
      assert.equal(persistence.getWorkerState("outlookMail.approvedFolderId"), "folder-approved");
      assert.equal(persistence.getWorkerState("outlookMail.needsAttentionFolderId"), "folder-needs-attention");
    } finally {
      unsubscribe();
    }
  } finally {
    cleanup();
  }
});
