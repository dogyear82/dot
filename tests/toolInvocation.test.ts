import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initializePersistence } from "../src/persistence.js";
import { executeToolDecision, parseExplicitToolDecision, parseToolDecision } from "../src/toolInvocation.js";

function createPersistence() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-tool-invoke-"));
  const sqlitePath = path.join(tempDir, "dot.sqlite");
  const persistence = initializePersistence(tempDir, sqlitePath);

  return {
    persistence,
    cleanup() {
      persistence.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

test("parseToolDecision accepts respond and execute_tool responses", () => {
  assert.deepEqual(parseToolDecision('{"decision":"respond","reason":"just chatting","response":"Hey there."}'), {
    decision: "respond",
    reason: "just chatting",
    response: "Hey there."
  });

  assert.deepEqual(
    parseToolDecision(
      '{"decision":"execute_tool","toolName":"reminder.add","reason":"clear reminder intent","confidence":"high","args":{"duration":"10m","message":"stretch"}}'
    ),
    {
      decision: "execute_tool",
      toolName: "reminder.add",
      reason: "clear reminder intent",
      confidence: "high",
      args: {
        duration: "10m",
        message: "stretch"
      }
    }
  );
});

test("parseExplicitToolDecision turns incomplete tool commands into clarification prompts", () => {
  assert.deepEqual(parseExplicitToolDecision("!reminder add"), {
    decision: "clarify",
    toolName: "reminder.add",
    reason: "owner used reminder add without both duration and message",
    question: "When should I remind you, and what should I remind you about?"
  });

  assert.deepEqual(parseExplicitToolDecision("!calendar remind"), {
    decision: "clarify",
    toolName: "calendar.remind",
    reason: "owner used calendar remind without an event index",
    question: "Which calendar event should I create a reminder for? Use the index from `!calendar show`."
  });
});

test("executeToolDecision runs deterministic reminder and calendar handlers", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reminderReply = await executeToolDecision({
      calendarClient: {
        async listUpcomingEvents() {
          return [];
        }
      },
      decision: {
        decision: "execute",
        toolName: "reminder.add",
        reason: "owner asked to remember something",
        args: {
          duration: "10m",
          message: "stretch"
        }
      },
      persistence
    });

    assert.equal(reminderReply.status, "executed");
    assert.match(reminderReply.reply, /Saved reminder #1/);

    const calendarReply = await executeToolDecision({
      calendarClient: {
        async listUpcomingEvents() {
          return [
            {
              id: "evt-1",
              subject: "Planning",
              startAt: "2027-04-08T10:00:00.000Z",
              endAt: "2027-04-08T11:00:00.000Z",
              webLink: null
            }
          ];
        }
      },
      decision: {
        decision: "execute",
        toolName: "calendar.remind",
        reason: "owner wants a pre-meeting reminder",
        args: {
          index: 1,
          leadTime: "15m"
        }
      },
      persistence
    });

    assert.equal(calendarReply.status, "executed");
    assert.match(calendarReply.reply, /Saved reminder #2/);
  } finally {
    cleanup();
  }
});

test("executeToolDecision can defer or block a registered tool through the policy engine", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.upsertContact({
      canonicalName: "Michelle Smith",
      trustLevel: "approval_required",
      aliases: ["Shelly"]
    });

    const requiresConfirmation = await executeToolDecision({
      calendarClient: {
        async listUpcomingEvents() {
          return [];
        }
      },
      decision: {
        decision: "execute",
        toolName: "reminder.show",
        reason: "test policy hook",
        args: {
          contact: "Shelly"
        }
      },
      persistence,
      registry: {
        "reminder.show": {
          toolName: "reminder.show",
          policy: {
            actionType: "message.send",
            getContactQuery(args) {
              return typeof args.contact === "string" ? args.contact : null;
            }
          },
          execute() {
            return "should not execute";
          }
        }
      }
    });

    assert.equal(requiresConfirmation.status, "requires_confirmation");
    assert.match(requiresConfirmation.reply, /requires explicit approval/i);

    persistence.upsertContact({
      canonicalName: "Mallory",
      trustLevel: "untrusted"
    });

    const blocked = await executeToolDecision({
      calendarClient: {
        async listUpcomingEvents() {
          return [];
        }
      },
      decision: {
        decision: "execute",
        toolName: "reminder.show",
        reason: "test policy hook",
        args: {
          contact: "Mallory"
        }
      },
      persistence,
      registry: {
        "reminder.show": {
          toolName: "reminder.show",
          policy: {
            actionType: "message.send",
            getContactQuery(args) {
              return typeof args.contact === "string" ? args.contact : null;
            }
          },
          execute() {
            return "should not execute";
          }
        }
      }
    });

    assert.equal(blocked.status, "blocked");
    assert.match(blocked.reply, /execution blocked/i);
  } finally {
    cleanup();
  }
});

