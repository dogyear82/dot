import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { startObservability } from "../src/observability.js";
import { classifyWorldLookupQuery, createWorldLookupEvidence, executeWorldLookup, selectWorldLookupSourcePlan } from "../src/worldLookup.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}

test("classifyWorldLookupQuery maps representative prompts into deterministic buckets", () => {
  assert.equal(classifyWorldLookupQuery("When is zebra mating season?"), "reference");
  assert.equal(classifyWorldLookupQuery("What's the weather in Phoenix tomorrow?"), "weather");
  assert.equal(classifyWorldLookupQuery("How is Argentina's economy doing?"), "economics");
  assert.equal(classifyWorldLookupQuery("What is happening in Myanmar right now?"), "current_events");
  assert.equal(classifyWorldLookupQuery("what’s going on in ukraine"), "current_events");
  assert.equal(classifyWorldLookupQuery("What's the latest weather and economic outlook for Japan?"), "mixed");
});

test("selectWorldLookupSourcePlan returns explicit source plans per bucket", () => {
  assert.deepEqual(selectWorldLookupSourcePlan("reference"), {
    bucket: "reference",
    sources: ["wikipedia"],
    timeoutMs: 4000
  });

  assert.deepEqual(selectWorldLookupSourcePlan("current_events"), {
    bucket: "current_events",
    sources: ["newsdata", "gdelt"],
    timeoutMs: 4000
  });
});

test("executeWorldLookup uses NewsData only for generic headline briefings", async () => {
  const touched: string[] = [];

  const result = await executeWorldLookup({
    query: "give me the latest headlines",
    timeoutMs: 100,
    adapters: {
      newsdata: {
        source: "newsdata",
        async lookup() {
          touched.push("newsdata");
          return {
            source: "newsdata",
            evidence: [
              createWorldLookupEvidence({
                source: "newsdata",
                title: "Global markets react to tariff threat",
                url: "https://example.test/newsdata-1",
                snippet: "Investors reacted sharply across Asia and Europe.",
                publishedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
                confidence: "high"
              })
            ]
          };
        }
      },
      gdelt: {
        source: "gdelt",
        async lookup() {
          touched.push("gdelt");
          return { source: "gdelt", evidence: [] };
        }
      }
    }
  });

  assert.deepEqual(touched, ["newsdata"]);
  assert.deepEqual(result.selectedSources, ["newsdata"]);
  assert.equal(result.outcome, "success");
});

test("executeWorldLookup runs selected sources in parallel and tolerates partial failure", async () => {
  const started: string[] = [];
  const completed: string[] = [];

  const result = await executeWorldLookup({
    query: "What is happening in Myanmar right now?",
    timeoutMs: 100,
    adapters: {
      newsdata: {
        source: "newsdata",
        async lookup() {
          started.push("newsdata");
          await new Promise((resolve) => setTimeout(resolve, 20));
          completed.push("newsdata");
          return {
            source: "newsdata",
            evidence: [
              createWorldLookupEvidence({
                source: "newsdata",
                title: "Myanmar current events",
                url: "https://example.test/newsdata",
                snippet: "Recent events summary for Myanmar"
              })
            ]
          };
        }
      },
      gdelt: {
        source: "gdelt",
        async lookup() {
          started.push("gdelt");
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error("gdelt unavailable");
        }
      }
    }
  });

  assert.deepEqual(started.sort(), ["gdelt", "newsdata"]);
  assert.deepEqual(completed, ["newsdata"]);
  assert.equal(result.bucket, "current_events");
  assert.deepEqual(result.selectedSources, ["newsdata", "gdelt"]);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.retrievalStrategy, "current_events_topic_ranked");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.source, "gdelt");
  assert.equal(result.outcome, "partial_failure");
});

