import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Events } from "discord.js";

import { createDiscordClient } from "../src/discord/createClient.js";
import { initializePersistence } from "../src/persistence.js";

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-create-client-"));
  const sqlitePath = path.join(dataDir, "dot.sqlite");
  const persistence = initializePersistence(dataDir, sqlitePath);

  persistence.settings.set("onboarding.completed", "true");
  persistence.settings.set("channels.defaultPolicy", "mention-only");

  return {
    persistence,
    cleanup() {
      persistence.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

function createFakeMessage(params: {
  id: string;
  content: string;
  authorId?: string;
  mentionedBot?: boolean;
  isDirectMessage?: boolean;
  createdAt?: string;
  replyLog: string[];
}) {
  const {
    id,
    content,
    authorId = "owner-1",
    mentionedBot = false,
    isDirectMessage = false,
    createdAt = "2026-04-09T00:00:00.000Z",
    replyLog
  } = params;

  return {
    id,
    channelId: "chan-1",
    guildId: isDirectMessage ? null : "guild-1",
    author: {
      id: authorId,
      username: authorId === "owner-1" ? "owner" : "user",
      bot: false
    },
    content,
    createdAt: new Date(createdAt),
    mentions: {
      users: {
        has(userId: string) {
          return mentionedBot && userId === "bot-1";
        }
      }
    },
    async reply(reply: string) {
      replyLog.push(reply);
      return {
        id: `${id}-reply-${replyLog.length}`,
        createdAt: new Date(createdAt)
      };
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

test("explicit command replies are persisted so a recent follow-up can be inferred in the same channel", async () => {
  const { persistence, cleanup } = createPersistence();
  const replies: string[] = [];
  const generatedMessages: Array<{ userMessage: string; recentConversation: Array<{ role: string; content: string }> }> = [];

  try {
    const client = createDiscordClient({
      calendarClient: {
        listUpcomingEvents: async () => []
      } as never,
      chatService: {
        inferToolDecision: async () => ({
          provider: "test",
          decision: {
            decision: "none",
            reason: "not a tool request"
          }
        }),
        generateOwnerReply: async ({ userMessage, recentConversation }) => {
          generatedMessages.push({
            userMessage,
            recentConversation: (recentConversation ?? []).map((turn) => ({ role: turn.role, content: turn.content }))
          });

          return {
            provider: "test",
            reply: "freeform reply"
          };
        }
      },
      logger: createLogger() as never,
      outlookOAuthClient: {} as never,
      ownerUserId: "owner-1",
      persistence
    });

    Object.defineProperty(client, "user", {
      configurable: true,
      value: {
        id: "bot-1",
        username: "Dot"
      }
    });

    (client as unknown as { emit: (event: string, payload: unknown) => boolean }).emit(
      Events.MessageCreate,
      createFakeMessage({
        id: "msg-1",
        content: "<@bot-1> !settings",
        mentionedBot: true,
        createdAt: "2026-04-09T00:00:00.000Z",
        replyLog: replies
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const turnsAfterCommand = persistence.listRecentConversationTurns("chan-1", 10);
    assert.deepEqual(
      turnsAfterCommand.map((turn) => ({ role: turn.role, content: turn.content })),
      [
        { role: "user", content: "!settings" },
        {
          role: "assistant",
          content:
            "Settings commands:\n- `!settings show`\n- `!settings set <key> <value>`\nUser-editable keys:\n- `persona.mode`\n- `persona.balance`\n- `channels.defaultPolicy`\n- `reminders.escalationPolicy`\n- `models.primary`"
        }
      ]
    );

    (client as unknown as { emit: (event: string, payload: unknown) => boolean }).emit(
      Events.MessageCreate,
      createFakeMessage({
        id: "msg-2",
        content: "and what about tomorrow?",
        createdAt: "2026-04-09T00:02:00.000Z",
        replyLog: replies
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(generatedMessages.length, 1);
    assert.equal(generatedMessages[0]?.userMessage, "and what about tomorrow?");
    assert.deepEqual(generatedMessages[0]?.recentConversation, [
      { role: "user", content: "!settings" },
      {
        role: "assistant",
        content:
          "Settings commands:\n- `!settings show`\n- `!settings set <key> <value>`\nUser-editable keys:\n- `persona.mode`\n- `persona.balance`\n- `channels.defaultPolicy`\n- `reminders.escalationPolicy`\n- `models.primary`"
      }
    ]);

    (client as unknown as { emit: (event: string, payload: unknown) => boolean }).emit(
      Events.MessageCreate,
      createFakeMessage({
        id: "msg-3",
        authorId: "user-2",
        content: "wait, what happened?",
        createdAt: "2026-04-09T00:02:30.000Z",
        replyLog: replies
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    (client as unknown as { emit: (event: string, payload: unknown) => boolean }).emit(
      Events.MessageCreate,
      createFakeMessage({
        id: "msg-4",
        content: "and next week?",
        createdAt: "2026-04-09T00:03:00.000Z",
        replyLog: replies
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(generatedMessages.length, 1);
  } finally {
    cleanup();
  }
});