test("executeToolDecision executes world.lookup and returns grounded reply metadata", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const result = await executeToolDecision({
      calendarClient: {
        async listUpcomingEvents() {
          return [];
        }
      },
      decision: {
        decision: "execute",
        toolName: "world.lookup",
        reason: "owner wants public facts",
        args: {
          query: "When is zebra mating season?"
        }
      },
      persistence,
      groundedAnswerService: {
        async generateGroundedReply(params) {
          assert.equal(params.bucket, "reference");
          assert.equal(params.selectedSources[0], "wikipedia");
          assert.equal(params.evidence[0]?.title, "Zebra");
          assert.deepEqual(params.articles, []);
          return {
            route: "local",
            powerStatus: "standby",
            reply: "According to Wikipedia, zebras breed seasonally.\n\nLinks:\n- https://en.wikipedia.org/wiki/Zebra"
          };
        }
      },
      worldLookupAdapters: {
        wikipedia: {
          source: "wikipedia",
          async lookup() {
            return {
              source: "wikipedia",
              evidence: [
                {
                  source: "wikipedia",
                  title: "Zebra",
                  url: "https://en.wikipedia.org/wiki/Zebra",
                  snippet: "Zebras breed seasonally.",
                  publishedAt: null,
                  confidence: "high"
                }
              ]
            };
          }
        }
      }
    });

    assert.equal(result.status, "executed");
    assert.equal(result.route, "local");
    assert.match(result.reply, /According to Wikipedia/i);
    assert.match(result.detail ?? "", /selectedSources=wikipedia/);
    assert.match(result.detail ?? "", /outcome=success/);
  } finally {
    cleanup();
  }
});