test("executeWorldLookup honors an explicit bucket override instead of reclassifying the query text", async () => {
  const touched: string[] = [];

  const result = await executeWorldLookup({
    query: "Hormuz Strait situation April 2026",
    bucket: "current_events",
    timeoutMs: 100,
    adapters: {
      newsdata: {
        source: "newsdata",
        async lookup() {
          touched.push("newsdata");
          return {
            source: "newsdata",
            evidence: [
              createWorldLookupEvidence({
                source: "newsdata",
                title: "Shipping insurers raise rates after Hormuz disruption",
                url: "https://example.test/hormuz-newsdata",
                snippet: "Tanker traffic slows after renewed regional tensions.",
                publishedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
                confidence: "high"
              })
            ]
          };
        }
      },
      gdelt: {
        source: "gdelt",
        async lookup() {
          touched.push("gdelt");
          return {
            source: "gdelt",
            evidence: []
          };
        }
      },
      wikipedia: {
        source: "wikipedia",
        async lookup() {
          touched.push("wikipedia");
          return {
            source: "wikipedia",
            evidence: [
              createWorldLookupEvidence({
                source: "wikipedia",
                title: "Strait of Hormuz",
                url: "https://example.test/hormuz-wikipedia",
                snippet: "Reference article for the strait."
              })
            ]
          };
        }
      }
    }
  });

  assert.equal(result.bucket, "current_events");
  assert.deepEqual(result.selectedSources, ["newsdata", "gdelt"]);
  assert.deepEqual(touched.sort(), ["gdelt", "newsdata"]);
  assert.equal(result.evidence[0]?.source, "newsdata");
});

test("executeWorldLookup tolerates an unconfigured NewsData adapter while using the remaining current-events sources", async () => {
  const result = await executeWorldLookup({
    query: "What is happening in Myanmar right now?",
    timeoutMs: 100,
    adapters: {
      gdelt: {
        source: "gdelt",
        async lookup() {
          return { source: "gdelt", evidence: [] };
        }
      }
    }
  });

  assert.equal(result.bucket, "current_events");
  assert.deepEqual(result.selectedSources, ["newsdata", "gdelt"]);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.retrievalStrategy, "current_events_topic_ranked");
  assert.equal(result.evidence.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.source, "newsdata");
  assert.equal(result.outcome, "no_evidence");
});

test("executeWorldLookup discards irrelevant current-events evidence that does not match the topic", async () => {
  const result = await executeWorldLookup({
    query: "tell me what the situation is like in Myanmar right now",
    timeoutMs: 100,
    adapters: {
      gdelt: {
        source: "gdelt",
        async lookup() {
          throw new Error("gdelt unavailable");
        }
      }
    }
  });

  assert.equal(result.bucket, "current_events");
  assert.equal(result.candidateCount, 0);
  assert.equal(result.retrievalStrategy, "current_events_topic_ranked");
  assert.equal(result.outcome, "no_evidence");
  assert.deepEqual(result.evidence, []);
  assert.equal(result.failures.length, 2);
  assert.equal(result.failures[0]?.source, "newsdata");
  assert.equal(result.failures[1]?.source, "gdelt");
});

