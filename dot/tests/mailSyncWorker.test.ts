import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createInMemoryEventBus } from "../src/eventBus.js";
import { syncOutlookMailOnce } from "../src/mailSyncWorker.js";
import { OutlookMailDeltaCursorError } from "../src/outlookMail.js";
import { initializePersistence } from "../src/persistence.js";
import type { OutlookMailMessageDetectedEvent } from "../src/events.js";

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-mail-sync-"));
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

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}

test("mail sync worker persists delta cursor and publishes detected-mail events", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const detectedEvents: OutlookMailMessageDetectedEvent[] = [];

  try {
    bus.subscribe("outlook.mail.message.detected", async (event) => {
      detectedEvents.push(event as OutlookMailMessageDetectedEvent);
    });

    await syncOutlookMailOnce({
      bus,
      initialLookbackDays: 7,
      logger: createLogger() as never,
      mailClient: {
        async syncInboxDelta(deltaCursor) {
          assert.equal(deltaCursor, null);
          return {
            messages: [
              {
                id: "message-1",
                subject: "Need your input",
                from: "trusted@example.com",
                receivedAt: "2026-04-11T00:00:00.000Z",
                bodyPreview: "Can you review this?",
                parentFolderId: "inbox",
                webLink: null
              }
            ],
            deltaCursor: "cursor-1"
          };
        },
        async ensureFolder() {
          throw new Error("not used");
        },
        async moveMessageToFolder() {
          throw new Error("not used");
        },
        async createDraft() {
          throw new Error("not used");
        },
        async sendDraft() {
          throw new Error("not used");
        }
      },
      persistence
    });

    assert.equal(persistence.getWorkerState("outlookMail.deltaCursor"), "cursor-1");
    assert.ok(persistence.getWorkerState("outlookMail.lastSyncAt"));
    assert.equal(detectedEvents.length, 1);
    assert.equal(detectedEvents[0]?.payload.message.id, "message-1");
    assert.equal(detectedEvents[0]?.payload.initialBaseline, true);
  } finally {
    cleanup();
  }
});

test("mail sync worker reuses previous delta cursor and resets invalid cursors", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const calls: Array<string | null> = [];

  try {
    persistence.setWorkerState("outlookMail.deltaCursor", "cursor-1");

    await syncOutlookMailOnce({
      bus,
      initialLookbackDays: 7,
      logger: createLogger() as never,
      mailClient: {
        async syncInboxDelta(deltaCursor) {
          calls.push(deltaCursor ?? null);
          if (deltaCursor) {
            throw new OutlookMailDeltaCursorError("expired");
          }

          return {
            messages: [],
            deltaCursor: "cursor-2"
          };
        },
        async ensureFolder() {
          throw new Error("not used");
        },
        async moveMessageToFolder() {
          throw new Error("not used");
        },
        async createDraft() {
          throw new Error("not used");
        },
        async sendDraft() {
          throw new Error("not used");
        }
      },
      persistence
    });

    assert.deepEqual(calls, ["cursor-1", null]);
    assert.equal(persistence.getWorkerState("outlookMail.deltaCursor"), "cursor-2");
  } finally {
    cleanup();
  }
});

test("mail sync worker skips already-triaged messages and applies the initial lookback window", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const detectedIds: string[] = [];

  try {
    persistence.saveMailTriageDecision({
      messageId: "message-existing",
      senderEmail: "trusted@example.com",
      outcome: "dot_approved",
      source: "whitelist",
      reason: "Trusted sender whitelist match",
      route: "deterministic",
      sourceFolderId: "inbox",
      destinationFolderId: "folder-approved",
      triagedAt: "2026-04-11T00:00:00.000Z",
      movedAt: "2026-04-11T00:00:01.000Z"
    });

    bus.subscribe("outlook.mail.message.detected", async (event) => {
      detectedIds.push((event as OutlookMailMessageDetectedEvent).payload.message.id);
    });

    await syncOutlookMailOnce({
      bus,
      initialLookbackDays: 7,
      logger: createLogger() as never,
      mailClient: {
        async syncInboxDelta() {
          return {
            messages: [
              {
                id: "message-old",
                subject: "Old mail",
                from: "person@example.com",
                receivedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
                bodyPreview: "Old backlog item",
                parentFolderId: "inbox",
                webLink: null
              },
              {
                id: "message-existing",
                subject: "Already triaged",
                from: "trusted@example.com",
                receivedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
                bodyPreview: "Existing decision",
                parentFolderId: "inbox",
                webLink: null
              },
              {
                id: "message-new",
                subject: "Recent mail",
                from: "person@example.com",
                receivedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
                bodyPreview: "Recent backlog item",
                parentFolderId: "inbox",
                webLink: null
              }
            ],
            deltaCursor: "cursor-1"
          };
        },
        async ensureFolder() {
          throw new Error("not used");
        },
        async moveMessageToFolder() {
          throw new Error("not used");
        },
        async createDraft() {
          throw new Error("not used");
        },
        async sendDraft() {
          throw new Error("not used");
        }
      },
      persistence
    });

    assert.deepEqual(detectedIds, ["message-new"]);
  } finally {
    cleanup();
  }
});
