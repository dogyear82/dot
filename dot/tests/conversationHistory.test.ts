import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initializePersistence } from "../src/persistence.js";

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-conversation-"));
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

test("conversation turns are stored locally and returned in chronological order", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.saveConversationTurn({
      conversationId: "channel-1",
      role: "user",
      participantActorId: "owner-1",
      participantDisplayName: "tan",
      participantKind: "owner",
      content: "first",
      sourceMessageId: "m1",
      createdAt: "2026-04-09T10:00:00.000Z"
    });
    persistence.saveConversationTurn({
      conversationId: "channel-1",
      role: "assistant",
      participantActorId: "bot-1",
      participantDisplayName: "Dot",
      participantKind: "assistant",
      content: "second",
      sourceMessageId: "m2",
      createdAt: "2026-04-09T10:00:05.000Z"
    });
    persistence.saveConversationTurn({
      conversationId: "channel-1",
      role: "user",
      participantActorId: "owner-1",
      participantDisplayName: "tan",
      participantKind: "owner",
      content: "third",
      sourceMessageId: "m3",
      createdAt: "2026-04-09T10:00:10.000Z"
    });

    const turns = persistence.listRecentConversationTurns("channel-1", 2);
    assert.deepEqual(
      turns.map((turn) => ({
        role: turn.role,
        participantActorId: turn.participantActorId,
        participantDisplayName: turn.participantDisplayName,
        participantKind: turn.participantKind,
        content: turn.content
      })),
      [
        {
          role: "assistant",
          participantActorId: "bot-1",
          participantDisplayName: "Dot",
          participantKind: "assistant",
          content: "second"
        },
        {
          role: "user",
          participantActorId: "owner-1",
          participantDisplayName: "tan",
          participantKind: "owner",
          content: "third"
        }
      ]
    );
  } finally {
    cleanup();
  }
});

test("conversation history preserves distinct non-owner participants instead of collapsing them together", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.saveConversationTurn({
      conversationId: "channel-1",
      role: "user",
      participantActorId: "owner-1",
      participantDisplayName: "tan",
      participantKind: "owner",
      content: "What did Alice say?",
      sourceMessageId: "m1",
      createdAt: "2026-04-09T10:00:00.000Z"
    });
    persistence.saveConversationTurn({
      conversationId: "channel-1",
      role: "user",
      participantActorId: "user-alice",
      participantDisplayName: "alice",
      participantKind: "non-owner",
      content: "I can do Tuesday.",
      sourceMessageId: "m2",
      createdAt: "2026-04-09T10:00:05.000Z"
    });
    persistence.saveConversationTurn({
      conversationId: "channel-1",
      role: "user",
      participantActorId: "user-bob",
      participantDisplayName: "bob",
      participantKind: "non-owner",
      content: "Wednesday works better for me.",
      sourceMessageId: "m3",
      createdAt: "2026-04-09T10:00:10.000Z"
    });

    const turns = persistence.listRecentConversationTurns("channel-1", 10);
    assert.deepEqual(
      turns.map((turn) => ({
        participantActorId: turn.participantActorId,
        participantDisplayName: turn.participantDisplayName,
        participantKind: turn.participantKind,
        content: turn.content
      })),
      [
        {
          participantActorId: "owner-1",
          participantDisplayName: "tan",
          participantKind: "owner",
          content: "What did Alice say?"
        },
        {
          participantActorId: "user-alice",
          participantDisplayName: "alice",
          participantKind: "non-owner",
          content: "I can do Tuesday."
        },
        {
          participantActorId: "user-bob",
          participantDisplayName: "bob",
          participantKind: "non-owner",
          content: "Wednesday works better for me."
        }
      ]
    );
  } finally {
    cleanup();
  }
});
