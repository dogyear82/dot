import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { syncOutlookMailOnce } from "../src/mailSyncWorker.js";
import { OutlookMailDeltaCursorError } from "../src/outlookMail.js";
import { initializePersistence } from "../src/persistence.js";

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

function createTriageService(outcome: "dot_approved" | "needs_attention" | "ignore" = "ignore") {
  return {
    async triageMessage() {
      return {
        outcome,
        source: "heuristic" as const,
        reason: "test decision",
        route: "deterministic" as const
      };
    }
  };
}

test("mail sync worker ensures folder and persists delta cursor", async () => {
  const { persistence, cleanup } = createPersistence();
  const calls: Array<{ method: string; value: string | null }> = [];

  try {
    await syncOutlookMailOnce({
      approvedFolderName: "Dot Approved",
      initialLookbackDays: 7,
      logger: createLogger() as never,
      mailClient: {
        async ensureFolder(name) {
          calls.push({ method: "ensureFolder", value: name });
          return { id: "folder-1", displayName: name };
        },
        async syncInboxDelta(deltaCursor) {
          calls.push({ method: "syncInboxDelta", value: deltaCursor ?? null });
          return {
            messages: [],
            deltaCursor: "cursor-1"
          };
        },
        async moveMessageToFolder() {},
        async createDraft() {
          throw new Error("not used");
        },
        async sendDraft() {
          throw new Error("not used");
        }
      },
      needsAttentionFolderName: "Needs Attention",
      persistence,
      triageService: createTriageService()
    });

    assert.deepEqual(calls, [
      { method: "ensureFolder", value: "Dot Approved" },
      { method: "ensureFolder", value: "Needs Attention" },
      { method: "syncInboxDelta", value: null }
    ]);
    assert.equal(persistence.getWorkerState("outlookMail.approvedFolderId"), "folder-1");
    assert.equal(persistence.getWorkerState("outlookMail.needsAttentionFolderId"), "folder-1");
    assert.equal(persistence.getWorkerState("outlookMail.deltaCursor"), "cursor-1");
    assert.ok(persistence.getWorkerState("outlookMail.lastSyncAt"));
  } finally {
    cleanup();
  }
});

test("mail sync worker reuses stored folder state and previous delta cursor", async () => {
  const { persistence, cleanup } = createPersistence();
  const calls: Array<{ method: string; value: string | null }> = [];

  try {
    persistence.setWorkerState("outlookMail.approvedFolderId", "folder-1");
    persistence.setWorkerState("outlookMail.needsAttentionFolderId", "folder-2");
    persistence.setWorkerState("outlookMail.deltaCursor", "cursor-1");

    await syncOutlookMailOnce({
      approvedFolderName: "Dot Approved",
      initialLookbackDays: 7,
      logger: createLogger() as never,
      mailClient: {
        async ensureFolder(name) {
          calls.push({ method: "ensureFolder", value: name });
          return { id: "folder-1", displayName: name };
        },
        async syncInboxDelta(deltaCursor) {
          calls.push({ method: "syncInboxDelta", value: deltaCursor ?? null });
          return {
            messages: [],
            deltaCursor: "cursor-2"
          };
        },
        async moveMessageToFolder() {},
        async createDraft() {
          throw new Error("not used");
        },
        async sendDraft() {
          throw new Error("not used");
        }
      },
      needsAttentionFolderName: "Needs Attention",
      persistence,
      triageService: createTriageService()
    });

    assert.deepEqual(calls, [{ method: "syncInboxDelta", value: "cursor-1" }]);
    assert.equal(persistence.getWorkerState("outlookMail.deltaCursor"), "cursor-2");
  } finally {
    cleanup();
  }
});

