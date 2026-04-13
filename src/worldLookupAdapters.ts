import { z } from "zod";

import { createWorldLookupEvidence, type WorldLookupAdapter } from "./worldLookup.js";
import type { WorldLookupAdapterResult, WorldLookupEvidenceRecord, WorldLookupSourceName } from "./types.js";

const WIKIPEDIA_SEARCH_URL = "https://en.wikipedia.org/w/api.php";
const WIKINEWS_SEARCH_URL = "https://en.wikinews.org/w/api.php";
const GDELT_DOC_API_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const OPEN_METEO_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const WORLD_BANK_COUNTRIES_URL = "https://api.worldbank.org/v2/country";
const WORLD_BANK_INDICATOR_TEMPLATE = "https://api.worldbank.org/v2/country/{country}/indicator/{indicator}";

const wikipediaSearchResponseSchema = z.object({
  query: z
    .object({
      search: z
        .array(
          z.object({
            title: z.string(),
            snippet: z.string().optional().default(""),
            timestamp: z.string().optional().nullable()
          })
        )
        .optional()
        .default([])
    })
    .optional()
    .default({ search: [] })
});

const gdeltResponseSchema = z.object({
  articles: z
    .array(
      z.object({
        title: z.string().optional().default(""),
        url: z.string().optional().default(""),
        seendate: z.string().optional().nullable(),
        socialimage: z.string().optional().nullable(),
        domain: z.string().optional().nullable()
      })
    )
    .optional()
    .default([])
});

const openMeteoGeocodingResponseSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        country: z.string().optional().nullable(),
        latitude: z.number(),
        longitude: z.number(),
        timezone: z.string().optional().nullable()
      })
    )
    .optional()
    .default([])
});

const openMeteoForecastResponseSchema = z.object({
  current: z
    .object({
      temperature_2m: z.number().optional(),
      apparent_temperature: z.number().optional(),
      wind_speed_10m: z.number().optional()
    })
    .optional(),
  daily: z
    .object({
      time: z.array(z.string()).optional().default([]),
      temperature_2m_max: z.array(z.number()).optional().default([]),
      temperature_2m_min: z.array(z.number()).optional().default([])
    })
    .optional()
});

const worldBankCountriesResponseSchema = z.tuple([
  z.object({}),
  z.array(
    z.object({
      id: z.string(),
      name: z.string()
    })
  )
]);

const worldBankIndicatorResponseSchema = z.tuple([
  z.object({}),
  z.array(
    z.object({
      value: z.number().nullable().optional(),
      date: z.string()
    })
  )
]);

export type FetchLike = typeof fetch;

export class WikipediaReferenceAdapter implements WorldLookupAdapter {
  readonly source = "wikipedia" as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async lookup(params: { query: string; timeoutMs: number }): Promise<WorldLookupAdapterResult> {
    const url = new URL(WIKIPEDIA_SEARCH_URL);
    url.searchParams.set("action", "query");
    url.searchParams.set("format", "json");
    url.searchParams.set("list", "search");
    url.searchParams.set("srsearch", params.query);
    url.searchParams.set("utf8", "1");
    url.searchParams.set("srlimit", "3");

    const payload = wikipediaSearchResponseSchema.parse(await fetchJson(this.fetchImpl, url, params.timeoutMs));

    return {
      source: this.source,
      evidence: payload.query.search.map((result) =>
        createWorldLookupEvidence({
          source: this.source,
          title: result.title,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(result.title.replace(/\s+/g, "_"))}`,
          snippet: stripHtml(result.snippet),
          publishedAt: result.timestamp ?? null,
          confidence: "high"
        })
      )
    };
  }
}

export class WikimediaCurrentEventsAdapter implements WorldLookupAdapter {
  readonly source = "wikimedia_current_events" as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async lookup(params: { query: string; timeoutMs: number }): Promise<WorldLookupAdapterResult> {
    const url = new URL(WIKINEWS_SEARCH_URL);
    url.searchParams.set("action", "query");
    url.searchParams.set("format", "json");
    url.searchParams.set("list", "search");
    url.searchParams.set("srsearch", params.query);
    url.searchParams.set("utf8", "1");
    url.searchParams.set("srlimit", "3");

    const payload = wikipediaSearchResponseSchema.parse(await fetchJson(this.fetchImpl, url, params.timeoutMs));

    return {
      source: this.source,
      evidence: payload.query.search.map((result) =>
        createWorldLookupEvidence({
          source: this.source,
          title: result.title,
          url: `https://en.wikinews.org/wiki/${encodeURIComponent(result.title.replace(/\s+/g, "_"))}`,
          snippet: stripHtml(result.snippet),
          publishedAt: result.timestamp ?? null,
          confidence: "medium"
        })
      )
    };
  }
}

