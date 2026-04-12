import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Events } from "discord.js";

import { createInMemoryEventBus } from "../src/eventBus.js";
import { createDiscordClient } from "../src/discord/createClient.js";
import { registerDiscordEgressConsumer } from "../src/discord/egress.js";
import { createOutboundMessageRequestedEvent, createSystemOutboundMessageRequestedEvent } from "../src/events.js";
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
  mentionedRoleIds?: string[];
  botRoleIds?: string[];
  isDirectMessage?: boolean;
  createdAt?: string;
  replyLog: string[];
  channelSendLog?: string[];
}) {
  const {
    id,
    content,
    authorId = "owner-1",
    mentionedBot = false,
    mentionedRoleIds = [],
    botRoleIds = [],
    isDirectMessage = false,
    createdAt = "2026-04-09T00:00:00.000Z",
    replyLog,
    channelSendLog = replyLog
  } = params;

  return {
    id,
    channelId: "chan-1",
    guildId: isDirectMessage ? null : "guild-1",
    guild: isDirectMessage
      ? null
      : {
          members: {
            me: {
              roles: {
                cache: {
                  map<T>(callback: (role: { id: string }) => T) {
                    return botRoleIds.map((roleId) => callback({ id: roleId }));
                  }
                }
              }
            }
          }
        },
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
        some(predicate: (role: { id: string }) => boolean) {
          return mentionedRoleIds.some((roleId) => predicate({ id: roleId }));
        }
      }
    },
    async reply(reply: string) {
      replyLog.push(reply);
      return {
        id: `${id}-reply-${replyLog.length}`,
        channelId: "chan-1",
        guildId: isDirectMessage ? null : "guild-1",
        guild: isDirectMessage
          ? null
          : {
              members: {
                me: {
                  roles: {
                    cache: {
                      map<T>(callback: (role: { id: string }) => T) {
                        return botRoleIds.map((roleId) => callback({ id: roleId }));
                      }
                    }
                  }
                }
              }
            },
        author: {
          id: "bot-1",
          username: "Dot",
          bot: true
        },
        content: reply,
        createdAt: new Date(createdAt),
        channel: {
          async send(content: string) {
            channelSendLog.push(content);
            return {
              id: `${id}-follow-up-${channelSendLog.length}`,
              channelId: "chan-1",
              guildId: isDirectMessage ? null : "guild-1",
              guild: isDirectMessage
                ? null
                : {
                    members: {
                      me: {
                        roles: {
                          cache: {
                            map<T>(callback: (role: { id: string }) => T) {
                              return botRoleIds.map((roleId) => callback({ id: roleId }));
                            }
                          }
                        }
                      }
                    }
                  },
              author: {
                id: "bot-1",
                username: "Dot",
                bot: true
              },
              content,
              createdAt: new Date(createdAt),
              mentions: {
                users: { has() { return false; } },
                roles: { some() { return false; } }
              }
            };
          }
        },
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

function createSentBotMessage(params: {
  id: string;
  content: string;
  botRoleIds?: string[];
  channelSendLog: string[];
  isDirectMessage?: boolean;
  createdAt?: string;
}) {
  const {
    id,
    content,
    botRoleIds = [],
    channelSendLog,
    isDirectMessage = false,
    createdAt = "2026-04-09T00:00:00.000Z"
  } = params;

  return {
    id,
    channelId: isDirectMessage ? "dm-chan-1" : "chan-1",
    guildId: isDirectMessage ? null : "guild-1",
    guild: isDirectMessage
      ? null
      : {
          members: {
            me: {
              roles: {
                cache: {
                  map<T>(callback: (role: { id: string }) => T) {
                    return botRoleIds.map((roleId) => callback({ id: roleId }));
                  }
                }
              }
            }
          }
        },
    author: {
      id: "bot-1",
      username: "Dot",
      bot: true
    },
    content,
    createdAt: new Date(createdAt),
    channel: {
      isSendable() {
        return true;
      },
      async send(nextContent: string) {
        channelSendLog.push(nextContent);
        return createSentBotMessage({
          id: `${id}-follow-up-${channelSendLog.length}`,
          content: nextContent,
          botRoleIds,
          channelSendLog,
          isDirectMessage,
          createdAt
        });
      }
    },
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

function createDiscordEgressTestClient(params: {
  sentChunks: string[];
  expectedReplyTo?: string;
}) {
  const { sentChunks, expectedReplyTo } = params;

  return {
    user: {
      id: "bot-1",
      username: "Dot"
    },
    channels: {
      async fetch(channelId: string) {
        assert.equal(channelId, "chan-1");
        return {
          isSendable() {
            return true;
          },
          async send(payload: string | { content: string; reply?: { messageReference: string; failIfNotExists?: boolean } }) {
            if (typeof payload === "string") {
              sentChunks.push(payload);
              return createSentBotMessage({
                  id: `chan-${sentChunks.length}`,
                content: payload,
                channelSendLog: sentChunks
              });
            }

            if (expectedReplyTo != null) {
              assert.equal(payload.reply?.messageReference, expectedReplyTo);
            }
            assert.equal(payload.reply?.failIfNotExists, true);
            sentChunks.push(payload.content);
            return createSentBotMessage({
              id: `chan-${sentChunks.length}`,
              content: payload.content,
              channelSendLog: sentChunks
            });
          }
        };
      }
    },
    users: {
      async fetch(userId: string) {
        assert.equal(userId, "owner-1");
        return {
          async send(content: string) {
            sentChunks.push(content);
            return createSentBotMessage({
              id: `dm-${sentChunks.length}`,
              content,
              channelSendLog: sentChunks,
              isDirectMessage: true
            });
          }
        };
      }
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
    const unregisterEgress = registerDiscordEgressConsumer({
      bus,
      client: createDiscordEgressTestClient({
        sentChunks: replies
      }) as never,
      logger: createLogger() as never,
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
      unregisterEgress();
      unsubscribe();
      await client.destroy();
    }
  } finally {
    cleanup();
  }
});

test("Discord outbound delivery chunks oversized replies and stores one assistant conversation turn", async () => {
  const { persistence, cleanup } = createPersistence();
  const sentChunks: string[] = [];
  const bus = createInMemoryEventBus();
  const unregisterConsumer = registerDiscordEgressConsumer({
    bus,
    client: createDiscordEgressTestClient({
      sentChunks,
      expectedReplyTo: "msg-long"
    }) as never,
    logger: createLogger() as never,
    persistence
  });

  try {
    const inboundEvent = {
      eventId: "discord:msg-long",
      eventType: "inbound.message.received",
      eventVersion: "1.0.0",
      occurredAt: "2026-04-09T00:00:00.000Z",
      producer: { service: "discord-transport" },
      correlation: {
        correlationId: "msg-long",
        causationId: null,
        conversationId: "chan-1",
        actorId: "owner-1"
      },
      routing: {
        transport: "discord",
        channelId: "chan-1",
        guildId: "guild-1",
        replyTo: "msg-long"
      },
      diagnostics: {
        severity: "info",
        category: "transport.discord"
      },
      payload: {
        messageId: "msg-long",
        sender: {
          actorId: "owner-1",
          displayName: "owner",
          actorRole: "owner"
        },
        content: "hello there",
        addressedContent: "hello there",
        isDirectMessage: false,
        mentionedBot: true,
        replyRoute: {
          transport: "discord",
          channelId: "chan-1",
          guildId: "guild-1",
          replyTo: "msg-long"
        }
      }
    } as const;

    const fullReply = `${"Paragraph one is deliberately long and should become its own chunk. ".repeat(40)}\n\n\`\`\`txt\n${"code line\n".repeat(80)}\`\`\`\n\n[mode: power]`;
    await bus.publishOutboundMessage(
      createOutboundMessageRequestedEvent({
        inboundEvent,
        content: fullReply,
        recordConversationTurn: true
      })
    );

    assert.ok(sentChunks.length > 1);
    assert.equal(sentChunks.at(-1)?.includes("[mode: power]"), true);
    assert.equal(sentChunks.slice(0, -1).some((chunk) => chunk.includes("[mode: power]")), false);

    const turns = persistence.listRecentConversationTurns("chan-1", 10);
    const assistantTurns = turns.filter((turn) => turn.role === "assistant");
    assert.equal(assistantTurns.length, 1);
    assert.equal(assistantTurns[0]?.content, fullReply);
  } finally {
    unregisterConsumer();
    cleanup();
  }
});

test("Discord outbound delivery supports direct-message notifications and emits delivery results", async () => {
  const { persistence, cleanup } = createPersistence();
  const sentChunks: string[] = [];
  const deliveredRequestIds: string[] = [];
  const bus = createInMemoryEventBus();
  const unregisterConsumer = registerDiscordEgressConsumer({
    bus,
    client: createDiscordEgressTestClient({
      sentChunks
    }) as never,
    logger: createLogger() as never,
    persistence
  });

  try {
    bus.subscribeOutboundMessageDelivered(async (event) => {
      deliveredRequestIds.push(event.payload.requestEventId);
    });

    await bus.publishOutboundMessage(
      createSystemOutboundMessageRequestedEvent({
        content: "Reminder #1: stretch\nReply with `reminder ack 1` when handled.",
        participantActorId: "owner-1",
        delivery: {
          transport: "discord",
          kind: "direct-message",
          channelId: null,
          guildId: null,
          replyTo: null,
          recipientActorId: "owner-1"
        },
        producerService: "reminders",
        correlationId: "reminder:1",
        actorId: "owner-1",
        deliveryContext: {
          kind: "reminder",
          reminderId: 1
        }
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sentChunks.length, 1);
    assert.match(sentChunks[0] ?? "", /Reminder #1/);
    assert.equal(deliveredRequestIds.length, 1);
  } finally {
    unregisterConsumer();
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
    const unregisterEgress = registerDiscordEgressConsumer({
      bus,
      client: createDiscordEgressTestClient({
        sentChunks: replies
      }) as never,
      logger: createLogger() as never,
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
      unregisterEgress();
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
    const unregisterEgress = registerDiscordEgressConsumer({
      bus,
      client: createDiscordEgressTestClient({
        sentChunks: replies
      }) as never,
      logger: createLogger() as never,
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
          mentionedRoleIds: ["1492214618611908830"],
          botRoleIds: ["1492214618611908830"],
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
      unregisterEgress();
      unsubscribe();
      await client.destroy();
    }
  } finally {
    cleanup();
  }
});

test("Discord ingress treats the bot role mention as addressed chat", async () => {
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
    const unregisterEgress = registerDiscordEgressConsumer({
      bus,
      client: createDiscordEgressTestClient({
        sentChunks: replies
      }) as never,
      logger: createLogger() as never,
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
          mentionedRoleIds: ["1492214618611908830"],
          botRoleIds: ["1492214618611908830"],
          createdAt: "2026-04-09T00:00:00.000Z",
          replyLog: replies
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(generatedMessages[0], "what do you think?");
      assert.match(replies[0] ?? "", /role mention chat reply/);
    } finally {
      unregisterEgress();
      unsubscribe();
      await client.destroy();
    }
  } finally {
    cleanup();
  }
});

test("Discord ingress does not treat an unrelated same-name role as Dot", async () => {
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
            reply: "should not happen"
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
          id: "msg-other-role-chat",
          content: "<@&role-other> what do you think?",
          mentionedBot: false,
          mentionedRoleIds: ["role-other"],
          botRoleIds: ["role-bot"],
          createdAt: "2026-04-09T00:00:00.000Z",
          replyLog: replies
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(replies.length, 0);
      assert.equal(generatedMessages.length, 0);
    } finally {
      unsubscribe();
      await client.destroy();
    }
  } finally {
    cleanup();
  }
});
