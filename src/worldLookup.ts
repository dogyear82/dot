import { SpanKind } from "@opentelemetry/api";

import { withSpan } from "./observability.js";
import type {
  WorldLookupAdapterResult,
  WorldLookupEvidenceRecord,
  WorldLookupQueryBucket,
  WorldLookupResult,
  WorldLookupSourceFailure,
  WorldLookupSourceName,
  WorldLookupSourcePlan
} from "./types.js";

const DEFAULT_WORLD_LOOKUP_TIMEOUT_MS = 4_000;

const SOURCE_PLANS: Record<WorldLookupQueryBucket, WorldLookupSourcePlan> = {
  reference: {
    bucket: "reference",
    sources: ["wikipedia"],
    timeoutMs: DEFAULT_WORLD_LOOKUP_TIMEOUT_MS
  },
  current_events: {
    bucket: "current_events",
    sources: ["wikimedia_current_events", "gdelt"],
    timeoutMs: DEFAULT_WORLD_LOOKUP_TIMEOUT_MS
  },
  weather: {
    bucket: "weather",
    sources: ["open_meteo"],
    timeoutMs: DEFAULT_WORLD_LOOKUP_TIMEOUT_MS
  },
  economics: {
    bucket: "economics",
    sources: ["world_bank"],
    timeoutMs: DEFAULT_WORLD_LOOKUP_TIMEOUT_MS
  },
  mixed: {
    bucket: "mixed",
    sources: ["wikipedia", "wikimedia_current_events", "gdelt", "open_meteo", "world_bank"],
    timeoutMs: DEFAULT_WORLD_LOOKUP_TIMEOUT_MS
  }
};

export interface WorldLookupAdapter {
  source: WorldLookupSourceName;
  lookup(params: { query: string; timeoutMs: number }): Promise<WorldLookupAdapterResult>;
}

export function classifyWorldLookupQuery(query: string): WorldLookupQueryBucket {
  const normalized = normalizeQuery(query);

  if (looksLikeMixedQuery(normalized)) {
    return "mixed";
  }

  if (looksLikeWeatherQuery(normalized)) {
    return "weather";
  }

  if (looksLikeEconomicsQuery(normalized)) {
    return "economics";
  }

  if (looksLikeCurrentEventsQuery(normalized)) {
    return "current_events";
  }

  return "reference";
}

export function selectWorldLookupSourcePlan(bucket: WorldLookupQueryBucket): WorldLookupSourcePlan {
  return SOURCE_PLANS[bucket];
}

export async function executeWorldLookup(params: {
  query: string;
  adapters: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
  timeoutMs?: number;
}): Promise<WorldLookupResult> {
  const bucket = classifyWorldLookupQuery(params.query);
  const basePlan = selectWorldLookupSourcePlan(bucket);
  const timeoutMs = params.timeoutMs ?? basePlan.timeoutMs;
  const selectedSources = basePlan.sources;

  return withSpan(
    "world.lookup",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "dot.world_lookup.bucket": bucket,
        "dot.world_lookup.sources": selectedSources.join(","),
        "dot.world_lookup.timeout_ms": timeoutMs
      }
    },
    async (span) => {
      const settled = await Promise.all(
        selectedSources.map(async (source) => {
          const adapter = params.adapters[source];
          if (!adapter) {
            return {
              source,
              status: "rejected" as const,
              reason: "adapter not configured"
            };
          }

          try {
            const result = await promiseWithTimeout(
              adapter.lookup({
                query: params.query,
                timeoutMs
              }),
              timeoutMs,
              source
            );
            return {
              source,
              status: "fulfilled" as const,
              result
            };
          } catch (error) {
            return {
              source,
              status: "rejected" as const,
              reason: error instanceof Error ? error.message : "unknown error"
            };
          }
        })
      );

      const rawEvidence = settled.flatMap((entry) => (entry.status === "fulfilled" ? entry.result.evidence : []));
      const evidence = filterWorldLookupEvidence({
        bucket,
        query: params.query,
        evidence: rawEvidence
      });
      const failures = settled.flatMap((entry) =>
        entry.status === "rejected"
          ? [
              {
                source: entry.source,
                reason: entry.reason
              } satisfies WorldLookupSourceFailure
            ]
          : []
      );

      const outcome =
        evidence.length === 0 ? "no_evidence" : failures.length > 0 ? "partial_failure" : "success";

      span.setAttribute("dot.world_lookup.selected_source_count", selectedSources.length);
      span.setAttribute("dot.world_lookup.evidence_count", evidence.length);
      span.setAttribute("dot.world_lookup.failure_count", failures.length);
      span.setAttribute("dot.world_lookup.outcome", outcome);
      if (failures.length > 0) {
        span.setAttribute("dot.world_lookup.failed_sources", failures.map((failure) => failure.source).join(","));
      }

      return {
        bucket,
        selectedSources,
        evidence,
        failures,
        outcome
      };
    }
  );
}

