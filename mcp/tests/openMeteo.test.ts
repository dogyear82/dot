import { describe, expect, it } from "vitest";

import { OpenMeteoClient, OpenMeteoError } from "../src/integrations/openMeteo.js";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });

describe("OpenMeteoClient", () => {
  it("maps geocoding results into candidates", async () => {
    const client = new OpenMeteoClient({
      geocodingUrl: "https://example.test/geocode",
      forecastUrl: "https://example.test/forecast",
      searchLimit: 5,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("name")).toBe("Phoenix");

        return jsonResponse({
          results: [
            {
              id: 1,
              name: "Phoenix",
              country: "United States",
              country_code: "US",
              admin1: "Arizona",
              timezone: "America/Phoenix",
              latitude: 33.4484,
              longitude: -112.074
            }
          ]
        });
      }
    });

    await expect(client.searchCity("Phoenix")).resolves.toEqual([
      {
        id: 1,
        name: "Phoenix",
        country: "United States",
        countryCode: "US",
        admin1: "Arizona",
        timezone: "America/Phoenix",
        latitude: 33.4484,
        longitude: -112.074
      }
    ]);
  });

  it("normalizes current weather units", async () => {
    const client = new OpenMeteoClient({
      geocodingUrl: "https://example.test/geocode",
      forecastUrl: "https://example.test/forecast",
      searchLimit: 5,
      fetchImpl: async () =>
        jsonResponse({
          current_units: {
            temperature_2m: "°C",
            wind_speed_10m: "km/h"
          },
          current: {
            time: "2026-04-21T12:00",
            temperature_2m: 26.1,
            wind_speed_10m: 18,
            wind_direction_10m: 225,
            weather_code: 1,
            is_day: 1
          }
        })
    });

    await expect(
      client.getCurrentWeather({
        name: "Phoenix",
        latitude: 33.4484,
        longitude: -112.074
      })
    ).resolves.toEqual({
      temperatureC: 26.1,
      windSpeedMS: 5,
      windDirectionDegrees: 225,
      weatherCode: 1,
      isDay: true,
      observedAt: "2026-04-21T12:00"
    });
  });

  it("raises provider errors on non-200 responses", async () => {
    const client = new OpenMeteoClient({
      geocodingUrl: "https://example.test/geocode",
      forecastUrl: "https://example.test/forecast",
      searchLimit: 5,
      fetchImpl: async () => jsonResponse({ error: true }, 502)
    });

    await expect(client.searchCity("Phoenix")).rejects.toBeInstanceOf(OpenMeteoError);
  });
});

