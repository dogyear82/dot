import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/server.js";

const settings = {
  host: "127.0.0.1",
  port: 8000,
  weatherSearchLimit: 5,
  openMeteoGeocodingUrl: "https://geocoding-api.open-meteo.com/v1/search",
  openMeteoForecastUrl: "https://api.open-meteo.com/v1/forecast",
  newsDataApiKey: "newsdata-test-key",
  gdeltDocApiUrl: "https://api.gdeltproject.org/api/v2/doc/doc"
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("HTTP server", () => {
  it("returns health status", async () => {
    const app = buildApp(settings);

    await request(app).get("/health").expect(200, { status: "ok" });
  });

  it("serves MCP discovery and tool invocation over streamable HTTP", async () => {
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" || input instanceof URL ? new URL(String(input)) : new URL(input.url);

      if (url.hostname === "geocoding-api.open-meteo.com") {
        const query = url.searchParams.get("name");

        if (query === "Springfield") {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 4409896,
                  name: "Springfield",
                  country: "United States",
                  country_code: "US",
                  admin1: "Missouri",
                  latitude: 37.21533,
                  longitude: -93.29824
                },
                {
                  id: 4250542,
                  name: "Springfield",
                  country: "United States",
                  country_code: "US",
                  admin1: "Illinois",
                  latitude: 39.80172,
                  longitude: -89.64371
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        if (query === "Springfield, Missouri") {
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        if (query === "Phoenix, Arizona") {
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        if (query === "Phoenix") {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 5308655,
                  name: "Phoenix",
                  country: "United States",
                  country_code: "US",
                  admin1: "Arizona",
                  admin2: "Maricopa",
                  timezone: "America/Phoenix",
                  latitude: 33.44838,
                  longitude: -112.07404
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }

      if (url.hostname === "api.open-meteo.com") {
        return new Response(
          JSON.stringify({
            current_units: {
              temperature_2m: "°C",
              wind_speed_10m: "km/h"
            },
            current: {
              time: "2026-04-21T17:15",
              temperature_2m: 33.5,
              wind_speed_10m: 10.8,
              wind_direction_10m: 276,
              weather_code: 1,
              is_day: 1
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url.hostname === "newsdata.io") {
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Ukraine aid package advances",
                link: "https://example.com/aid-package",
                description: "Lawmakers advanced a new aid package.",
                pubDate: "2026-04-21T10:00:00Z",
                source_name: "Example News"
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url.hostname === "api.gdeltproject.org") {
        return new Response(
          JSON.stringify({
            articles: [
              {
                title: "Ukraine ceasefire talks continue",
                url: "https://example.com/ceasefire-talks",
                seendate: "20260421T120000Z",
                domain: "example.com"
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return originalFetch(input, init);
    };

    const app = buildApp(settings);
    const server = app.listen(0);
    const address = server.address() as AddressInfo;
    const baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const client = new Client({ name: "dot-mcp-test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(baseUrl);

    try {
      await client.connect(transport);

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("get_weather_by_city");
      expect(tools.map((tool) => tool.name)).toContain("news_briefing");

      const ambiguous = await client.callTool({
        name: "get_weather_by_city",
        arguments: { city: "Springfield" }
      });
      expect(ambiguous.isError).toBeUndefined();
      expect(ambiguous.structuredContent).toMatchObject({
        resultType: "location_ambiguous"
      });

      const resolved = await client.callTool({
        name: "get_weather_by_city",
        arguments: { city: "Springfield, Missouri" }
      });
      expect(resolved.structuredContent).toMatchObject({
        resultType: "weather_found",
        location: { admin1: "Missouri" }
      });

      const phoenix = await client.callTool({
        name: "get_weather_by_city",
        arguments: { city: "Phoenix, Arizona" }
      });
      expect(phoenix.structuredContent).toMatchObject({
        resultType: "weather_found",
        location: { name: "Phoenix", admin1: "Arizona" }
      });

      const briefing = await client.callTool({
        name: "news_briefing",
        arguments: { query: "Ukraine today" }
      });
      expect(briefing.structuredContent).toMatchObject({
        resultType: "news_briefing_found",
        query: "Ukraine today"
      });
      expect(Array.isArray(briefing.structuredContent?.briefing)).toBe(true);
      expect(briefing.structuredContent?.briefing?.[0]).toMatchObject({
        title: "Ukraine aid package advances"
      });
    } finally {
      await transport.terminateSession();
      await client.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });
});