function filterWorldLookupEvidence(params: {
  bucket: WorldLookupQueryBucket;
  query: string;
  evidence: WorldLookupEvidenceRecord[];
}): WorldLookupEvidenceRecord[] {
  if (params.evidence.length === 0) {
    return params.evidence;
  }

  if (params.bucket === "current_events") {
    return filterCurrentEventsEvidence(params.query, params.evidence);
  }

  if (params.bucket === "mixed") {
    const filteredCurrentEvents = filterCurrentEventsEvidence(
      params.query,
      params.evidence.filter((record) => record.source === "wikimedia_current_events" || record.source === "gdelt")
    );

    const nonCurrentEvents = params.evidence.filter(
      (record) => record.source !== "wikimedia_current_events" && record.source !== "gdelt"
    );

    return [...nonCurrentEvents, ...filteredCurrentEvents];
  }

  return params.evidence;
}

function filterCurrentEventsEvidence(query: string, evidence: WorldLookupEvidenceRecord[]): WorldLookupEvidenceRecord[] {
  const topicTokens = extractTopicTokens(query);
  if (topicTokens.length === 0) {
    return evidence;
  }

  return evidence.filter((record) => {
    const haystack = `${record.title} ${record.snippet}`.toLowerCase();
    return topicTokens.some((token) => haystack.includes(token));
  });
}

function extractTopicTokens(query: string): string[] {
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "are",
    "around",
    "at",
    "be",
    "current",
    "currently",
    "events",
    "for",
    "going",
    "happening",
    "how",
    "i",
    "in",
    "is",
    "it",
    "latest",
    "like",
    "me",
    "news",
    "now",
    "of",
    "on",
    "right",
    "situation",
    "tell",
    "the",
    "this",
    "today",
    "what",
    "whats",
    "with"
  ]);

  return Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !stopwords.has(token))
    )
  );
}

function looksLikeWeatherQuery(normalized: string): boolean {
  return (
    /\b(weather|forecast|temperature|rain|snow|wind|humidity|sunrise|sunset)\b/.test(normalized) ||
    (/\b(today|tomorrow|tonight|this week|weekend)\b/.test(normalized) &&
      /\b(in|for|at)\b/.test(normalized) &&
      /\b(weather|forecast|temperature)\b/.test(normalized))
  );
}

function looksLikeEconomicsQuery(normalized: string): boolean {
  return /\b(gdp|inflation|unemployment|poverty|economy|economic|trade|development|world bank)\b/.test(normalized);
}

function looksLikeCurrentEventsQuery(normalized: string): boolean {
  return (
    /\b(right now|currently|latest|recent|today|this week|breaking)\b/.test(normalized) ||
    /\b(news|headline|headlines|current events|what('?s| is) happening|what('?s| is) going on)\b/.test(normalized)
  );
}

function looksLikeMixedQuery(normalized: string): boolean {
  const categoryMatches = [
    looksLikeWeatherQuery(normalized),
    looksLikeEconomicsQuery(normalized),
    looksLikeCurrentEventsQuery(normalized)
  ].filter(Boolean).length;

  return categoryMatches > 1;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, source: WorldLookupSourceName): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${source} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export function createWorldLookupEvidence(params: {
  source: WorldLookupSourceName;
  title: string;
  url?: string | null;
  snippet: string;
  publishedAt?: string | null;
  confidence?: WorldLookupEvidenceRecord["confidence"];
}): WorldLookupEvidenceRecord {
  return {
    source: params.source,
    title: params.title,
    url: params.url ?? null,
    snippet: params.snippet,
    publishedAt: params.publishedAt ?? null,
    confidence: params.confidence ?? "medium"
  };
}