test("mail sync worker resets an invalid delta cursor and retries from a fresh baseline", async () => {
  const { persistence, cleanup } = createPersistence();
  const calls: Array<string | null> = [];

  try {
    persistence.setWorkerState("outlookMail.approvedFolderId", "folder-1");
    persistence.setWorkerState("outlookMail.needsAttentionFolderId", "folder-2");
    persistence.setWorkerState("outlookMail.deltaCursor", "cursor-1");

    await syncOutlookMailOnce({
      approvedFolderName: "Dot Approved",
      initialLookbackDays: 7,
      logger: createLogger() as never,
      mailClient: {
        async ensureFolder(name) {
          return { id: "folder-1", displayName: name };
        },
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
        async moveMessageToFolder() {},
        async createDraft() {
          throw new Error("not used");
        },
        async sendDraft() {
          throw new Error("not used");
        }
      },
      needsAttentionFolderName: "Needs Attention",
      persistence,
      triageService: createTriageService()
    });

    assert.deepEqual(calls, ["cursor-1", null]);
    assert.equal(persistence.getWorkerState("outlookMail.deltaCursor"), "cursor-2");
  } finally {
    cleanup();
  }
});

test("mail sync worker moves whitelisted mail into the approved folder and records triage state", async () => {
  const { persistence, cleanup } = createPersistence();
  const moves: Array<{ messageId: string; destinationFolderId: string }> = [];

  try {
    await syncOutlookMailOnce({
      approvedFolderName: "Dot Approved",
      initialLookbackDays: 7,
      logger: createLogger() as never,
      mailClient: {
        async ensureFolder(name) {
          return {
            id: name === "Dot Approved" ? "folder-approved" : "folder-needs-attention",
            displayName: name
          };
        },
        async syncInboxDelta() {
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
        async moveMessageToFolder(messageId, destinationFolderId) {
          moves.push({ messageId, destinationFolderId });
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

    assert.deepEqual(moves, [{ messageId: "message-1", destinationFolderId: "folder-approved" }]);
    assert.equal(persistence.getMailTriageDecision("message-1")?.outcome, "dot_approved");
    assert.equal(persistence.getMailTriageDecision("message-1")?.destinationFolderId, "folder-approved");
  } finally {
    cleanup();
  }
});

test("mail sync worker ignores already-triaged messages to avoid repeated moves", async () => {
  const { persistence, cleanup } = createPersistence();
  let triageCalls = 0;
  let moveCalls = 0;

  try {
    persistence.saveMailTriageDecision({
      messageId: "message-1",
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

    await syncOutlookMailOnce({
      approvedFolderName: "Dot Approved",
      initialLookbackDays: 7,
      logger: createLogger() as never,
      mailClient: {
        async ensureFolder(name) {
          return {
            id: name === "Dot Approved" ? "folder-approved" : "folder-needs-attention",
            displayName: name
          };
        },
        async syncInboxDelta() {
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
        async moveMessageToFolder() {
          moveCalls += 1;
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
          triageCalls += 1;
          return {
            outcome: "dot_approved",
            source: "whitelist",
            reason: "Trusted sender whitelist match",
            route: "deterministic"
          };
        }
      }
    });

    assert.equal(triageCalls, 0);
    assert.equal(moveCalls, 0);
  } finally {
    cleanup();
  }
});

test("mail sync worker only triages messages from the configured initial lookback window on first baseline", async () => {
  const { persistence, cleanup } = createPersistence();
  const triaged: string[] = [];

  try {
    await syncOutlookMailOnce({
      approvedFolderName: "Dot Approved",
      initialLookbackDays: 7,
      logger: createLogger() as never,
      mailClient: {
        async ensureFolder(name) {
          return {
            id: name === "Dot Approved" ? "folder-approved" : "folder-needs-attention",
            displayName: name
          };
        },
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
        async moveMessageToFolder() {},
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
        async triageMessage(message) {
          triaged.push(message.id);
          return {
            outcome: "ignore",
            source: "heuristic",
            reason: "test decision",
            route: "deterministic"
          };
        }
      }
    });

    assert.deepEqual(triaged, ["message-new"]);
    assert.equal(persistence.getMailTriageDecision("message-old"), null);
    assert.equal(persistence.getMailTriageDecision("message-new")?.outcome, "ignore");
  } finally {
    cleanup();
  }
});