export class GdeltCurrentEventsAdapter implements WorldLookupAdapter {
  readonly source = "gdelt" as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async lookup(params: { query: string; timeoutMs: number }): Promise<WorldLookupAdapterResult> {
    const url = new URL(GDELT_DOC_API_URL);
    url.searchParams.set("query", params.query);
    url.searchParams.set("mode", "artlist");
    url.searchParams.set("format", "json");
    url.searchParams.set("maxrecords", "3");
    url.searchParams.set("sort", "datedesc");

    const payload = gdeltResponseSchema.parse(await fetchJson(this.fetchImpl, url, params.timeoutMs));

    return {
      source: this.source,
      evidence: payload.articles
        .filter((article) => article.title.trim().length > 0)
        .map((article) =>
          createWorldLookupEvidence({
            source: this.source,
            title: article.title,
            url: article.url || null,
            snippet: article.domain ? `Recent coverage from ${article.domain}.` : "Recent current-events coverage.",
            publishedAt: article.seendate ?? null,
            confidence: "medium"
          })
        )
    };
  }
}

export class OpenMeteoWeatherAdapter implements WorldLookupAdapter {
  readonly source = "open_meteo" as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async lookup(params: { query: string; timeoutMs: number }): Promise<WorldLookupAdapterResult> {
    const location = extractLocationQuery(params.query);
    if (!location) {
      throw new Error("open_meteo could not determine a location from the query");
    }

    const geocodingUrl = new URL(OPEN_METEO_GEOCODING_URL);
    geocodingUrl.searchParams.set("name", location);
    geocodingUrl.searchParams.set("count", "1");
    geocodingUrl.searchParams.set("language", "en");
    geocodingUrl.searchParams.set("format", "json");
    const geocoding = openMeteoGeocodingResponseSchema.parse(await fetchJson(this.fetchImpl, geocodingUrl, params.timeoutMs));
    const result = geocoding.results[0];
    if (!result) {
      return {
        source: this.source,
        evidence: []
      };
    }

    const forecastUrl = new URL(OPEN_METEO_FORECAST_URL);
    forecastUrl.searchParams.set("latitude", String(result.latitude));
    forecastUrl.searchParams.set("longitude", String(result.longitude));
    forecastUrl.searchParams.set("current", "temperature_2m,apparent_temperature,wind_speed_10m");
    forecastUrl.searchParams.set("daily", "temperature_2m_max,temperature_2m_min");
    forecastUrl.searchParams.set("forecast_days", "2");
    forecastUrl.searchParams.set("timezone", "auto");

    const forecast = openMeteoForecastResponseSchema.parse(await fetchJson(this.fetchImpl, forecastUrl, params.timeoutMs));
    const currentTemperature = forecast.current?.temperature_2m;
    const apparentTemperature = forecast.current?.apparent_temperature;
    const high = forecast.daily?.temperature_2m_max?.[0];
    const low = forecast.daily?.temperature_2m_min?.[0];
    const locationLabel = [result.name, result.country].filter(Boolean).join(", ");

    const snippets = [
      currentTemperature != null ? `Current temperature ${Math.round(currentTemperature)}C.` : null,
      apparentTemperature != null ? `Feels like ${Math.round(apparentTemperature)}C.` : null,
      high != null && low != null ? `Today's range ${Math.round(low)}C to ${Math.round(high)}C.` : null
    ].filter(Boolean);

    return {
      source: this.source,
      evidence: [
        createWorldLookupEvidence({
          source: this.source,
          title: `Weather for ${locationLabel}`,
          url: null,
          snippet: snippets.join(" "),
          confidence: "high"
        })
      ]
    };
  }
}

