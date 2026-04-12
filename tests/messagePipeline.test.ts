import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createInMemoryEventBus } from "../src/eventBus.js";
import { registerMessagePipeline } from "../src/messagePipeline.js";
import { initializePersistence } from "../src/persistence.js";
import type { ChatService } from "../src/chat/modelRouter.js";
import type { InboundMessageReceivedEvent, OutboundMessageRequestedEvent } from "../src/events.js";
import type { OutlookCalendarClient } from "../src/outlookCalendar.js";

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-pipeline-"));
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

function inboundEvent(overrides: Partial<InboundMessageReceivedEvent> = {}): InboundMessageReceivedEvent {
  return {
    eventId: "discord:msg-1",
    eventType: "inbound.message.received",
    eventVersion: "1.0.0",
    occurredAt: "2026-04-09T00:00:00.000Z",
    producer: {
      service: "discord-ingress"
    },
    correlation: {
      correlationId: "msg-1",
      causationId: null,
      conversationId: "channel-1",
      actorId: "owner-1"
    },
    routing: {
      transport: "discord",
      channelId: "channel-1",
      guildId: "guild-1",
      replyTo: "msg-1"
    },
    diagnostics: {
      severity: "info",
      category: "discord.inbound"
    },
    payload: {
      messageId: "msg-1",
      sender: {
        actorId: "owner-1",
        displayName: "tan",
        actorRole: "owner"
      },
      content: "!settings show",
      addressedContent: "!settings show",
      isDirectMessage: false,
      mentionedBot: true,
      replyRoute: {
        transport: "discord",
        channelId: "channel-1",
        guildId: "guild-1",
        replyTo: "msg-1"
      }
    },
    ...overrides
  };
}

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}

