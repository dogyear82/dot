import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerEmailActionsConsumer } from "../src/emailActions.js";
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

function inboundEvent(
  overrides: Partial<InboundMessageReceivedEvent> & {
    correlation?: Partial<InboundMessageReceivedEvent["correlation"]>;
    routing?: Partial<InboundMessageReceivedEvent["routing"]>;
    diagnostics?: Partial<InboundMessageReceivedEvent["diagnostics"]>;
    payload?: Partial<InboundMessageReceivedEvent["payload"]>;
  } = {}
): InboundMessageReceivedEvent {
  const baseEvent: InboundMessageReceivedEvent = {
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
      repliedToMessageId: null,
      repliedToBot: false,
      replyRoute: {
        transport: "discord",
        channelId: "channel-1",
        guildId: "guild-1",
        replyTo: "msg-1"
      }
    },
  };

  return {
    ...baseEvent,
    ...overrides,
    correlation: {
      ...baseEvent.correlation,
      ...(overrides.correlation ?? {})
    },
    routing: {
      ...baseEvent.routing,
      ...(overrides.routing ?? {})
    },
    diagnostics: {
      ...baseEvent.diagnostics,
      ...(overrides.diagnostics ?? {})
    },
    payload: {
      ...baseEvent.payload,
      ...(overrides.payload ?? {}),
      sender: {
        ...baseEvent.payload.sender,
        ...(overrides.payload?.sender ?? {})
      },
      replyRoute: {
        ...baseEvent.payload.replyRoute,
        ...(overrides.payload?.replyRoute ?? {})
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

function createCapturingLogger() {
  const entries: Array<{ level: "info" | "warn" | "error"; payload?: unknown; message?: string }> = [];
  return {
    entries,
    logger: {
      info(payload?: unknown, message?: string) {
        entries.push({ level: "info", payload, message });
      },
      warn(payload?: unknown, message?: string) {
        entries.push({ level: "warn", payload, message });
      },
      error(payload?: unknown, message?: string) {
        entries.push({ level: "error", payload, message });
      }
    }
  };
}

function futureIso(hoursAhead: number): string {
  return new Date(Date.now() + hoursAhead * 60 * 60 * 1000).toISOString();
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
  const dueAt = futureIso(4);
  const chatService: ChatService = {
    async generateOwnerReply() {
      return { route: "local", powerStatus: "standby", reply: "chat reply" };
    },
    async inferToolDecision() {
      return {
        route: "local",
        powerStatus: "standby",
        decision: { decision: "respond", reason: "not needed", response: "chat reply" }
      };
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
    assert.equal(outbound[0]?.payload.delivery.kind, "reply");
    assert.equal(outbound[0]?.payload.delivery.replyTo, "msg-1");
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
  const dueAt = futureIso(4);
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

test("message pipeline does not treat unknown bang-prefixed text as a deterministic explicit command", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  let addressedInferenceCalls = 0;
  const chatService: ChatService = {
    async generateOwnerReply() {
      throw new Error("unknown bang-prefixed text should be ignored when the classifier says it is not addressed");
    },
    async inferAddressedToolDecision() {
      addressedInferenceCalls += 1;
      return {
        route: "hosted",
        powerStatus: "engaged",
        decision: {
          addressed: false,
          reason: "the message is not clearly directed to Dot"
        }
      };
    },
    async inferToolDecision() {
      throw new Error("unknown bang-prefixed text should not reach the regular intent classifier");
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
          messageId: "msg-owner-unknown-bang",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "!notacommand",
          addressedContent: "!notacommand",
          isDirectMessage: false,
          mentionedBot: false,
          repliedToMessageId: null,
          repliedToBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-owner-unknown-bang"
          }
        }
      })
    );

    assert.equal(addressedInferenceCalls, 1);
    assert.equal(outbound.length, 0);

    const auditRow = persistence.db
      .prepare<[string], { addressed: number | null; addressedReason: string | null }>(
        "SELECT addressed, addressed_reason AS addressedReason FROM access_audit WHERE message_id = ?"
      )
      .get("msg-owner-unknown-bang");

    assert.equal(auditRow?.addressed, 0);
    assert.equal(auditRow?.addressedReason, "llm_not_addressed");
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline routes explicit email draft commands through the deterministic email workflow", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  const dueAt = futureIso(4);
  const chatService: ChatService = {
    async generateOwnerReply() {
      throw new Error("email commands should not invoke chat");
    },
    async inferToolDecision() {
      throw new Error("email commands should not invoke inference");
    },
    getPowerStatus() {
      return "standby";
    }
  };

  persistence.settings.set("onboarding.completed", "true");
  persistence.upsertContact({
    canonicalName: "Michelle",
    trustLevel: "trusted",
    endpoints: [{ kind: "email", value: "michelle@example.com" }]
  });

  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });
  const unregisterEmailActions = registerEmailActionsConsumer({
    bus,
    logger: createLogger() as never,
    mailClient: {
      async createDraft() {
        return { id: "draft-1", webLink: "https://outlook.example/draft-1" };
      },
      async sendDraft() {}
    } as never,
    persistence
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
          messageId: "msg-owner-email-draft",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "!email draft Michelle | Hello | Checking in.",
          addressedContent: "!email draft Michelle | Hello | Checking in.",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-owner-email-draft"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /Created draft email action #1/);
    assert.match(outbound[0]?.payload.content ?? "", /!email approve 1/);
  } finally {
    unregisterEmailActions();
    unsubscribe();
    cleanup();
  }
});

test("message pipeline executes inferred world.lookup and records grounded audit detail", async () => {
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
      throw new Error("world lookup should not fall back to normal chat");
    },
    async renderToolResult() {
      return {
        route: "local",
        powerStatus: "standby",
        reply: "According to Wikipedia, zebras breed seasonally.\n\nLinks:\n- https://en.wikipedia.org/wiki/Zebra"
      };
    },
    async inferToolDecision() {
      return {
        route: "local",
        powerStatus: "standby",
        decision: {
          decision: "execute_tool",
          toolName: "world.lookup",
          reason: "owner asked for public factual grounding",
          confidence: "high",
          args: {
            query: "When is zebra mating season?"
          }
        }
      };
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
          messageId: "msg-world-lookup",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "When is zebra mating season?",
          addressedContent: "When is zebra mating season?",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: null,
            replyTo: "msg-world-lookup"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /According to Wikipedia/i);

    const audit = persistence.db
      .prepare("SELECT tool_name, status, provider, detail FROM tool_execution_audit WHERE message_id = ?")
      .get("msg-world-lookup") as { tool_name: string; status: string; provider: string | null; detail: string | null };

    assert.equal(audit.tool_name, "world.lookup");
    assert.equal(audit.status, "executed");
    assert.equal(audit.provider, "local");
    assert.match(audit.detail ?? "", /bucket=reference/);
    assert.match(audit.detail ?? "", /selectedSources=wikipedia/);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline executes inferred weather.lookup and records weather audit detail", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const chatService: ChatService = {
    async generateOwnerReply() {
      throw new Error("weather lookup should not fall back to normal chat");
    },
    async renderToolResult(params) {
      assert.equal((params.payload.location as { name: string }).name, "Phoenix");
      return {
        route: "hosted",
        powerStatus: "engaged",
        reply: "Looks like Phoenix will be clear tomorrow with a high around 88F."
      };
    },
    async inferToolDecision() {
      return {
        route: "hosted",
        powerStatus: "engaged",
        decision: {
          decision: "execute_tool",
          toolName: "weather.lookup",
          reason: "owner asked for weather information",
          confidence: "high",
          args: {
            location: "Phoenix, AZ"
          }
        }
      };
    },
    getPowerStatus(route) {
      return route === "hosted" ? "engaged" : "standby";
    }
  };

  persistence.settings.set("onboarding.completed", "true");
  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient: {
      async listUpcomingEvents() {
        return [];
      }
    },
    chatService,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence,
    weatherClient: {
      async lookup() {
        return {
          kind: "success" as const,
          location: {
            name: "Phoenix",
            admin1: "Arizona",
            country: "United States",
            countryCode: "US",
            latitude: 33.45,
            longitude: -112.07,
            timezone: "America/Phoenix",
            label: "Phoenix, Arizona, United States"
          },
          units: {
            temperature: "F" as const,
            windSpeed: "mph" as const
          },
          current: {
            time: "2026-04-16T09:00",
            temperature: 78,
            apparentTemperature: 80,
            windSpeed: 6,
            condition: "clear",
            isDay: true
          },
          daily: [
            {
              date: "2026-04-16",
              condition: "clear",
              temperatureMax: 86,
              temperatureMin: 62,
              precipitationProbabilityMax: 0
            },
            {
              date: "2026-04-17",
              condition: "partly cloudy",
              temperatureMax: 88,
              temperatureMin: 64,
              precipitationProbabilityMax: 10
            }
          ]
        };
      }
    }
  });

  try {
    await bus.publishInboundMessage(
      inboundEvent({
        payload: {
          messageId: "msg-weather-lookup",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "What's the weather in Phoenix, AZ tomorrow?",
          addressedContent: "What's the weather in Phoenix, AZ tomorrow?",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: null,
            replyTo: "msg-weather-lookup"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /Phoenix/);

    const audit = persistence.db
      .prepare("SELECT tool_name, status, provider, detail FROM tool_execution_audit WHERE message_id = ?")
      .get("msg-weather-lookup") as { tool_name: string; status: string; provider: string | null; detail: string | null };

    assert.equal(audit.tool_name, "weather.lookup");
    assert.equal(audit.status, "executed");
    assert.equal(audit.provider, "hosted");
    assert.match(audit.detail ?? "", /location=Phoenix, Arizona, United States/);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline executes inferred reminder add/show/ack through the conversational tool contract", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  let inferenceCount = 0;

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient: {
      async listUpcomingEvents() {
        return [];
      }
    },
    chatService: {
      async generateOwnerReply() {
        throw new Error("reminder flow should not fall back to chat");
      },
      async renderToolResult() {
        throw new Error("final_text reminder tools should not invoke llm rendering");
      },
      async inferToolDecision() {
        inferenceCount += 1;
        if (inferenceCount === 1) {
          return {
            route: "local",
            powerStatus: "standby",
            decision: {
              decision: "execute_tool",
              toolName: "reminder.add",
              reason: "owner wants a reminder",
              confidence: "high",
              args: {
                duration: "10m",
                message: "stretch"
              }
            }
          };
        }

        if (inferenceCount === 2) {
          return {
            route: "local",
            powerStatus: "standby",
            decision: {
              decision: "execute_tool",
              toolName: "reminder.show",
              reason: "owner wants to list reminders",
              confidence: "high",
              args: {}
            }
          };
        }

        return {
          route: "local",
          powerStatus: "standby",
          decision: {
            decision: "execute_tool",
            toolName: "reminder.ack",
            reason: "owner wants to acknowledge a reminder",
            confidence: "high",
            args: {
              id: 1
            }
          }
        };
      },
      async resolvePendingToolDecision({ userMessage }: { userMessage: string }) {
        assert.equal(userMessage, "yes");
        return {
          route: "local",
          powerStatus: "standby",
          decision: {
            decision: "execute_tool",
            toolName: "reminder.add",
            reason: "owner confirmed the reminder details",
            confidence: "high",
            args: {
              confirmed: "yes"
            }
          }
        };
      },
      getPowerStatus() {
        return "standby";
      }
    } as never,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  try {
    persistence.settings.set("onboarding.completed", "true");

    for (const [messageId, content] of [
      ["msg-remind-1", "remind me in 10 minutes to stretch"],
      ["msg-remind-1b", "yes"],
      ["msg-remind-2", "show my reminders"],
      ["msg-remind-3", "acknowledge reminder 1"]
    ] as const) {
      await bus.publishInboundMessage(
        inboundEvent({
          eventId: `discord:${messageId}`,
          correlation: {
            correlationId: messageId,
            causationId: null,
            conversationId: "channel-1",
            actorId: "owner-1"
          },
          payload: {
            messageId,
            sender: {
              actorId: "owner-1",
              displayName: "tan",
              actorRole: "owner"
            },
            content,
            addressedContent: content,
            isDirectMessage: true,
            mentionedBot: false,
            replyRoute: {
              transport: "discord",
              channelId: "channel-1",
              guildId: null,
              replyTo: messageId
            }
          }
        })
      );
    }

    assert.equal(outbound.length, 4);
    assert.match(outbound[0]?.payload.content ?? "", /Want me to save it\?/i);
    assert.match(outbound[1]?.payload.content ?? "", /Saved reminder #1/i);
    assert.match(outbound[2]?.payload.content ?? "", /Pending reminders/i);
    assert.match(outbound[3]?.payload.content ?? "", /Acknowledged reminder #1/i);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline uses deterministic reminder intake for clarification and confirmation flows", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient: {
      async listUpcomingEvents() {
        return [];
      }
    },
    chatService: {
      async generateOwnerReply() {
        throw new Error("pending reminder clarification should not fall back to free chat");
      },
      async renderToolResult() {
        throw new Error("final_text reminder flow should not invoke llm rendering");
      },
      async inferToolDecision(userMessage: string) {
        if (userMessage !== "set a reminder to stretch") {
          throw new Error(`unexpected fresh inference for reminder intake turn: ${userMessage}`);
        }
        return {
          route: "local",
          powerStatus: "standby",
          decision: {
            decision: "execute_tool",
            toolName: "reminder.add",
            reason: "owner wants a reminder but only supplied the message",
            confidence: "high",
            args: {
              message: "stretch"
            }
          }
        };
      },
      async resolvePendingToolDecision() {
        throw new Error("reminder intake should not use llm pending-tool resolution");
      },
      getPowerStatus() {
        return "standby";
      }
    } as never,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  try {
    persistence.settings.set("onboarding.completed", "true");

    await bus.publishInboundMessage(
      inboundEvent({
        payload: {
          messageId: "msg-remind-clarify-1",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "set a reminder to stretch",
          addressedContent: "set a reminder to stretch",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: null,
            replyTo: "msg-remind-clarify-1"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /fire up that intake form/i);
    assert.match(outbound[0]?.payload.content ?? "", /specific time or a duration from now/i);
    assert.deepEqual(persistence.getPendingConversationalToolSession("channel-1")?.args, {
      message: "stretch"
    });

    await bus.publishInboundMessage(
      inboundEvent({
        eventId: "discord:msg-remind-clarify-2",
        correlation: {
          correlationId: "msg-remind-clarify-2",
          causationId: null,
          conversationId: "channel-1",
          actorId: "owner-1"
        },
        payload: {
          messageId: "msg-remind-clarify-2",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "duration",
          addressedContent: "duration",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: null,
            replyTo: "msg-remind-clarify-2"
          }
        }
      })
    );

    assert.equal(outbound.length, 2);
    assert.match(outbound[1]?.payload.content ?? "", /How long from now should I set it for/i);
    assert.deepEqual(persistence.getPendingConversationalToolSession("channel-1")?.args, {
      message: "stretch"
    });

    await bus.publishInboundMessage(
      inboundEvent({
        eventId: "discord:msg-remind-clarify-3",
        correlation: {
          correlationId: "msg-remind-clarify-3",
          causationId: null,
          conversationId: "channel-1",
          actorId: "owner-1"
        },
        payload: {
          messageId: "msg-remind-clarify-3",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "in 10 minutes",
          addressedContent: "in 10 minutes",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: null,
            replyTo: "msg-remind-clarify-3"
          }
        }
      })
    );

    assert.equal(outbound.length, 3);
    assert.match(outbound[2]?.payload.content ?? "", /Want me to save it\?/i);
    assert.deepEqual(persistence.getPendingConversationalToolSession("channel-1")?.args, {
      message: "stretch",
      duration: "10m"
    });

    await bus.publishInboundMessage(
      inboundEvent({
        eventId: "discord:msg-remind-clarify-4",
        correlation: {
          correlationId: "msg-remind-clarify-4",
          causationId: null,
          conversationId: "channel-1",
          actorId: "owner-1"
        },
        payload: {
          messageId: "msg-remind-clarify-4",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "yes",
          addressedContent: "yes",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: null,
            replyTo: "msg-remind-clarify-4"
          }
        }
      })
    );

    assert.equal(outbound.length, 4);
    assert.match(outbound[3]?.payload.content ?? "", /Saved reminder #1/i);
    assert.equal(persistence.getPendingConversationalToolSession("channel-1"), null);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline skips reminder intake questions when inference already provides dueAt", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const dueAt = futureIso(12);

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient: {
      async listUpcomingEvents() {
        return [];
      }
    },
    chatService: {
      async generateOwnerReply() {
        throw new Error("complete reminder args should not fall back to chat");
      },
      async renderToolResult() {
        throw new Error("confirmation prompt should not invoke llm rendering");
      },
      async inferToolDecision(userMessage: string) {
        assert.equal(userMessage, "schedule a reminder for tomorrow at 9am to walk the dog");
        return {
          route: "hosted",
          powerStatus: "engaged",
          rawModelOutput:
            `{"decision":"execute_tool","toolName":"reminder.add","reason":"owner wants to set a reminder for a specific time","confidence":"high","args":{"message":"walk the dog","dueAt":"${dueAt}"}}`,
          promptMessages: [
            { role: "system", content: "intent prompt" },
            { role: "user", content: userMessage }
          ],
          decision: {
            decision: "execute_tool",
            toolName: "reminder.add",
            reason: "owner wants to set a reminder for a specific time",
            confidence: "high",
            args: {
              message: "walk the dog",
              dueAt
            }
          }
        };
      },
      getPowerStatus(route: "none" | "deterministic" | "local" | "hosted") {
        return route === "hosted" ? "engaged" : "standby";
      }
    } as never,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  try {
    persistence.settings.set("onboarding.completed", "true");

    await bus.publishInboundMessage(
      inboundEvent({
        payload: {
          messageId: "msg-remind-dueAt-1",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "schedule a reminder for tomorrow at 9am to walk the dog",
          addressedContent: "schedule a reminder for tomorrow at 9am to walk the dog",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: null,
            replyTo: "msg-remind-dueAt-1"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.doesNotMatch(outbound[0]?.payload.content ?? "", /specific time or a duration from now/i);
    assert.match(outbound[0]?.payload.content ?? "", /walk the dog/i);
    assert.match(outbound[0]?.payload.content ?? "", /want me to save it\?/i);
    assert.deepEqual(persistence.getPendingConversationalToolSession("channel-1")?.args, {
      message: "walk the dog",
      dueAt
    });
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline preserves the full owner wording for inferred world.lookup current-events queries", async () => {
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
      throw new Error("world lookup should not fall back to normal chat");
    },
    async renderToolResult(params) {
      assert.equal(params.payload.bucket, "current_events");
      assert.deepEqual(params.payload.selectedSources, ["newsdata", "gdelt"]);
      return {
        route: "hosted",
        powerStatus: "engaged",
        reply: "According to Wikinews, the situation in Myanmar remains unstable.\n\nLinks:\n- https://en.wikinews.org/wiki/Myanmar"
      };
    },
    async inferToolDecision() {
      return {
        route: "hosted",
        powerStatus: "engaged",
        decision: {
          decision: "execute_tool",
          toolName: "world.lookup",
          reason: "owner asked for current public information",
          confidence: "high",
          args: {
            query: "tell me what the situation is like in Myanmar right now"
          }
        }
      };
    },
    getPowerStatus(route) {
      return route === "hosted" ? "engaged" : "standby";
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
    persistence,
    worldLookupAdapters: {
      newsdata: {
        source: "newsdata",
        async lookup({ query }) {
          assert.match(query, /myanmar right now/i);
          return {
            source: "newsdata",
            evidence: [
              {
                source: "newsdata",
                title: "Myanmar current events",
                url: "https://example.test/myanmar",
                snippet: "Current-events coverage for Myanmar.",
                publishedAt: null,
                confidence: "high"
              }
            ]
          };
        }
      },
      gdelt: {
        source: "gdelt",
        async lookup({ query }) {
          assert.match(query, /myanmar right now/i);
          return {
            source: "gdelt",
            evidence: []
          };
        }
      }
    }
  });

  try {
    await bus.publishInboundMessage(
      inboundEvent({
        payload: {
          messageId: "msg-world-current-events",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "tell me what the situation is like in Myanmar right now",
          addressedContent: "tell me what the situation is like in Myanmar right now",
          isDirectMessage: false,
          mentionedBot: true,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-world-current-events"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);

    const audit = persistence.db
      .prepare("SELECT tool_name, status, provider, detail FROM tool_execution_audit WHERE message_id = ?")
      .get("msg-world-current-events") as { tool_name: string; status: string; provider: string | null; detail: string | null };

    assert.equal(audit.tool_name, "world.lookup");
    assert.equal(audit.status, "executed");
    assert.equal(audit.provider, "hosted");
    assert.match(audit.detail ?? "", /bucket=current_events/);
    assert.match(audit.detail ?? "", /selectedSources=newsdata,gdelt/);
    assert.match(audit.detail ?? "", /retrievalStrategy=current_events_topic_ranked/);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline saves topical current-events lookups for later follow-up in the same conversation", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  let inferenceCount = 0;
  const chatService: ChatService = {
    async generateOwnerReply() {
      throw new Error("topic news flow should not fall back to normal chat");
    },
    async renderToolResult(params) {
      if (String(params.payload.query).includes("OpenAI")) {
        return {
          route: "hosted",
          powerStatus: "engaged",
          reply: "According to Reuters, OpenAI is expanding its enterprise push.\n\nLinks:\n- https://example.test/openai-1"
        };
      }
      return {
        route: "hosted",
        powerStatus: "engaged",
        reply: "According to AP, OpenAI also signed new government customers.\n\nLinks:\n- https://example.test/openai-2"
      };
    },
    async inferToolDecision() {
      inferenceCount += 1;
      if (inferenceCount === 1) {
        return {
          route: "hosted",
          powerStatus: "engaged",
          decision: {
            decision: "execute_tool",
            toolName: "world.lookup",
            reason: "owner wants recent topic news",
            confidence: "high",
            args: {
              query: "what's the latest on OpenAI?"
            }
          }
        };
      }

      return {
        route: "local",
        powerStatus: "standby",
        decision: {
          decision: "execute_tool",
          toolName: "news.follow_up",
          reason: "owner is following up on a saved topic story",
          confidence: "high",
          args: {
            query: "tell me more about the second one"
          }
        }
      };
    },
    getPowerStatus(route) {
      return route === "hosted" ? "engaged" : "standby";
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
    persistence,
    worldLookupAdapters: {
      newsdata: {
        source: "newsdata",
        async lookup({ query }) {
          assert.match(query, /openai/i);
          return {
            source: "newsdata",
            evidence: [
              {
                source: "newsdata",
                title: "OpenAI expands enterprise sales",
                url: "https://example.test/openai-1",
                snippet: "Reuters reports OpenAI expanded its enterprise push.",
                publishedAt: "2026-04-13T09:00:00Z",
                publisher: "Reuters",
                confidence: "high"
              },
              {
                source: "newsdata",
                title: "OpenAI signs new government customers",
                url: "https://example.test/openai-2",
                snippet: "AP reports OpenAI signed additional government customers.",
                publishedAt: "2026-04-13T08:00:00Z",
                publisher: "AP",
                confidence: "medium"
              }
            ]
          };
        }
      },
      wikimedia_current_events: {
        source: "wikimedia_current_events",
        async lookup() {
          return {
            source: "wikimedia_current_events",
            evidence: []
          };
        }
      },
      gdelt: {
        source: "gdelt",
        async lookup() {
          return {
            source: "gdelt",
            evidence: []
          };
        }
      }
    }
  });

  try {
    await bus.publishInboundMessage(
      inboundEvent({
        correlation: {
          correlationId: "corr-topic-news",
          causationId: null,
          conversationId: "channel-topic",
          actorId: "owner-1"
        },
        payload: {
          messageId: "msg-topic-news",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "what's the latest on OpenAI?",
          addressedContent: "what's the latest on OpenAI?",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-topic",
            guildId: null,
            replyTo: "msg-topic-news"
          }
        }
      })
    );

    await bus.publishInboundMessage(
      inboundEvent({
        correlation: {
          correlationId: "corr-follow-up",
          causationId: null,
          conversationId: "channel-topic",
          actorId: "owner-1"
        },
        payload: {
          messageId: "msg-topic-follow-up",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "tell me more about the second one",
          addressedContent: "tell me more about the second one",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-topic",
            guildId: null,
            replyTo: "msg-topic-follow-up"
          }
        }
      })
    );

    assert.equal(outbound.length, 2);
    assert.match(outbound[0]?.payload.content ?? "", /According to Reuters/i);
    assert.match(outbound[1]?.payload.content ?? "", /According to AP/i);

    const session = persistence.getLatestNewsBrowseSession("channel-topic");
    assert.equal(session?.kind, "topic_lookup");

    const audit = persistence.db
      .prepare("SELECT tool_name, status, provider, detail FROM tool_execution_audit WHERE message_id = ?")
      .get("msg-topic-news") as { tool_name: string; status: string; provider: string | null; detail: string | null };

    assert.equal(audit.tool_name, "world.lookup");
    assert.match(audit.detail ?? "", /topicSessionSaved=yes/);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline executes inferred calendar show and remind through the conversational tool contract", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  let inferenceCount = 0;

  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient: {
      async listUpcomingEvents() {
        return [
          {
            id: "evt-1",
            subject: "Planning",
            startAt: "2027-04-08T10:00:00.000Z",
            endAt: "2027-04-08T11:00:00.000Z",
            webLink: "https://example.test/planning"
          }
        ];
      }
    },
    chatService: {
      async generateOwnerReply() {
        throw new Error("calendar flow should not fall back to chat");
      },
      async renderToolResult() {
        return {
          route: "hosted",
          powerStatus: "engaged",
          reply: "You have Planning at 10:00."
        };
      },
      async inferToolDecision() {
        inferenceCount += 1;
        if (inferenceCount === 1) {
          return {
            route: "hosted",
            powerStatus: "engaged",
            decision: {
              decision: "execute_tool",
              toolName: "calendar.show",
              reason: "owner wants upcoming calendar events",
              confidence: "high",
              args: {}
            }
          };
        }

        return {
          route: "local",
          powerStatus: "standby",
          decision: {
            decision: "execute_tool",
            toolName: "calendar.remind",
            reason: "owner wants a reminder for the first event",
            confidence: "high",
            args: {
              index: 1,
              leadTime: "15m"
            }
          }
        };
      },
      getPowerStatus(route: "none" | "deterministic" | "local" | "hosted" = "none") {
        return route === "hosted" ? "engaged" : "standby";
      }
    } as never,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  try {
    persistence.settings.set("onboarding.completed", "true");

    await bus.publishInboundMessage(
      inboundEvent({
        payload: {
          messageId: "msg-cal-show",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "what's on my calendar?",
          addressedContent: "what's on my calendar?",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: null,
            replyTo: "msg-cal-show"
          }
        }
      })
    );

    await bus.publishInboundMessage(
      inboundEvent({
        payload: {
          messageId: "msg-cal-remind",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "remind me about the first one 15 minutes early",
          addressedContent: "remind me about the first one 15 minutes early",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: null,
            replyTo: "msg-cal-remind"
          }
        }
      })
    );

    assert.equal(outbound.length, 2);
    assert.match(outbound[0]?.payload.content ?? "", /You have Planning at 10:00/i);
    assert.match(outbound[1]?.payload.content ?? "", /Saved reminder #1/i);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline lets a correction turn repair the prior current-events lookup instead of searching the complaint text", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  let inferenceCount = 0;
  const chatService: ChatService = {
    async generateOwnerReply() {
      throw new Error("correction flow should not fall back to normal chat");
    },
    async renderToolResult(params) {
      if (inferenceCount === 1) {
        return {
          route: "local",
          powerStatus: "standby",
          reply: "According to Wikipedia, Ukraine is a country in Eastern Europe.\n\nLinks:\n- https://en.wikipedia.org/wiki/Ukraine"
        };
      }

      return {
        route: "hosted",
        powerStatus: "engaged",
        reply: "According to Reuters, fighting intensified in eastern Ukraine this week.\n\nLinks:\n- https://example.test/ukraine-live"
      };
    },
    async inferToolDecision(userMessage, recentConversation) {
      inferenceCount += 1;
      if (inferenceCount === 1) {
        return {
          route: "local",
          powerStatus: "standby",
          decision: {
            decision: "execute_tool",
            toolName: "world.lookup",
            reason: "owner asked a current-events question",
            confidence: "high",
            args: {
              query: "what's going on in Ukraine"
            }
          }
        };
      }

      const transcript = (recentConversation ?? []).map((turn) => turn.content).join("\n");
      assert.match(transcript, /what's going on in Ukraine/i);

      return {
        route: "hosted",
        powerStatus: "engaged",
        decision: {
          decision: "execute_tool",
          toolName: "world.lookup",
          reason: "owner is correcting a stale history-style answer and still wants current events",
          confidence: "high",
          args: {
            query: "what's going on in Ukraine right now"
          }
        }
      };
    },
    getPowerStatus(route) {
      return route === "hosted" ? "engaged" : "standby";
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
    persistence,
    worldLookupAdapters: {
      wikipedia: {
        source: "wikipedia",
        async lookup({ query }) {
          if (/right now/i.test(query)) {
            throw new Error("repair lookup should not hit wikipedia");
          }

          return {
            source: "wikipedia",
            evidence: [
              {
                source: "wikipedia",
                title: "Ukraine",
                url: "https://en.wikipedia.org/wiki/Ukraine",
                snippet: "Ukraine is a country in Eastern Europe.",
                publishedAt: null,
                confidence: "high"
              }
            ]
          };
        }
      },
      newsdata: {
        source: "newsdata",
        async lookup({ query }) {
          assert.match(query, /ukraine right now/i);
          return {
            source: "newsdata",
            evidence: [
              {
                source: "newsdata",
                title: "Fighting intensifies in eastern Ukraine",
                url: "https://example.test/ukraine-live",
                snippet: "Reuters reports fighting intensified in eastern Ukraine this week.",
                publishedAt: "2026-04-13T08:00:00Z",
                publisher: "Reuters",
                confidence: "high"
              }
            ]
          };
        }
      },
      gdelt: {
        source: "gdelt",
        async lookup() {
          return { source: "gdelt", evidence: [] };
        }
      }
    }
  });

  try {
    await bus.publishInboundMessage(
      inboundEvent({
        correlation: {
          correlationId: "corr-ukraine-1",
          causationId: null,
          conversationId: "channel-ukraine",
          actorId: "owner-1"
        },
        payload: {
          messageId: "msg-ukraine-1",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "what's going on in Ukraine",
          addressedContent: "what's going on in Ukraine",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-ukraine",
            guildId: null,
            replyTo: "msg-ukraine-1"
          }
        }
      })
    );

    await bus.publishInboundMessage(
      inboundEvent({
        correlation: {
          correlationId: "corr-ukraine-2",
          causationId: null,
          conversationId: "channel-ukraine",
          actorId: "owner-1"
        },
        payload: {
          messageId: "msg-ukraine-2",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "I'm asking for current events, not history. wikipedia is not news",
          addressedContent: "I'm asking for current events, not history. wikipedia is not news",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-ukraine",
            guildId: null,
            replyTo: "msg-ukraine-2"
          }
        }
      })
    );

    assert.equal(outbound.length, 2);
    assert.match(outbound[1]?.payload.content ?? "", /According to Reuters/i);

    const audit = persistence.db
      .prepare("SELECT tool_name, status, provider, detail FROM tool_execution_audit WHERE message_id = ?")
      .get("msg-ukraine-2") as { tool_name: string; status: string; provider: string | null; detail: string | null };

    assert.equal(audit.tool_name, "world.lookup");
    assert.equal(audit.provider, "hosted");
    assert.match(audit.detail ?? "", /bucket=current_events/);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline turns incomplete explicit tool commands into clarification prompts", async () => {
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
      throw new Error("explicit tool clarification should not invoke chat");
    },
    async inferToolDecision() {
      throw new Error("explicit tool clarification should not invoke inference");
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
          messageId: "msg-owner-tool-clarify",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "!calendar remind",
          addressedContent: "!calendar remind",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: null,
            replyTo: "msg-owner-tool-clarify"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /Which calendar event should I create a reminder for/i);
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
      return {
        route: "local",
        powerStatus: "standby",
        decision: { decision: "respond", reason: "not needed", response: "chat reply" }
      };
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
      .prepare<[string], { transport: string | null; conversationId: string | null; addressed: number | null; addressedReason: string | null }>(
        "SELECT transport, conversation_id AS conversationId, addressed, addressed_reason AS addressedReason FROM access_audit WHERE message_id = ?"
      )
      .get("msg-1");

    assert.equal(auditRow?.transport, "discord");
    assert.equal(auditRow?.conversationId, "channel-1");
    assert.equal(auditRow?.addressed, 1);
    assert.equal(auditRow?.addressedReason, "explicit_command");
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
      return {
        route: "hosted",
        powerStatus: "engaged",
        decision: { decision: "respond", reason: "not needed", response: "hosted chat reply" }
      };
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

test("message pipeline audits respond decisions without triggering tool execution side effects", async () => {
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
      throw new Error("respond decisions should not fall back to normal chat");
    },
    async inferToolDecision() {
      return {
        route: "local",
        powerStatus: "standby",
        decision: {
          decision: "respond",
          reason: "plain conversational chat",
          response: "Well hey there, deary."
        }
      };
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
          messageId: "msg-respond-audit",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "hey dot",
          addressedContent: "hey dot",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: null,
            replyTo: "msg-respond-audit"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /Well hey there, deary\./);

    const audit = persistence.db
      .prepare("SELECT tool_name, status, provider, detail FROM tool_execution_audit WHERE message_id = ?")
      .get("msg-respond-audit") as { tool_name: string; status: string; provider: string | null; detail: string | null };

    assert.equal(audit.tool_name, "respond");
    assert.equal(audit.status, "executed");
    assert.equal(audit.provider, "local");
    assert.match(audit.detail ?? "", /decision=respond/);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline audits conversational intent failures before falling back to normal chat", async () => {
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
      return {
        route: "hosted",
        powerStatus: "engaged",
        reply: "fallback chat reply"
      };
    },
    async inferToolDecision() {
      throw new Error("bad classifier output");
    },
    getPowerStatus(route = "none") {
      return route === "hosted" ? "engaged" : "standby";
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
          messageId: "msg-intent-failure",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "tell me something interesting",
          addressedContent: "tell me something interesting",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: null,
            replyTo: "msg-intent-failure"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /fallback chat reply/);

    const audit = persistence.db
      .prepare("SELECT tool_name, status, detail FROM tool_execution_audit WHERE message_id = ?")
      .get("msg-intent-failure") as { tool_name: string; status: string; detail: string | null };

    assert.equal(audit.tool_name, "conversation-intent");
    assert.equal(audit.status, "failed");
    assert.match(audit.detail ?? "", /bad classifier output/);
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
    async inferAddressedToolDecision() {
      return {
        route: "hosted",
        powerStatus: "engaged",
        decision: {
          addressed: false,
          reason: "the message is not clearly directed to Dot"
        }
      };
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
          repliedToMessageId: null,
          repliedToBot: false,
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

    const auditRow = persistence.db
      .prepare<[string], { addressed: number | null; addressedReason: string | null }>(
        "SELECT addressed, addressed_reason AS addressedReason FROM access_audit WHERE message_id = ?"
      )
      .get("msg-unaddressed-non-owner");

    assert.equal(auditRow?.addressed, 0);
    assert.equal(auditRow?.addressedReason, "llm_not_addressed");
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline can use LLM addressedness inference to start reminder intake for an ambiguous owner request", async () => {
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
      throw new Error("owner reminder requests should not fall back to plain chat");
    },
    async inferAddressedToolDecision() {
      return {
        route: "hosted",
        powerStatus: "engaged",
        decision: {
          addressed: true,
          decision: "execute_tool",
          toolName: "reminder.add",
          reason: "the user is asking Dot to create a reminder but did not provide full details",
          confidence: "high",
          args: {}
        }
      };
    },
    async inferToolDecision() {
      throw new Error("ambiguous addressedness path should not call the regular intent classifier a second time");
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
          messageId: "msg-ambiguous-reminder",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "I want another reminder set",
          addressedContent: "I want another reminder set",
          isDirectMessage: false,
          mentionedBot: false,
          repliedToMessageId: null,
          repliedToBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-ambiguous-reminder"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /Let me fire up that intake form/i);
    assert.match(outbound[0]?.payload.content ?? "", /What should the reminder say\?/i);

    const auditRow = persistence.db
      .prepare<[string], { addressed: number | null; addressedReason: string | null }>(
        "SELECT addressed, addressed_reason AS addressedReason FROM access_audit WHERE message_id = ?"
      )
      .get("msg-ambiguous-reminder");

    assert.equal(auditRow?.addressed, 1);
    assert.equal(auditRow?.addressedReason, "llm_addressed");
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline routes addressed conversational responses through normal owner chat generation", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  let ownerReplyCalls = 0;
  const chatService: ChatService = {
    async generateOwnerReply({ userMessage }) {
      ownerReplyCalls += 1;
      assert.equal(userMessage, "who's ass are we punching? Dot?");
      return { route: "local", powerStatus: "standby", reply: "Well now, honey, slow down and tell me what you're asking." };
    },
    async inferAddressedToolDecision() {
      return {
        route: "hosted",
        powerStatus: "engaged",
        decision: {
          addressed: true,
          decision: "respond",
          reason: "the user is talking to Dot conversationally",
          response: "I am Dot, your assistant. Generic classifier text."
        }
      };
    },
    async inferToolDecision() {
      throw new Error("addressed conversational responses should not invoke regular tool inference");
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
          messageId: "msg-ambiguous-chat",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "who's ass are we punching? Dot?",
          addressedContent: "who's ass are we punching? Dot?",
          isDirectMessage: false,
          mentionedBot: false,
          repliedToMessageId: null,
          repliedToBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-ambiguous-chat"
          }
        }
      })
    );

    assert.equal(ownerReplyCalls, 1);
    assert.equal(outbound.length, 1);
    assert.equal(
      outbound[0]?.payload.content,
      "Well now, honey, slow down and tell me what you're asking.\n\n[mode: normal]"
    );

    const auditRow = persistence.db
      .prepare<[string], { addressed: number | null; addressedReason: string | null }>(
        "SELECT addressed, addressed_reason AS addressedReason FROM access_audit WHERE message_id = ?"
      )
      .get("msg-ambiguous-chat");

    assert.equal(auditRow?.addressed, 1);
    assert.equal(auditRow?.addressedReason, "llm_addressed");
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline treats short confirmation replies as addressed when a pending reminder session exists", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const reminderDueAt = futureIso(24);
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  const chatService: ChatService = {
    async generateOwnerReply() {
      throw new Error("pending reminder confirmation should not fall back to chat");
    },
    async inferAddressedToolDecision() {
      throw new Error("pending reminder confirmation should use the deterministic pending-session fast path");
    },
    async inferToolDecision() {
      throw new Error("pending reminder confirmation should not invoke fresh tool inference");
    },
    getPowerStatus() {
      return "standby";
    },
    async renderToolResult() {
      throw new Error("reminder confirmations should use deterministic final text");
    }
  };

  persistence.settings.set("onboarding.completed", "true");
  persistence.savePendingConversationalToolSession({
    conversationId: "channel-1",
    toolName: "reminder.add",
    args: {
      message: "walk the dog",
      dueAt: reminderDueAt
    },
    originalUserMessage: "set a reminder to walk the dog",
    pendingStatus: "requires_confirmation",
    pendingPrompt: "Want me to save it?",
    sessionState: {
      engine: "reminder.add.intake",
      step: "confirm",
      data: {
        message: "walk the dog",
        scheduleMode: "specific",
        dueAt: reminderDueAt
      }
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: futureIso(1)
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
        payload: {
          messageId: "msg-reminder-confirm-yes",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "yes",
          addressedContent: "yes",
          isDirectMessage: false,
          mentionedBot: false,
          repliedToMessageId: null,
          repliedToBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-reminder-confirm-yes"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /Saved reminder #1/i);

    const reminders = persistence.db
      .prepare<[], { message: string; dueAt: string }>("SELECT message, due_at AS dueAt FROM reminders ORDER BY id ASC")
      .all();
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0]?.message, "walk the dog");
    assert.equal(reminders[0]?.dueAt, reminderDueAt);

    const auditRow = persistence.db
      .prepare<[string], { addressed: number | null; addressedReason: string | null }>(
        "SELECT addressed, addressed_reason AS addressedReason FROM access_audit WHERE message_id = ?"
      )
      .get("msg-reminder-confirm-yes");

    assert.equal(auditRow?.addressed, 1);
    assert.equal(auditRow?.addressedReason, "active_pending_tool_session");
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

test("message pipeline routes news preference commands deterministically", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const unsubscribe = registerMessagePipeline({
    bus,
    calendarClient: {
      async listUpcomingEvents() {
        return [];
      }
    },
    chatService: {
      async generateOwnerReply() {
        throw new Error("news preference commands should not invoke chat");
      },
      async inferToolDecision() {
        throw new Error("news preference commands should not invoke inference");
      },
      getPowerStatus() {
        return "standby";
      }
    } as never,
    logger: createLogger() as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  bus.subscribeOutboundMessage(async (event) => {
    outbound.push(event);
  });

  try {
    persistence.settings.set("onboarding.completed", "true");
    await bus.publishInboundMessage(
      inboundEvent({
        payload: {
          messageId: "msg-news-prefs",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "!news prefs add preferred Reuters",
          addressedContent: "!news prefs add preferred Reuters",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-news-prefs"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /Saved `reuters`/);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline executes inferred news.briefing and records briefing audit detail", async () => {
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
      throw new Error("news briefing should not fall back to normal chat");
    },
    async renderToolResult(params) {
      assert.equal((params.payload.selectedSources as string[])[0], "newsdata");
      return {
        route: "local",
        powerStatus: "standby",
        reply: "Well, deary, here are the main headlines.\n1. According to Reuters, Myanmar's junta extended emergency rule.\n\nLinks:\n- https://example.test/myanmar"
      };
    },
    async inferToolDecision() {
      return {
        route: "local",
        powerStatus: "standby",
        decision: {
          decision: "execute_tool",
          toolName: "news.briefing",
          reason: "owner asked for a briefing",
          confidence: "high",
          args: {
            query: "give me the latest headlines"
          }
        }
      };
    },
    getPowerStatus() {
      return "standby";
    }
  };

  persistence.settings.set("onboarding.completed", "true");
  persistence.settings.set(
    "news.preferences",
    JSON.stringify({
      interestedTopics: ["myanmar"],
      uninterestedTopics: [],
      preferredOutlets: ["reuters"],
      blockedOutlets: []
    })
  );
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
    persistence,
    worldLookupAdapters: {
      newsdata: {
        source: "newsdata",
        async lookup() {
          return {
            source: "newsdata",
            evidence: [
              {
                source: "newsdata",
                title: "Myanmar junta extends emergency rule",
                url: "https://example.test/myanmar",
                snippet: "Reuters reports the military government extended emergency rule.",
                publishedAt: "2026-04-11T08:00:00Z",
                publisher: "Reuters",
                confidence: "high"
              }
            ]
          };
        }
      },
      wikimedia_current_events: {
        source: "wikimedia_current_events",
        async lookup() {
          return { source: "wikimedia_current_events", evidence: [] };
        }
      },
      gdelt: {
        source: "gdelt",
        async lookup() {
          return { source: "gdelt", evidence: [] };
        }
      }
    }
  });

  try {
    await bus.publishInboundMessage(
      inboundEvent({
        payload: {
          messageId: "msg-news-briefing",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "give me the latest headlines",
          addressedContent: "give me the latest headlines",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-news-briefing"
          }
        }
      })
    );

    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.payload.content ?? "", /main headlines/i);
    const audit = persistence.db
      .prepare("SELECT tool_name, detail FROM tool_execution_audit WHERE message_id = ?")
      .get("msg-news-briefing") as { tool_name: string; detail: string | null };
    assert.equal(audit.tool_name, "news.briefing");
    assert.match(audit.detail ?? "", /candidateCount=/);
    assert.match(audit.detail ?? "", /preferenceCounts=interested:1/);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline resolves an inferred news follow-up against the latest saved briefing session", async () => {
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
      throw new Error("news follow-up should not fall back to normal chat");
    },
    async renderToolResult(params) {
      if (params.payload.mode === "news_briefing") {
        const evidence = params.payload.evidence as Array<{ title: string }>;
        return {
          route: "local",
          powerStatus: "standby",
          reply: `Here are the headlines.\n1. According to AP, ${evidence[0]?.title}\n2. According to Reuters, ${evidence[1]?.title}`
        };
      }

      assert.equal((params.payload.selectedItem as { ordinal: number }).ordinal, 2);
      return {
        route: "local",
        powerStatus: "standby",
        reply: "According to Reuters, Myanmar's military government extended emergency rule.\n\nLinks:\n- https://example.test/myanmar"
      };
    },
    async inferToolDecision(userMessage) {
      if (/latest headlines/i.test(userMessage)) {
        return {
          route: "local",
          powerStatus: "standby",
          decision: {
            decision: "execute_tool",
            toolName: "news.briefing",
            reason: "owner asked for a briefing",
            confidence: "high",
            args: {
              query: userMessage
            }
          }
        };
      }

      return {
        route: "local",
        powerStatus: "standby",
        decision: {
          decision: "execute_tool",
          toolName: "news.follow_up",
          reason: "owner is referring back to a story from the latest news list",
          confidence: "high",
          args: {
            query: userMessage
          }
        }
      };
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
    persistence,
    worldLookupAdapters: {
      newsdata: {
        source: "newsdata",
        async lookup() {
          return {
            source: "newsdata",
            evidence: [
              {
                source: "newsdata",
                title: "Global markets react to tariff threat",
                url: "https://example.test/markets",
                snippet: "Investors reacted sharply across Asia and Europe.",
                publishedAt: "2026-04-11T06:00:00Z",
                publisher: "AP",
                confidence: "high"
              },
              {
                source: "newsdata",
                title: "Myanmar junta extends emergency rule",
                url: "https://example.test/myanmar",
                snippet: "Reuters reports the military government extended emergency rule.",
                publishedAt: "2026-04-11T08:00:00Z",
                publisher: "Reuters",
                confidence: "high"
              }
            ]
          };
        }
      },
      wikimedia_current_events: {
        source: "wikimedia_current_events",
        async lookup() {
          return { source: "wikimedia_current_events", evidence: [] };
        }
      },
      gdelt: {
        source: "gdelt",
        async lookup() {
          return { source: "gdelt", evidence: [] };
        }
      }
    }
  });

  try {
    await bus.publishInboundMessage(
      inboundEvent({
        payload: {
          messageId: "msg-news-briefing-seed",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "give me the latest headlines",
          addressedContent: "give me the latest headlines",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-news-briefing-seed"
          }
        }
      })
    );

    await bus.publishInboundMessage(
      inboundEvent({
        payload: {
          messageId: "msg-news-follow-up",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "tell me more about the second one",
          addressedContent: "tell me more about the second one",
          isDirectMessage: true,
          mentionedBot: false,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-news-follow-up"
          }
        }
      })
    );

    assert.equal(outbound.length, 2);
    assert.match(outbound[1]?.payload.content ?? "", /According to Reuters/i);
    const audit = persistence.db
      .prepare("SELECT tool_name, detail FROM tool_execution_audit WHERE message_id = ?")
      .get("msg-news-follow-up") as { tool_name: string; detail: string | null };
    assert.equal(audit.tool_name, "news.follow_up");
    assert.match(audit.detail ?? "", /newsSession=resolved/);
    assert.match(audit.detail ?? "", /ordinal=2/);
  } finally {
    unsubscribe();
    cleanup();
  }
});

test("message pipeline logs intent debug traces even when raw model output is missing", async () => {
  const { persistence, cleanup } = createPersistence();
  const bus = createInMemoryEventBus();
  const outbound: OutboundMessageRequestedEvent[] = [];
  const calendarClient: OutlookCalendarClient = {
    async listUpcomingEvents() {
      return [];
    }
  };
  const capturedLogger = createCapturingLogger();
  const chatService: ChatService = {
    async generateOwnerReply() {
      throw new Error("tool execution should not fall back to chat");
    },
    async inferToolDecision() {
      return {
        route: "hosted",
        powerStatus: "engaged",
        promptMessages: [
          { role: "system", content: "tool intent prompt" },
          { role: "user", content: "@Dot remind me to stretch" }
        ],
        decision: {
          decision: "execute_tool",
          toolName: "reminder.add",
          reason: "owner asked to create a reminder",
          confidence: "high",
          args: {
            message: "stretch"
          }
        }
      };
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
    logger: capturedLogger.logger as never,
    outlookOAuthClient: {} as never,
    ownerUserId: "owner-1",
    persistence
  });

  try {
    await bus.publishInboundMessage(
      inboundEvent({
        payload: {
          messageId: "msg-reminder-debug",
          sender: {
            actorId: "owner-1",
            displayName: "tan",
            actorRole: "owner"
          },
          content: "@Dot remind me to stretch",
          addressedContent: "@Dot remind me to stretch",
          isDirectMessage: false,
          mentionedBot: true,
          replyRoute: {
            transport: "discord",
            channelId: "channel-1",
            guildId: "guild-1",
            replyTo: "msg-reminder-debug"
          }
        }
      })
    );

    const trace = capturedLogger.entries.find((entry) => entry.message === "Intent classification debug trace");
    assert.ok(trace);
    assert.equal((trace.payload as { rawModelOutputPresent: boolean }).rawModelOutputPresent, false);
    assert.equal((trace.payload as { rawModelOutput: null }).rawModelOutput, null);
    assert.deepEqual(
      (trace.payload as { promptMessages: Array<{ role: string; content: string }> }).promptMessages,
      [
        { role: "system", content: "tool intent prompt" },
        { role: "user", content: "@Dot remind me to stretch" }
      ]
    );
    assert.equal(
      (trace.payload as { parsedDecision: { toolName: string } }).parsedDecision.toolName,
      "reminder.add"
    );
    assert.equal(outbound.length, 1);
  } finally {
    unsubscribe();
    cleanup();
  }
});
