import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Events } from "discord.js";

import { createInMemoryEventBus } from "../src/eventBus.js";
import { createDiscordClient } from "../src/discord/createClient.js";
import { registerMessagePipeline } from "../src/messagePipeline.js";
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
  roleMentionName?: string | null;
  isDirectMessage?: boolean;
  createdAt?: string;
  replyLog: string[];
}) {
  const {
    id,
    content,
    authorId = "owner-1",
    mentionedBot = false,
    roleMentionName = null,
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
      },
      roles: {
        some(predicate: (role: { name: string }) => boolean) {
          return roleMentionName ? predicate({ name: roleMentionName }) : false;
        }
      }
    },
    async reply(reply: string) {
      replyLog.push(reply);
      return {
        id: `${id}-reply-${replyLog.length}`,
        channelId: "chan-1",
        guildId: isDirectMessage ? null : "guild-1",
        author: {
          id: "bot-1",
          username: "Dot",
          bot: true
        },
        content: reply,
        createdAt: new Date(createdAt),
        mentions: {
          users: {
            has() {
              return false;
            }
          },
          roles: {
            some() {
              return false;
            }
          }
        }
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

test("Discord ingress publishes through the bus and preserves command-seeded follow-up context", async () => {
  const { persistence, cleanup } = createPersistence();
  const replies: string[] = [];
  const generatedMessages: Array<{ userMessage: string; recentConversation: Array<{ role: string; content: string }> }> = [];
  const bus = createInMemoryEventBus();

  try {
    const unsubscribe = registerMessagePipeline({
      bus,
      calendarClient: {
        listUpcomingEvents: async () => []
      } as never,
      chatService: {
        inferToolDecision: async () => ({
          route: "local",
          powerStatus: "standby",
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
            route: "local",
            powerStatus: "standby",
            reply: "freeform reply"
          };
        },
        getPowerStatus: () => "standby"
      },
      logger: createLogger() as never,
      outlookOAuthClient: {} as never,
      ownerUserId: "owner-1",
      persistence
    });

    const client = createDiscordClient({
      bus,
      logger: createLogger() as never,
      ownerUserId: "owner-1",
      persistence
    });

    try {
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
        turnsAfterCommand.map((turn) => ({ role: turn.role, participantActorId: turn.participantActorId, content: turn.content })),
        [
          { role: "user", participantActorId: "owner-1", content: "!settings" },
          {
            role: "assistant",
            participantActorId: "owner-1",
            content:
              "Settings commands:\n- `!settings show`\n- `!settings set <key> <value>`\nUser-editable keys:\n- `persona.mode`\n- `persona.balance`\n- `channels.defaultPolicy`\n- `reminders.escalationPolicy`\n- `llm.mode`\n\n[mode: normal]"
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
              "Settings commands:\n- `!settings show`\n- `!settings set <key> <value>`\nUser-editable keys:\n- `persona.mode`\n- `persona.balance`\n- `channels.defaultPolicy`\n- `reminders.escalationPolicy`\n- `llm.mode`\n\n[mode: normal]"
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
      unsubscribe();
      await client.destroy();
    }
  } finally {
    cleanup();
  }
});

test("Discord ingress normalizes a plain-text @Dot command before pipeline routing", async () => {
  const { persistence, cleanup } = createPersistence();
  const replies: string[] = [];
  const bus = createInMemoryEventBus();

  try {
    const unsubscribe = registerMessagePipeline({
      bus,
      calendarClient: {
        listUpcomingEvents: async () => []
      } as never,
      chatService: {
        inferToolDecision: async () => ({
          route: "local",
          powerStatus: "standby",
          decision: {
            decision: "none",
            reason: "not a tool request"
          }
        }),
        generateOwnerReply: async () => ({
          route: "local",
          powerStatus: "standby",
          reply: "freeform reply"
        }),
        getPowerStatus: () => "standby"
      },
      logger: createLogger() as never,
      outlookOAuthClient: {} as never,
      ownerUserId: "owner-1",
      persistence
    });

    const client = createDiscordClient({
      bus,
      logger: createLogger() as never,
      ownerUserId: "owner-1",
      persistence
    });

    try {
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
          id: "msg-plain-at-command",
          content: "@Dot !settings show",
          mentionedBot: false,
          createdAt: "2026-04-09T00:00:00.000Z",
          replyLog: replies
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(replies.length, 1);
      assert.match(replies[0] ?? "", /Current settings:/);

      const turns = persistence.listRecentConversationTurns("chan-1", 10);
      assert.equal(turns[0]?.role, "user");
      assert.equal(turns[0]?.content, "!settings show");
      assert.equal(turns[1]?.role, "assistant");
      assert.match(turns[1]?.content ?? "", /Current settings:/);
    } finally {
      unsubscribe();
      await client.destroy();
    }
  } finally {
    cleanup();
  }
});

test("Discord ingress normalizes a role mention command before pipeline routing", async () => {
  const { persistence, cleanup } = createPersistence();
  const replies: string[] = [];
  const bus = createInMemoryEventBus();

  try {
    const unsubscribe = registerMessagePipeline({
      bus,
      calendarClient: {
        listUpcomingEvents: async () => []
      } as never,
      chatService: {
        inferToolDecision: async () => ({
          route: "local",
          powerStatus: "standby",
          decision: {
            decision: "none",
            reason: "not a tool request"
          }
        }),
        generateOwnerReply: async () => ({
          route: "local",
          powerStatus: "standby",
          reply: "freeform reply"
        }),
        getPowerStatus: () => "standby"
      },
      logger: createLogger() as never,
      outlookOAuthClient: {} as never,
      ownerUserId: "owner-1",
      persistence
    });

    const client = createDiscordClient({
      bus,
      logger: createLogger() as never,
      ownerUserId: "owner-1",
      persistence
    });

    try {
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
          id: "msg-role-command",
          content: "<@&1492214618611908830> !settings show",
          mentionedBot: false,
          roleMentionName: "Dot",
          createdAt: "2026-04-09T00:00:00.000Z",
          replyLog: replies
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(replies.length, 1);
      assert.match(replies[0] ?? "", /Current settings:/);

      const turns = persistence.listRecentConversationTurns("chan-1", 10);
      assert.equal(turns[0]?.content, "!settings show");
    } finally {
      unsubscribe();
      await client.destroy();
    }
  } finally {
    cleanup();
  }
});

test("Discord ingress treats a same-name role mention as addressed chat", async () => {
  const { persistence, cleanup } = createPersistence();
  const replies: string[] = [];
  const generatedMessages: string[] = [];
  const bus = createInMemoryEventBus();

  try {
    const unsubscribe = registerMessagePipeline({
      bus,
      calendarClient: {
        listUpcomingEvents: async () => []
      } as never,
      chatService: {
        inferToolDecision: async () => ({
          route: "local",
          powerStatus: "standby",
          decision: {
            decision: "none",
            reason: "not a tool request"
          }
        }),
        generateOwnerReply: async ({ userMessage }) => {
          generatedMessages.push(userMessage);
          return {
            route: "local",
            powerStatus: "standby",
            reply: "role mention chat reply"
          };
        },
        getPowerStatus: () => "standby"
      },
      logger: createLogger() as never,
      outlookOAuthClient: {} as never,
      ownerUserId: "owner-1",
      persistence
    });

    const client = createDiscordClient({
      bus,
      logger: createLogger() as never,
      ownerUserId: "owner-1",
      persistence
    });

    try {
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
          id: "msg-role-chat",
          content: "<@&1492214618611908830> what do you think?",
          mentionedBot: false,
          roleMentionName: "Dot",
          createdAt: "2026-04-09T00:00:00.000Z",
          replyLog: replies
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(generatedMessages[0], "what do you think?");
      assert.match(replies[0] ?? "", /role mention chat reply/);
    } finally {
      unsubscribe();
      await client.destroy();
    }
  } finally {
    cleanup();
  }
});
