import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultWorldLookupAdapters,
  GdeltCurrentEventsAdapter,
  NewsDataCurrentEventsAdapter,
  OpenMeteoWeatherAdapter,
  WikipediaReferenceAdapter,
  WikimediaCurrentEventsAdapter,
  WorldBankEconomicsAdapter
} from "../src/worldLookupAdapters.js";

function createJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

test("WikipediaReferenceAdapter normalizes search results into shared evidence records", async () => {
  const adapter = new WikipediaReferenceAdapter(async (input) => {
    const url = String(input);
    assert.match(url, /en\.wikipedia\.org/);
    return createJsonResponse({
      query: {
        search: [
          {
            title: "Zebra",
            snippet: "A <b>zebra</b> is an African equine.",
            timestamp: "2026-04-10T12:00:00Z"
          }
        ]
      }
    });
  });

  const result = await adapter.lookup({
    query: "zebra",
    timeoutMs: 100
  });

  assert.equal(result.source, "wikipedia");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.title, "Zebra");
  assert.equal(result.evidence[0]?.snippet, "A zebra is an African equine.");
  assert.match(result.evidence[0]?.url ?? "", /en\.wikipedia\.org\/wiki\/Zebra/);
});

test("WikimediaCurrentEventsAdapter normalizes current-events search results", async () => {
  const adapter = new WikimediaCurrentEventsAdapter(async (input) => {
    const url = String(input);
    assert.match(url, /en\.wikinews\.org/);
    return createJsonResponse({
      query: {
        search: [
          {
            title: "Myanmar protests continue",
            snippet: "Fresh updates from <b>Myanmar</b>.",
            timestamp: "2026-04-11T08:00:00Z"
          }
        ]
      }
    });
  });

  const result = await adapter.lookup({
    query: "Myanmar right now",
    timeoutMs: 100
  });

  assert.equal(result.source, "wikimedia_current_events");
  assert.equal(result.evidence[0]?.snippet, "Fresh updates from Myanmar.");
});

test("NewsDataCurrentEventsAdapter normalizes latest-news results", async () => {
  const adapter = new NewsDataCurrentEventsAdapter("test-key", async (input) => {
    const url = String(input);
    assert.match(url, /newsdata\.io\/api\/1\/latest/);
    assert.match(url, /apikey=test-key/);
    assert.match(url, /q=Myanmar/);
    return createJsonResponse({
      results: [
        {
          article_id: "abc",
          title: "Myanmar junta extends emergency rule",
          link: "https://news.example/myanmar",
          description: "The military government extended emergency measures.",
          pubDate: "2026-04-12 12:00:00",
          source_name: "Example News"
        }
      ]
    });
  });

  const result = await adapter.lookup({
    query: "Myanmar",
    timeoutMs: 100
  });

  assert.equal(result.source, "newsdata");
  assert.equal(result.evidence[0]?.title, "Myanmar junta extends emergency rule");
  assert.equal(result.evidence[0]?.url, "https://news.example/myanmar");
  assert.equal(result.evidence[0]?.snippet, "The military government extended emergency measures.");
  assert.equal(result.evidence[0]?.publishedAt, "2026-04-12 12:00:00");
});

test("NewsDataCurrentEventsAdapter rejects lookup when unconfigured", async () => {
  const adapter = new NewsDataCurrentEventsAdapter("", async () => {
    throw new Error("fetch should not be called");
  });

  await assert.rejects(
    adapter.lookup({
      query: "Myanmar",
      timeoutMs: 100
    }),
    /not configured/
  );
});

