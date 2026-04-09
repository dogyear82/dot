import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initializePersistence } from "../src/persistence.js";

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-persistence-"));
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

test("listRecentChatTurns returns bounded turns in chronological order", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.saveChatTurn({
      channelId: "channel-1",
      actorRole: "owner",
      content: "first",
      sourceMessageId: "msg-1",
      createdAt: "2026-04-09T00:00:00.000Z"
    });
    persistence.saveChatTurn({
      channelId: "channel-1",
      actorRole: "bot",
      content: "second",
      sourceMessageId: "msg-2",
      createdAt: "2026-04-09T00:00:01.000Z"
    });
    persistence.saveChatTurn({
      channelId: "channel-1",
      actorRole: "owner",
      content: "third",
      sourceMessageId: "msg-3",
      createdAt: "2026-04-09T00:00:02.000Z"
    });

    const turns = persistence.listRecentChatTurns("channel-1", 2);
    assert.deepEqual(
      turns.map((turn) => turn.content),
      ["second", "third"]
    );
    assert.deepEqual(
      turns.map((turn) => turn.actorRole),
      ["bot", "owner"]
    );
  } finally {
    cleanup();
  }
});

test("chat turns survive persistence restart", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-persistence-"));
  const sqlitePath = path.join(dataDir, "dot.sqlite");
  const first = initializePersistence(dataDir, sqlitePath);

  try {
    first.saveChatTurn({
      channelId: "channel-1",
      actorRole: "owner",
      content: "remember this",
      sourceMessageId: "msg-1",
      createdAt: "2026-04-09T00:00:00.000Z"
    });
  } finally {
    first.close();
  }

  const second = initializePersistence(dataDir, sqlitePath);
  try {
    const turns = second.listRecentChatTurns("channel-1", 5);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.content, "remember this");
  } finally {
    second.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
