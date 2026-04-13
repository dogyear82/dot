import { SpanKind } from "@opentelemetry/api";

import { withSpan } from "./observability.js";
import type {
  NewsPreferences,
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
    sources: ["newsdata", "wikimedia_current_events", "gdelt"],
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
    sources: ["wikipedia", "newsdata", "wikimedia_current_events", "gdelt", "open_meteo", "world_bank"],
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
  preferences?: NewsPreferences;
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
      const candidateCount = rawEvidence.length;
      const { evidence, retrievalStrategy } = filterWorldLookupEvidence({
        bucket,
        query: params.query,
        evidence: rawEvidence,
        preferences: params.preferences
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
      span.setAttribute("dot.world_lookup.candidate_count", candidateCount);
      span.setAttribute("dot.world_lookup.evidence_count", evidence.length);
      span.setAttribute("dot.world_lookup.failure_count", failures.length);
      span.setAttribute("dot.world_lookup.outcome", outcome);
      span.setAttribute("dot.world_lookup.retrieval_strategy", retrievalStrategy);
      if (failures.length > 0) {
        span.setAttribute("dot.world_lookup.failed_sources", failures.map((failure) => failure.source).join(","));
      }
      if (evidence.length > 0) {
        span.setAttribute("dot.world_lookup.selected_evidence_sources", evidence.map((record) => record.source).join(","));
      }

      return {
        bucket,
        selectedSources,
        evidence,
        failures,
        outcome,
        candidateCount,
        retrievalStrategy
      };
    }
  );
}

function filterWorldLookupEvidence(params: {
  bucket: WorldLookupQueryBucket;
  query: string;
  evidence: WorldLookupEvidenceRecord[];
  preferences?: NewsPreferences;
}): Pick<WorldLookupResult, "evidence" | "retrievalStrategy"> {
  if (params.evidence.length === 0) {
    return {
      evidence: params.evidence,
      retrievalStrategy: "default"
    };
  }

  if (params.bucket === "current_events") {
    return filterCurrentEventsEvidence(params.query, params.evidence, params.preferences);
  }

  if (params.bucket === "mixed") {
    const { evidence: filteredCurrentEvents } = filterCurrentEventsEvidence(
      params.query,
      params.evidence.filter(
        (record) =>
          record.source === "newsdata" || record.source === "wikimedia_current_events" || record.source === "gdelt"
      ),
      params.preferences
    );

    const nonCurrentEvents = params.evidence.filter(
      (record) =>
        record.source !== "newsdata" && record.source !== "wikimedia_current_events" && record.source !== "gdelt"
    );

    return {
      evidence: [...nonCurrentEvents, ...filteredCurrentEvents],
      retrievalStrategy: "default"
    };
  }

  return {
    evidence: params.evidence,
    retrievalStrategy: "default"
  };
}

