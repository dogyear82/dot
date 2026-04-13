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
    sources: ["wikimedia_current_events", "gdelt"],
    timeoutMs: 4000
  });
});

test("executeWorldLookup runs selected sources in parallel and tolerates partial failure", async () => {
  const started: string[] = [];
  const completed: string[] = [];

  const result = await executeWorldLookup({
    query: "What is happening in Myanmar right now?",
    timeoutMs: 100,
    adapters: {
      wikimedia_current_events: {
        source: "wikimedia_current_events",
        async lookup() {
          started.push("wikimedia_current_events");
          await new Promise((resolve) => setTimeout(resolve, 20));
          completed.push("wikimedia_current_events");
          return {
            source: "wikimedia_current_events",
            evidence: [
              createWorldLookupEvidence({
                source: "wikimedia_current_events",
                title: "Myanmar current events",
                url: "https://example.test/wikimedia",
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

  assert.deepEqual(started.sort(), ["gdelt", "wikimedia_current_events"]);
  assert.deepEqual(completed, ["wikimedia_current_events"]);
  assert.equal(result.bucket, "current_events");
  assert.deepEqual(result.selectedSources, ["wikimedia_current_events", "gdelt"]);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.source, "gdelt");
  assert.equal(result.outcome, "partial_failure");
});

test("executeWorldLookup discards irrelevant current-events evidence that does not match the topic", async () => {
  const result = await executeWorldLookup({
    query: "tell me what the situation is like in Myanmar right now",
    timeoutMs: 100,
    adapters: {
      wikimedia_current_events: {
        source: "wikimedia_current_events",
        async lookup() {
          return {
            source: "wikimedia_current_events",
            evidence: [
              createWorldLookupEvidence({
                source: "wikimedia_current_events",
                title: "Dalai Lama representative discusses Tibet",
                url: "https://example.test/dalai-lama",
                snippet: "Talks about China, Tibet, Shugden and the next Dalai Lama."
              })
            ]
          };
        }
      },
      gdelt: {
        source: "gdelt",
        async lookup() {
          throw new Error("gdelt unavailable");
        }
      }
    }
  });

  assert.equal(result.bucket, "current_events");
  assert.equal(result.outcome, "no_evidence");
  assert.deepEqual(result.evidence, []);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.source, "gdelt");
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
    assert.equal(lookupSpan.attributes["dot.world_lookup.evidence_count"], 1);
    assert.equal(lookupSpan.attributes["dot.world_lookup.failure_count"], 0);
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