test("GdeltCurrentEventsAdapter normalizes article-list results", async () => {
  const adapter = new GdeltCurrentEventsAdapter(async (input) => {
    const url = String(input);
    assert.match(url, /gdeltproject/);
    return createJsonResponse({
      articles: [
        {
          title: "Regional tensions rise",
          url: "https://example.test/article",
          seendate: "20260411T120000Z",
          domain: "example.test"
        }
      ]
    });
  });

  const result = await adapter.lookup({
    query: "regional tensions",
    timeoutMs: 100
  });

  assert.equal(result.source, "gdelt");
  assert.equal(result.evidence[0]?.title, "Regional tensions rise");
  assert.equal(result.evidence[0]?.snippet, "Recent coverage from example.test.");
});

test("OpenMeteoWeatherAdapter geocodes a location and normalizes forecast facts", async () => {
  let requestCount = 0;
  const adapter = new OpenMeteoWeatherAdapter(async (input) => {
    const url = String(input);
    requestCount += 1;

    if (url.includes("geocoding-api.open-meteo.com")) {
      return createJsonResponse({
        results: [
          {
            name: "Phoenix",
            country: "United States",
            latitude: 33.45,
            longitude: -112.07,
            timezone: "America/Phoenix"
          }
        ]
      });
    }

    return createJsonResponse({
      current: {
        temperature_2m: 29.1,
        apparent_temperature: 31.7
      },
      daily: {
        time: ["2026-04-12"],
        temperature_2m_max: [34.2],
        temperature_2m_min: [21.0]
      }
    });
  });

  const result = await adapter.lookup({
    query: "What's the weather in Phoenix tomorrow?",
    timeoutMs: 100
  });

  assert.equal(requestCount, 2);
  assert.equal(result.source, "open_meteo");
  assert.match(result.evidence[0]?.title ?? "", /Phoenix, United States/);
  assert.match(result.evidence[0]?.snippet ?? "", /Current temperature 29C/);
});

test("WorldBankEconomicsAdapter resolves a country and normalizes indicator facts", async () => {
  const urls: string[] = [];
  const adapter = new WorldBankEconomicsAdapter(async (input) => {
    const url = String(input);
    urls.push(url);

    if (url.includes("/country?")) {
      return createJsonResponse([
        {},
        [
          { id: "ARG", name: "Argentina" },
          { id: "JPN", name: "Japan" }
        ]
      ]);
    }

    if (url.includes("NY.GDP.MKTP.KD.ZG")) {
      return createJsonResponse([{}, [{ value: 2.3, date: "2025" }]]);
    }

    if (url.includes("FP.CPI.TOTL.ZG")) {
      return createJsonResponse([{}, [{ value: 145.6, date: "2025" }]]);
    }

    return createJsonResponse([{}, [{ value: 7.9, date: "2025" }]]);
  });

  const result = await adapter.lookup({
    query: "How is Argentina's economy doing?",
    timeoutMs: 100
  });

  assert.equal(result.source, "world_bank");
  assert.equal(result.evidence.length, 1);
  assert.match(result.evidence[0]?.title ?? "", /Argentina economic snapshot/);
  assert.match(result.evidence[0]?.snippet ?? "", /GDP growth 2.3% in 2025/);
  assert.match(result.evidence[0]?.snippet ?? "", /Inflation 145.6% in 2025/);
  assert.match(result.evidence[0]?.snippet ?? "", /Unemployment 7.9% in 2025/);
  assert.equal(urls.length, 4);
});

test("createDefaultWorldLookupAdapters exposes the expected public-source registry", () => {
  const adapters = createDefaultWorldLookupAdapters({
    fetchImpl: async () => createJsonResponse({}),
    newsDataApiKey: "test-key"
  });

  assert.ok(adapters.newsdata);
  assert.ok(adapters.wikipedia);
  assert.ok(adapters.wikimedia_current_events);
  assert.ok(adapters.gdelt);
  assert.ok(adapters.open_meteo);
  assert.ok(adapters.world_bank);
});

test("createDefaultWorldLookupAdapters omits NewsData when no API key is configured", () => {
  const adapters = createDefaultWorldLookupAdapters({
    fetchImpl: async () => createJsonResponse({})
  });

  assert.equal(adapters.newsdata, undefined);
});