function filterCurrentEventsEvidence(
  query: string,
  evidence: WorldLookupEvidenceRecord[],
  preferences?: NewsPreferences
): Pick<WorldLookupResult, "evidence" | "retrievalStrategy"> {
  const normalizedQuery = normalizeQuery(query);
  const topicTokens = extractTopicTokens(query);
  const genericHeadlinesIntent = looksLikeGenericHeadlinesQuery(normalizedQuery);
  const strategy = genericHeadlinesIntent ? "current_events_generic_ranked" : "current_events_topic_ranked";

  const ranked = evidence
    .map((record) => ({
      record,
      ranking: scoreCurrentEventsEvidence({
        query: normalizedQuery,
        topicTokens,
        genericHeadlinesIntent,
        record,
        preferences
      })
    }))
    .filter(({ ranking }) => ranking.score > 0)
    .sort((left, right) => right.ranking.score - left.ranking.score);

  if (ranked.length === 0) {
    return {
      evidence: [],
      retrievalStrategy: strategy
    };
  }

  const bestScore = ranked[0]?.ranking.score ?? 0;
  const selected = (
    genericHeadlinesIntent
      ? ranked.slice(0, 3)
      : ranked.filter(({ ranking }, index) => index === 0 || (index < 3 && ranking.score >= bestScore - 2)).slice(0, 3)
  ).map(({ record, ranking }) => ({
    ...record,
    rankingSignals: ranking.signals.length > 0 ? ranking.signals : undefined
  }));

  return {
    evidence: selected,
    retrievalStrategy: strategy
  };
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

function looksLikeGenericHeadlinesQuery(normalized: string): boolean {
  return (
    /\b(latest headlines|top headlines|headline|headlines|top news|news today|today('?s)? news)\b/.test(normalized) ||
    /\bwhat('?s| is) in the news\b/.test(normalized)
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
  publisher?: string | null;
  confidence?: WorldLookupEvidenceRecord["confidence"];
}): WorldLookupEvidenceRecord {
  return {
    source: params.source,
    title: params.title,
    url: params.url ?? null,
    snippet: params.snippet,
    publishedAt: params.publishedAt ?? null,
    publisher: params.publisher ?? null,
    confidence: params.confidence ?? "medium"
  };
}

function scoreCurrentEventsEvidence(params: {
  query: string;
  topicTokens: string[];
  genericHeadlinesIntent: boolean;
  record: WorldLookupEvidenceRecord;
  preferences?: NewsPreferences;
}): { score: number; signals: string[] } {
  const haystack = normalizeQuery(`${params.record.title} ${params.record.snippet}`);
  const recencyScore = scoreEvidenceRecency(params.record.publishedAt);
  const sourceScore = scoreCurrentEventsSource(params.record.source);
  const confidenceScore = params.record.confidence === "high" ? 2 : params.record.confidence === "medium" ? 1 : 0;
  const overlapCount = params.topicTokens.filter((token) => haystack.includes(token)).length;
  const preferenceSignals = scoreNewsPreferences(params.record, haystack, params.preferences);

  if (params.genericHeadlinesIntent) {
    return {
      score: sourceScore + recencyScore + confidenceScore + (params.record.url ? 1 : 0) + preferenceSignals.score,
      signals: preferenceSignals.signals
    };
  }

  if (params.topicTokens.length > 0 && overlapCount === 0) {
    return {
      score: -1,
      signals: preferenceSignals.signals
    };
  }

  return {
    score: sourceScore + recencyScore + confidenceScore + overlapCount * 3 + preferenceSignals.score,
    signals: preferenceSignals.signals
  };
}

function scoreCurrentEventsSource(source: WorldLookupSourceName): number {
  switch (source) {
    case "newsdata":
      return 5;
    case "gdelt":
      return 3;
    case "wikimedia_current_events":
      return 1;
    default:
      return 0;
  }
}

function scoreEvidenceRecency(publishedAt: string | null): number {
  if (!publishedAt) {
    return 0;
  }

  const publishedTime = Date.parse(publishedAt);
  if (Number.isNaN(publishedTime)) {
    return 0;
  }

  const ageMs = Date.now() - publishedTime;
  if (ageMs < 0) {
    return 2;
  }

  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 2) {
    return 5;
  }
  if (ageDays <= 7) {
    return 3;
  }
  if (ageDays <= 30) {
    return 1;
  }
  return -4;
}

function scoreNewsPreferences(
  record: WorldLookupEvidenceRecord,
  haystack: string,
  preferences?: NewsPreferences
): { score: number; signals: string[] } {
  if (!preferences) {
    return { score: 0, signals: [] };
  }

  let score = 0;
  const signals: string[] = [];
  const publisher = normalizePublisher(record);

  for (const topic of preferences.interestedTopics) {
    if (haystack.includes(topic)) {
      score += 3;
      signals.push(`interested:${topic}`);
    }
  }

  for (const topic of preferences.uninterestedTopics) {
    if (haystack.includes(topic)) {
      score -= 3;
      signals.push(`uninterested:${topic}`);
    }
  }

  for (const outlet of preferences.preferredOutlets) {
    if (publisher === outlet) {
      score += 4;
      signals.push(`preferred_outlet:${outlet}`);
    }
  }

  for (const outlet of preferences.blockedOutlets) {
    if (publisher === outlet) {
      score -= 6;
      signals.push(`blocked_outlet:${outlet}`);
    }
  }

  return { score, signals };
}

function normalizePublisher(record: WorldLookupEvidenceRecord): string | null {
  const candidate = record.publisher ?? extractPublisherFromUrl(record.url);
  return candidate ? normalizeQuery(candidate) : null;
}

function extractPublisherFromUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }

  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    const labels = hostname.split(".");
    return labels.length >= 2 ? labels[labels.length - 2] ?? null : labels[0] ?? null;
  } catch {
    return null;
  }
}