test("message pipeline turns explicit owner commands into outbound delivery requests", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  const chatService: ChatService = {
    async generateOwnerReply() {
      return { route: "local", powerStatus: "standby", reply: "chat reply" };
    },
    async inferToolDecision() {
      return { route: "local", powerStatus: "standby", decision: { decision: "none", reason: "not needed" } };
    },
    getPowerStatus() {
      return "standby";
    }
  };

  persistence.settings.set("onboarding.completed", "true");
  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient,
    chatService,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  try {
    await bus.publishInboundMessage(inboundEvent());

    assert.equal(outbound.length, 1);
    assert.equal(outbound[0]?.payload.replyRoute.replyTo, "msg-1");
    assert.equal(outbound[0]?.payload.recordConversationTurn, true);
    assert.match(outbound[0]?.payload.content ?? "", /Current settings:/);
    assert.match(outbound[0]?.payload.content ?? "", /\[mode: normal\]/);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline handles explicit owner commands before addressedness inference", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  const chatService: ChatService = {
    async generateOwnerReply() {
      throw new Error("explicit commands should not invoke chat");
    },
    async inferToolDecision() {
      throw new Error("explicit commands should not invoke inference");
    },
    getPowerStatus() {
      return "standby";
    }
  };

  persistence.settings.set("onboarding.completed", "true");
  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient,
    chatService,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  try {
    await bus.publishInboundMessage(
      inboundEvent({
        routing: {
          transport: "discord",
          channelId: "channel-1",
          guildId: "guild-1",
          replyTo: "msg-owner-command-unmentioned"
        },
        payload: {
          messageId: "msg-owner-command-unmentioned",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "!settings show",
          addressedContent: "!settings show",
          isDirectMessage: false,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-owner-command-unmentioned"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /Current settings:/);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline preserves transport and conversation metadata in access audit", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  const chatService: ChatService = {
    async generateOwnerReply() {
      return { route: "local", powerStatus: "standby", reply: "chat reply" };
    },
    async inferToolDecision() {
      return { route: "local", powerStatus: "standby", decision: { decision: "none", reason: "not needed" } };
    },
    getPowerStatus() {
      return "standby";
    }
  };

  persistence.settings.set("onboarding.completed", "true");

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient,
    chatService,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  try {
    await bus.publishInboundMessage(inboundEvent());

    const auditRow = persistence.db
      .prepare<[string], { transport: string | null; conversationId: string | null }>(
        "SELECT transport, conversation_id AS conversationId FROM access_audit WHERE message_id = ?"
      )
      .get("msg-1");

    assert.equal(auditRow?.transport, "discord");
    assert.equal(auditRow?.conversationId, "channel-1");
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline appends an engaged power indicator when chat uses the hosted path", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  const chatService: ChatService = {
    async generateOwnerReply() {
      return { route: "hosted", powerStatus: "engaged", reply: "hosted chat reply" };
    },
    async inferToolDecision() {
      return { route: "local", powerStatus: "standby", decision: { decision: "none", reason: "not needed" } };
    },
    getPowerStatus(route = "none") {
      return route === "hosted" ? "engaged" : "standby";
    }
  };

  persistence.settings.set("onboarding.completed", "true");
  persistence.settings.set("channels.defaultPolicy", "whitelist");

  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient,
    chatService,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  try {
    await bus.publishInboundMessage(
      inboundEvent({
        payload: {
          messageId: "msg-1",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "tell me something interesting",
          addressedContent: "tell me something interesting",
          isDirectMessage: false,
          mentionedBot: true,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-1"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.equal(outbound[0]?.payload.recordConversationTurn, true);
    assert.match(outbound[0]?.payload.content ?? "", /hosted chat reply/);
    assert.match(outbound[0]?.payload.content ?? "", /\[mode: power\]/);
  } finally {
    unsubscribe();
    cleanup();
  }
});
test("message pipeline lets clearly addressed non-owner messages flow through normal chat", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  const chatService: ChatService = {
    async generateOwnerReply() {
      return { route: "local", powerStatus: "standby", reply: "non-owner chat reply" };
    },
    async inferToolDecision() {
      throw new Error("non-owner chat should not invoke tool inference");
    },
    getPowerStatus() {
      return "standby";
    }
  };

  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient,
    chatService,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  try {
    await bus.publishInboundMessage(
      inboundEvent({
        correlation: {
          correlationId: "msg-non-owner",
          causationId: null,
          conversationId: "channel-1",
          actorId: "user-2"
        },
        payload: {
          messageId: "msg-non-owner",
          sender: {
            actorId: "user-2",
            displayName: "alice",
            actorRole: "non-owner"
          },
          content: "<@bot> can you tell the owner I need a callback?",
          addressedContent: "can you tell the owner I need a callback?",
          isDirectMessage: false,
          mentionedBot: true,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-non-owner"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /non-owner chat reply/i);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline stays silent for non-owner shared-channel messages that are not clearly addressed", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  const chatService: ChatService = {
    async generateOwnerReply() {
      throw new Error("unaddressed non-owner messages should stay silent");
    },
    async inferToolDecision() {
      throw new Error("unaddressed non-owner messages should stay silent");
    },
    getPowerStatus() {
      return "standby";
    }
  };

  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient,
    chatService,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  try {
    await bus.publishInboundMessage(
      inboundEvent({
        correlation: {
          correlationId: "msg-unaddressed-non-owner",
          causationId: null,
          conversationId: "channel-1",
          actorId: "user-2"
        },
        payload: {
          messageId: "msg-unaddressed-non-owner",
          sender: {
            actorId: "user-2",
            displayName: "alice",
            actorRole: "non-owner"
          },
          content: "what about tomorrow?",
          addressedContent: "what about tomorrow?",
          isDirectMessage: false,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-unaddressed-non-owner"
          }
        }
      })
    );

    assert.equal(outbound.length, 0);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline blocks owner-only commands for non-owner users", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  const chatService: ChatService = {
    async generateOwnerReply() {
      throw new Error("owner-only command denial should not invoke chat");
    },
    async inferToolDecision() {
      throw new Error("owner-only command denial should not invoke tool inference");
    },
    getPowerStatus() {
      return "standby";
    }
  };

  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient,
    chatService,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  try {
    await bus.publishInboundMessage(
      inboundEvent({
        correlation: {
          correlationId: "msg-non-owner-command",
          causationId: null,
          conversationId: "channel-1",
          actorId: "user-2"
        },
        payload: {
          messageId: "msg-non-owner-command",
          sender: {
            actorId: "user-2",
            displayName: "alice",
            actorRole: "non-owner"
          },
          content: "!settings show",
          addressedContent: "!settings show",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-non-owner-command"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /owner-only/i);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline routes policy commands and returns the unknown-contact classification prompt", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  const chatService: ChatService = {
    async generateOwnerReply() {
      throw new Error("policy command should not invoke chat");
    },
    async inferToolDecision() {
      throw new Error("policy command should not invoke tool inference");
    },
    getPowerStatus() {
      return "standby";
    }
  };

  persistence.settings.set("onboarding.completed", "true");
  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient,
    chatService,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  try {
    await bus.publishInboundMessage(
      inboundEvent({
        payload: {
          messageId: "msg-policy-1",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "!policy check email.send Michelle",
          addressedContent: "!policy check email.send Michelle",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: null,
            replyTo: "msg-policy-1"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /contact classification required/i);
    assert.match(outbound[0]?.payload.content ?? "", /!contact classify 1/i);
    assert.equal(persistence.getPendingContactClassification(1)?.contactQuery, "Michelle");
  } finally {
    unsubscribe();
    cleanup();
  }
});
