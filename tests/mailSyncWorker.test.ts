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

test("mail sync worker ensures folder and persists delta cursor", async () => {
  const { persistence, cleanup } = createPersistence();
  const calls: Array<{ method: string; value: string | null }> = [];

  try {
    await syncOutlookMailOnce({
      approvedFolderName: "Dot Approved",
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
        async moveMessageToFolder() {}
      },
      persistence
    });

    assert.deepEqual(calls, [
      { method: "ensureFolder", value: "Dot Approved" },
      { method: "syncInboxDelta", value: null }
    ]);
    assert.equal(persistence.getWorkerState("outlookMail.approvedFolderId"), "folder-1");
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
    persistence.setWorkerState("outlookMail.deltaCursor", "cursor-1");

    await syncOutlookMailOnce({
      approvedFolderName: "Dot Approved",
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
        async moveMessageToFolder() {}
      },
      persistence
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
    persistence.setWorkerState("outlookMail.deltaCursor", "cursor-1");

    await syncOutlookMailOnce({
      approvedFolderName: "Dot Approved",
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
        async moveMessageToFolder() {}
      },
      persistence
    });

    assert.deepEqual(calls, ["cursor-1", null]);
    assert.equal(persistence.getWorkerState("outlookMail.deltaCursor"), "cursor-2");
  } finally {
    cleanup();
  }
});
