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

test("listRecentNormalizedMessages preserves millisecond ordering within the same second", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.saveNormalizedMessage({
      id: "msg-older",
      channelId: "chan-1",
      guildId: "guild-1",
      authorId: "owner-1",
      authorUsername: "owner",
      content: "first",
      isDirectMessage: false,
      mentionedBot: false,
      createdAt: "2026-04-09T00:00:00.100Z"
    });
    persistence.saveNormalizedMessage({
      id: "msg-newer",
      channelId: "chan-1",
      guildId: "guild-1",
      authorId: "bot-1",
      authorUsername: "Dot",
      content: "second",
      isDirectMessage: false,
      mentionedBot: false,
      createdAt: "2026-04-09T00:00:00.900Z"
    });

    const recentMessages = persistence.listRecentNormalizedMessages("chan-1", 2);
    assert.equal(recentMessages[0]?.id, "msg-newer");
    assert.equal(recentMessages[1]?.id, "msg-older");
  } finally {
    cleanup();
  }
});

test("listRecentNormalizedMessages round-trips bot reply target metadata", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.saveNormalizedMessage({
      id: "msg-bot",
      channelId: "chan-1",
      guildId: "guild-1",
      authorId: "bot-1",
      authorUsername: "Dot",
      content: "You have a meeting today.",
      isDirectMessage: false,
      mentionedBot: false,
      replyToMessageId: "msg-owner-1",
      replyToAuthorId: "owner-1",
      createdAt: "2026-04-09T00:00:00.900Z"
    });

    const recentMessages = persistence.listRecentNormalizedMessages("chan-1", 1);
    assert.equal(recentMessages[0]?.replyToMessageId, "msg-owner-1");
    assert.equal(recentMessages[0]?.replyToAuthorId, "owner-1");
  } finally {
    cleanup();
  }
});