test("executeWorldLookup ranks generic headlines queries by source quality and recency instead of keyword literal matches", async () => {
  const result = await executeWorldLookup({
    query: "give me the latest headlines",
    timeoutMs: 100,
    adapters: {
      newsdata: {
        source: "newsdata",
        async lookup() {
          return {
            source: "newsdata",
            evidence: [
              createWorldLookupEvidence({
                source: "newsdata",
                title: "Global markets react to new tariff threat",
                url: "https://example.test/newsdata-1",
                snippet: "Investors reacted sharply across Asia and Europe.",
                publishedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
                confidence: "high"
              }),
              createWorldLookupEvidence({
                source: "newsdata",
                title: "Flood warnings spread across northern Italy",
                url: "https://example.test/newsdata-2",
                snippet: "Authorities expanded evacuations after overnight rain.",
                publishedAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
                confidence: "high"
              })
            ]
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

  assert.equal(result.bucket, "current_events");
  assert.equal(result.retrievalStrategy, "current_events_generic_ranked");
  assert.equal(result.candidateCount, 2);
  assert.equal(result.outcome, "success");
  assert.equal(result.evidence.length, 2);
  assert.deepEqual(
    result.evidence.map((record) => record.source),
    ["newsdata", "newsdata"]
  );
});

test("executeWorldLookup applies news preference signals without hard filtering by default", async () => {
  const result = await executeWorldLookup({
    query: "give me the latest headlines",
    timeoutMs: 100,
    preferences: {
      interestedTopics: ["myanmar"],
      uninterestedTopics: ["celebrity gossip"],
      preferredOutlets: ["reuters"],
      blockedOutlets: ["fox"]
    },
    adapters: {
      newsdata: {
        source: "newsdata",
        async lookup() {
          return {
            source: "newsdata",
            evidence: [
              createWorldLookupEvidence({
                source: "newsdata",
                title: "Myanmar junta extends emergency rule",
                url: "https://www.reuters.com/world/asia-pacific/myanmar-story",
                snippet: "Reuters reports Myanmar's military government extended emergency rule.",
                publishedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
                publisher: "Reuters",
                confidence: "high"
              }),
              createWorldLookupEvidence({
                source: "newsdata",
                title: "Fox runs celebrity gossip special",
                url: "https://www.foxnews.com/entertainment/gossip-special",
                snippet: "Celebrity gossip dominated the network's entertainment coverage.",
                publishedAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
                publisher: "Fox",
                confidence: "high"
              })
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

  assert.equal(result.evidence.length, 2);
  assert.equal(result.evidence[0]?.title, "Myanmar junta extends emergency rule");
  assert.match(result.evidence[0]?.rankingSignals?.join(",") ?? "", /interested:myanmar/);
  assert.match(result.evidence[0]?.rankingSignals?.join(",") ?? "", /preferred_outlet:reuters/);
  assert.match(result.evidence[1]?.rankingSignals?.join(",") ?? "", /blocked_outlet:fox/);
  assert.match(result.evidence[1]?.rankingSignals?.join(",") ?? "", /uninterested:celebrity gossip/);
});

test("executeWorldLookup reports no_evidence when every selected source fails or returns nothing", async () => {
  const result = await executeWorldLookup({
    query: "What's the weather in Phoenix tomorrow?",
    timeoutMs: 50,
    adapters: {
      open_meteo: {
        source: "open_meteo",
        async lookup() {
          return {
            source: "open_meteo",
            evidence: []
          };
        }
      }
    }
  });

  assert.equal(result.bucket, "weather");
  assert.equal(result.outcome, "no_evidence");
  assert.equal(result.candidateCount, 0);
  assert.equal(result.retrievalStrategy, "default");
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.evidence, []);
});

test("executeWorldLookup emits observability attributes for selected sources and outcomes", async () => {
  const spanExporter = new InMemorySpanExporter();
  const observability = startObservability({
    config: {
      LOG_LEVEL: "info",
      METRICS_HOST: "127.0.0.1",
      METRICS_PORT: 0,
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      OTEL_SERVICE_NAME: "dot-test"
    },
    logger: createLogger() as never,
    testSpanExporter: spanExporter
  });

  try {
    assert(await waitForMetricsUrl(observability, 2000));

    const result = await executeWorldLookup({
      query: "When is zebra mating season?",
      adapters: {
        wikipedia: {
          source: "wikipedia",
          async lookup() {
            return {
              source: "wikipedia",
              evidence: [
                createWorldLookupEvidence({
                  source: "wikipedia",
                  title: "Zebra",
                  url: "https://en.wikipedia.org/wiki/Zebra",
                  snippet: "Zebras breed seasonally."
                })
              ]
            };
          }
        }
      }
    });

    assert.equal(result.outcome, "success");

    const spans = spanExporter.getFinishedSpans();
    const lookupSpan = spans.find((span) => span.name === "world.lookup");
    assert(lookupSpan);
    assert.equal(lookupSpan.attributes["dot.world_lookup.bucket"], "reference");
    assert.equal(lookupSpan.attributes["dot.world_lookup.sources"], "wikipedia");
    assert.equal(lookupSpan.attributes["dot.world_lookup.outcome"], "success");
    assert.equal(lookupSpan.attributes["dot.world_lookup.candidate_count"], 1);
    assert.equal(lookupSpan.attributes["dot.world_lookup.evidence_count"], 1);
    assert.equal(lookupSpan.attributes["dot.world_lookup.failure_count"], 0);
    assert.equal(lookupSpan.attributes["dot.world_lookup.retrieval_strategy"], "default");
  } finally {
    await observability.stop();
  }
});

async function waitForMetricsUrl(
  observability: { getMetricsUrl(): string | null },
  timeoutMs: number
): Promise<string | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const metricsUrl = observability.getMetricsUrl();
    if (metricsUrl) {
      return metricsUrl;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return null;
}