export class WorldBankEconomicsAdapter implements WorldLookupAdapter {
  readonly source = "world_bank" as const;

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async lookup(params: { query: string; timeoutMs: number }): Promise<WorldLookupAdapterResult> {
    const countryQuery = extractCountryQuery(params.query);
    if (!countryQuery) {
      throw new Error("world_bank could not determine a country from the query");
    }

    const countriesUrl = new URL(WORLD_BANK_COUNTRIES_URL);
    countriesUrl.searchParams.set("format", "json");
    countriesUrl.searchParams.set("per_page", "400");
    const countriesPayload = worldBankCountriesResponseSchema.parse(await fetchJson(this.fetchImpl, countriesUrl, params.timeoutMs));
    const country = countriesPayload[1].find((entry) => normalizeSearchText(entry.name) === normalizeSearchText(countryQuery));
    if (!country) {
      return {
        source: this.source,
        evidence: []
      };
    }

    const [gdpGrowth, inflation, unemployment] = await Promise.all([
      this.lookupIndicator(country.id, "NY.GDP.MKTP.KD.ZG", params.timeoutMs),
      this.lookupIndicator(country.id, "FP.CPI.TOTL.ZG", params.timeoutMs),
      this.lookupIndicator(country.id, "SL.UEM.TOTL.ZS", params.timeoutMs)
    ]);

    const facts = [gdpGrowth, inflation, unemployment]
      .filter((fact): fact is string => fact != null)
      .join(" ");

    return {
      source: this.source,
      evidence: facts
        ? [
            createWorldLookupEvidence({
              source: this.source,
              title: `${country.name} economic snapshot`,
              url: `https://data.worldbank.org/country/${encodeURIComponent(country.id.toLowerCase())}`,
              snippet: facts,
              confidence: "medium"
            })
          ]
        : []
    };
  }

  private async lookupIndicator(countryCode: string, indicatorCode: string, timeoutMs: number): Promise<string | null> {
    const url = new URL(WORLD_BANK_INDICATOR_TEMPLATE.replace("{country}", encodeURIComponent(countryCode)).replace("{indicator}", indicatorCode));
    url.searchParams.set("format", "json");
    url.searchParams.set("per_page", "1");

    const payload = worldBankIndicatorResponseSchema.parse(await fetchJson(this.fetchImpl, url, timeoutMs));
    const latest = payload[1][0];
    if (!latest || latest.value == null) {
      return null;
    }

    switch (indicatorCode) {
      case "NY.GDP.MKTP.KD.ZG":
        return `GDP growth ${latest.value.toFixed(1)}% in ${latest.date}.`;
      case "FP.CPI.TOTL.ZG":
        return `Inflation ${latest.value.toFixed(1)}% in ${latest.date}.`;
      case "SL.UEM.TOTL.ZS":
        return `Unemployment ${latest.value.toFixed(1)}% in ${latest.date}.`;
      default:
        return null;
    }
  }
}

export function createDefaultWorldLookupAdapters(fetchImpl: FetchLike = fetch): Partial<Record<WorldLookupSourceName, WorldLookupAdapter>> {
  return {
    wikipedia: new WikipediaReferenceAdapter(fetchImpl),
    wikimedia_current_events: new WikimediaCurrentEventsAdapter(fetchImpl),
    gdelt: new GdeltCurrentEventsAdapter(fetchImpl),
    open_meteo: new OpenMeteoWeatherAdapter(fetchImpl),
    world_bank: new WorldBankEconomicsAdapter(fetchImpl)
  };
}

async function fetchJson(fetchImpl: FetchLike, url: URL, timeoutMs: number): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`${url.hostname} request failed: ${response.status} ${await response.text()}`.trim());
  }

  return await response.json();
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function extractLocationQuery(query: string): string | null {
  const match =
    query.match(/\b(?:in|for|at)\s+([a-z][a-z\s.'-]{1,80})$/i) ??
    query.match(/\b(?:in|for|at)\s+([a-z][a-z\s.'-]{1,80})\b/i);
  return match?.[1]?.trim() ?? null;
}

function extractCountryQuery(query: string): string | null {
  const lowercase = query.toLowerCase();
  const patterns = [
    /\b(?:economy|economic|gdp|inflation|unemployment|poverty|development)\s+(?:in|for)\s+([a-z][a-z\s.'-]{1,80})/i,
    /\bhow is\s+([a-z][a-z\s.'-]{1,80}?)(?:'s)?\s+(?:economy|economic|gdp|inflation|unemployment|poverty|development)\b/i,
    /\b([a-z][a-z\s.'-]{1,80}?)(?:'s)?\s+(?:economy|economic|gdp|inflation|unemployment|poverty|development)\b/i
  ];

  for (const pattern of patterns) {
    const match = lowercase.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ");
}