test("executeToolDecision saves topical current-events lookups for follow-up exploration", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const result = await executeToolDecision({
      calendarClient: {
        async listUpcomingEvents() {
          return [];
        }
      },
      conversationId: "channel-topic",
      decision: {
        decision: "execute",
        toolName: "world.lookup",
        reason: "owner wants topic news",
        args: {
          query: "what's the latest on OpenAI?"
        }
      },
      persistence,
      groundedAnswerService: {
        async generateGroundedReply() {
          return {
            route: "hosted",
            powerStatus: "engaged",
            reply: "According to Reuters and AP, OpenAI is expanding its enterprise push.\n\nLinks:\n- https://example.test/openai-1"
          };
        }
      },
      articleReader: {
        async read() {
          return {
            articles: [
              {
                source: "newsdata",
                title: "OpenAI expands enterprise sales",
                url: "https://example.test/openai-1",
                publisher: "Reuters",
                publishedAt: "2026-04-13T09:00:00Z",
                excerpt: "OpenAI expanded its enterprise sales effort and signed new platform customers."
              }
            ],
            failures: []
          };
        }
      },
      worldLookupAdapters: {
        newsdata: {
          source: "newsdata",
          async lookup() {
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

    const session = persistence.getLatestNewsBrowseSession("channel-topic");
    assert.equal(result.status, "executed");
    assert.equal(session?.kind, "topic_lookup");
    assert.equal(session?.query, "what's the latest on OpenAI?");
    assert.equal(session?.items.length, 2);
    assert.equal(session?.items[0]?.publisher, "Reuters");
    assert.match(result.detail ?? "", /topicSessionSaved=yes/);
    assert.match(result.detail ?? "", /retrievalStrategy=current_events_topic_ranked/);
  } finally {
    cleanup();
  }
});

test("executeToolDecision reads selected current-events articles before grounded synthesis", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const result = await executeToolDecision({
      calendarClient: {
        async listUpcomingEvents() {
          return [];
        }
      },
      decision: {
        decision: "execute",
        toolName: "world.lookup",
        reason: "owner wants current events",
        args: {
          query: "What is happening in Myanmar right now?"
        }
      },
      persistence,
      groundedAnswerService: {
        async generateGroundedReply(params) {
          assert.equal(params.bucket, "current_events");
          assert.equal(params.articles?.length, 1);
          assert.equal(params.articles?.[0]?.publisher, "Reuters");
          assert.match(params.articles?.[0]?.excerpt ?? "", /military government extended emergency rule/i);
          return {
            route: "local",
            powerStatus: "standby",
            reply: "According to Reuters, Myanmar remains under military rule.\n\nLinks:\n- https://example.test/myanmar"
          };
        }
      },
      articleReader: {
        async read() {
          return {
            articles: [
              {
                source: "newsdata",
                title: "Myanmar junta extends emergency rule",
                url: "https://example.test/myanmar",
                publisher: "Reuters",
                publishedAt: "2026-04-11T08:00:00Z",
                excerpt: "Myanmar's military government extended emergency rule while conflict continued across several regions."
              }
            ],
            failures: []
          };
        }
      },
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
                  snippet: "Recent reporting from Reuters.",
                  publishedAt: "2026-04-11T08:00:00Z",
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

    assert.equal(result.status, "executed");
    assert.match(result.detail ?? "", /articleReadCount=1/);
    assert.match(result.detail ?? "", /articleTitles=Myanmar junta extends emergency rule/);
  } finally {
    cleanup();
  }
});

test("executeToolDecision executes news.briefing and returns briefing metadata", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.settings.set(
      "news.preferences",
      JSON.stringify({
        interestedTopics: ["myanmar"],
        uninterestedTopics: [],
        preferredOutlets: ["reuters"],
        blockedOutlets: []
      })
    );

    const result = await executeToolDecision({
      calendarClient: {
        async listUpcomingEvents() {
          return [];
        }
      },
      decision: {
        decision: "execute",
        toolName: "news.briefing",
        reason: "owner wants a briefing",
        args: {
          query: "give me the latest headlines"
        }
      },
      persistence,
      groundedAnswerService: {
        async generateGroundedReply() {
          throw new Error("news briefing should not use grounded QA");
        },
        async generateNewsBriefingReply(params) {
          assert.equal(params.evidence.length, 2);
          assert.match(params.evidence[0]?.rankingSignals?.join(",") ?? "", /interested:myanmar/);
          return {
            route: "local",
            powerStatus: "standby",
            reply: "Well, deary, here are the main headlines.\n1. According to Reuters, Myanmar's junta extended emergency rule.\n\nLinks:\n- https://example.test/myanmar"
          };
        }
      },
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
                },
                {
                  source: "newsdata",
                  title: "Global markets react to tariff threat",
                  url: "https://example.test/markets",
                  snippet: "Investors reacted sharply across Asia and Europe.",
                  publishedAt: "2026-04-11T06:00:00Z",
                  publisher: "AP",
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

    assert.equal(result.status, "executed");
    assert.equal(result.route, "local");
    assert.match(result.detail ?? "", /preferenceCounts=interested:1/);
    assert.match(result.detail ?? "", /chosenEvidence=/);
  } finally {
    cleanup();
  }
});

test("executeToolDecision resolves a saved news session and follows up on an ordinal reference", async () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.saveNewsBrowseSession({
      kind: "briefing",
      conversationId: "channel-1",
      query: "give me the latest headlines",
      savedAt: "2026-04-13T00:00:00Z",
      items: [
        {
          ordinal: 1,
          title: "Global markets react to tariff threat",
          url: "https://example.test/markets",
          source: "newsdata",
          publisher: "AP",
          snippet: "Investors reacted sharply across Asia and Europe.",
          publishedAt: "2026-04-13T00:00:00Z"
        },
        {
          ordinal: 2,
          title: "Myanmar junta extends emergency rule",
          url: "https://example.test/myanmar",
          source: "newsdata",
          publisher: "Reuters",
          snippet: "Reuters reports the military government extended emergency rule.",
          publishedAt: "2026-04-13T01:00:00Z"
        }
      ]
    });

    const result = await executeToolDecision({
      calendarClient: {
        async listUpcomingEvents() {
          return [];
        }
      },
      conversationId: "channel-1",
      decision: {
        decision: "execute",
        toolName: "news.follow_up",
        reason: "owner is referring back to a story from the latest news list",
        args: {
          query: "tell me more about the second one"
        }
      },
      persistence,
      groundedAnswerService: {
        async generateGroundedReply() {
          throw new Error("news follow-up should not use grounded QA");
        },
        async generateStoryFollowUpReply(params) {
          assert.equal(params.selectedItem.ordinal, 2);
          assert.equal(params.selectedItem.publisher, "Reuters");
          assert.match(params.articles?.[0]?.excerpt ?? "", /military government extended emergency rule/i);
          return {
            route: "local",
            powerStatus: "standby",
            reply: "According to Reuters, Myanmar's military government extended emergency rule again.\n\nLinks:\n- https://example.test/myanmar"
          };
        }
      },
      articleReader: {
        async read() {
          return {
            articles: [
              {
                source: "newsdata",
                title: "Myanmar junta extends emergency rule",
                url: "https://example.test/myanmar",
                publisher: "Reuters",
                publishedAt: "2026-04-13T01:00:00Z",
                excerpt: "Myanmar's military government extended emergency rule again while fighting persisted."
              }
            ],
            failures: []
          };
        }
      }
    });

    assert.equal(result.status, "executed");
    assert.equal(result.route, "local");
    assert.match(result.detail ?? "", /newsSession=resolved/);
    assert.match(result.detail ?? "", /ordinal=2/);
  } finally {
    cleanup();
  }
});
