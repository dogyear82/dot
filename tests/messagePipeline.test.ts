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
    occurredAt: "2026-04-09T00:00:00.000Z",
    transport: "discord",
    conversationId: "channel-1",
    sourceMessageId: "msg-1",
    correlationId: "msg-1",
    sender: {
      actorId: "owner-1",
      displayName: "tan",
      actorRole: "owner"
    },
    replyRoute: {
      transport: "discord",
      channelId: "channel-1",
      guildId: "guild-1",
      replyToMessageId: "msg-1"
    },
    payload: {
      content: "!settings show",
      addressedContent: "!settings show",
      isDirectMessage: false,
      mentionedBot: true
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
    assert.equal(outbound[0]?.replyRoute.replyToMessageId, "msg-1");
    assert.equal(outbound[0]?.recordConversationTurn, true);
    assert.match(outbound[0]?.content ?? "", /Current settings:/);
    assert.match(outbound[0]?.content ?? "", /\[power: standby\]/);
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
          content: "tell me something interesting",
          addressedContent: "tell me something interesting",
          isDirectMessage: false,
          mentionedBot: true
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.equal(outbound[0]?.recordConversationTurn, true);
    assert.match(outbound[0]?.content ?? "", /hosted chat reply/);
    assert.match(outbound[0]?.content ?? "", /\[power: engaged\]/);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline relays non-owner messages into the inbox and keeps privileged features blocked", async () => {
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
      throw new Error("non-owner relay should not invoke chat");
    },
    async inferToolDecision() {
      throw new Error("non-owner relay should not invoke tool inference");
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
        sourceMessageId: "msg-non-owner",
        sender: {
          actorId: "user-2",
          displayName: "alice",
          actorRole: "non-owner"
        },
        payload: {
          content: "<@bot> can you tell the owner I need a callback?",
          addressedContent: "can you tell the owner I need a callback?",
          isDirectMessage: false,
          mentionedBot: true
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.content ?? "", /saved your message for the owner as inbox item/i);
    assert.equal(persistence.listPendingInboxItems().length, 1);
    assert.equal(persistence.listPendingInboxItems()[0]?.authorUsername, "alice");
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline prompts non-owner users to supply a message when they only ping Dot", async () => {
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
      throw new Error("non-owner prompt should not invoke chat");
    },
    async inferToolDecision() {
      throw new Error("non-owner prompt should not invoke tool inference");
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
        sourceMessageId: "msg-empty-non-owner",
        sender: {
          actorId: "user-2",
          displayName: "alice",
          actorRole: "non-owner"
        },
        payload: {
          content: "<@bot>",
          addressedContent: "",
          isDirectMessage: false,
          mentionedBot: true
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.content ?? "", /pass a message to the owner/i);
    assert.equal(persistence.listPendingInboxItems().length, 0);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline surfaces pending inbox items to the owner and supports inbox commands", async () => {
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
      return { route: "local", powerStatus: "standby", reply: "owner chat reply" };
    },
    async inferToolDecision() {
      return { route: "local", powerStatus: "standby", decision: { decision: "none", reason: "not needed" } };
    },
    getPowerStatus() {
      return "standby";
    }
  };

  persistence.settings.set("onboarding.completed", "true");
  persistence.createInboxItem({
    id: "msg-contact-1",
    channelId: "chan-2",
    guildId: "guild-1",
    authorId: "user-2",
    authorUsername: "alice",
    content: "please call me back",
    isDirectMessage: false,
    mentionedBot: true,
    createdAt: "2026-04-10T00:00:00.000Z"
  });

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
        sourceMessageId: "msg-owner-1",
        payload: {
          content: "hello dot",
          addressedContent: "hello dot",
          isDirectMessage: true,
          mentionedBot: false
        }
      })
    );

    assert.equal(outbound.length, 2);
    assert.match(outbound[0]?.content ?? "", /pending inbox item/);
    assert.match(outbound[1]?.content ?? "", /owner chat reply/);
    assert.equal(persistence.listUnnotifiedInboxItems().length, 0);

    outbound.length = 0;
    await bus.publishInboundMessage(
      inboundEvent({
        sourceMessageId: "msg-owner-2",
        payload: {
          content: "!inbox done 1",
          addressedContent: "!inbox done 1",
          isDirectMessage: true,
          mentionedBot: false
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.content ?? "", /Marked inbox item #1 as handled/);
    assert.equal(persistence.listPendingInboxItems().length, 0);
  } finally {
    unsubscribe();
    cleanup();
  }
});
