import assert from "node:assert/strict";
import test from "node:test";

import { OpenMeteoWeatherClient } from "../src/weatherLookup.js";

function createJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

test("OpenMeteoWeatherClient returns structured weather data for a resolved location", async () => {
  let requestCount = 0;
  const client = new OpenMeteoWeatherClient(async (input) => {
    const url = String(input);
    requestCount += 1;

    if (url.includes("geocoding-api.open-meteo.com")) {
      assert.match(url, /name=Phoenix%2C\+AZ|name=Phoenix%2C%20AZ|name=Phoenix%2CAZ/);
      return createJsonResponse({
        results: [
          {
            name: "Phoenix",
            admin1: "Arizona",
            country: "United States",
            country_code: "US",
            latitude: 33.45,
            longitude: -112.07,
            timezone: "America/Phoenix"
          }
        ]
      });
    }

    return createJsonResponse({
      current: {
        time: "2026-04-16T09:00",
        temperature_2m: 78.4,
        apparent_temperature: 80.1,
        wind_speed_10m: 6.4,
        weather_code: 0,
        is_day: 1
      },
      daily: {
        time: ["2026-04-16", "2026-04-17"],
        weather_code: [0, 2],
        temperature_2m_max: [86.1, 88.4],
        temperature_2m_min: [62.0, 64.2],
        precipitation_probability_max: [0, 10]
      }
    });
  });

  const result = await client.lookup({
    location: "Phoenix, AZ"
  });

  assert.equal(requestCount, 2);
  assert.equal(result.kind, "success");
  if (result.kind !== "success") {
    throw new Error("expected success");
  }
  assert.equal(result.location.label, "Phoenix, Arizona, United States");
  assert.equal(result.units.temperature, "F");
  assert.equal(result.current.condition, "clear");
  assert.equal(result.daily.length, 2);
  assert.equal(result.daily[1]?.condition, "partly cloudy");
});

test("OpenMeteoWeatherClient clarifies ambiguous or missing locations", async () => {
  const missing = await new OpenMeteoWeatherClient(async () => {
    throw new Error("fetch should not be called");
  }).lookup({
    location: ""
  });

  assert.equal(missing.kind, "clarify");
  assert.equal(missing.reason, "missing_location");

  const ambiguous = await new OpenMeteoWeatherClient(async () =>
    createJsonResponse({
      results: [
        {
          name: "Springfield",
          admin1: "Illinois",
          country: "United States",
          country_code: "US",
          latitude: 1,
          longitude: 1,
          timezone: "America/Chicago"
        },
        {
          name: "Springfield",
          admin1: "Missouri",
          country: "United States",
          country_code: "US",
          latitude: 2,
          longitude: 2,
          timezone: "America/Chicago"
        }
      ]
    })
  ).lookup({
    location: "Springfield"
  });

  assert.equal(ambiguous.kind, "clarify");
  assert.equal(ambiguous.reason, "ambiguous_location");
  assert.match(ambiguous.prompt, /multiple places/i);
});
