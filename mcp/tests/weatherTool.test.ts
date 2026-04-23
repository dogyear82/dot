import { describe, expect, it } from "vitest";

import { OpenMeteoError } from "../src/integrations/openMeteo.js";
import type { CurrentWeather, LocationCandidate } from "../src/models/weather.js";
import { WeatherService } from "../src/tools/services/weatherService.js";

class StubClient {
  constructor(
    private readonly locations: LocationCandidate[] = [],
    private readonly weather?: CurrentWeather | Error,
    private readonly searchError?: Error
  ) {}

  async searchCity(): Promise<LocationCandidate[]> {
    if (this.searchError) {
      throw this.searchError;
    }

    return this.locations;
  }

  async getCurrentWeather(): Promise<CurrentWeather> {
    if (this.weather instanceof Error) {
      throw this.weather;
    }

    if (!this.weather) {
      throw new Error("Missing stub weather value");
    }

    return this.weather;
  }
}

describe("WeatherService", () => {
  it("returns an ambiguous result for multiple candidates", async () => {
    const service = new WeatherService(
      new StubClient([
        { name: "Springfield", admin1: "Illinois", country: "United States", latitude: 1, longitude: 1 },
        { name: "Springfield", admin1: "Missouri", country: "United States", latitude: 2, longitude: 2 }
      ]) as never
    );

    await expect(service.getWeatherByCity("Springfield")).resolves.toMatchObject({
      resultType: "location_ambiguous"
    });
  });

  it("returns not found when geocoding returns nothing", async () => {
    const service = new WeatherService(new StubClient([]) as never);

    await expect(service.getWeatherByCity("Missingtown")).resolves.toMatchObject({
      resultType: "location_not_found"
    });
  });

  it("returns weather when a single location resolves", async () => {
    const service = new WeatherService(
      new StubClient(
        [
          {
            name: "Phoenix",
            admin1: "Arizona",
            country: "United States",
            latitude: 33.4484,
            longitude: -112.074
          }
        ],
        {
          temperatureC: 26,
          windSpeedMS: 3.5,
          windDirectionDegrees: 180,
          weatherCode: 1,
          isDay: true,
          observedAt: "2026-04-21T12:00"
        }
      ) as never
    );

    await expect(service.getWeatherByCity("Phoenix")).resolves.toMatchObject({
      resultType: "weather_found",
      location: { name: "Phoenix" }
    });
  });

  it("supports clarified retries by filtering fallback matches", async () => {
    class ClarifyingStubClient {
      async searchCity(city: string): Promise<LocationCandidate[]> {
        if (city === "Springfield, Missouri") {
          return [];
        }

        if (city === "Springfield") {
          return [
            {
              name: "Springfield",
              admin1: "Missouri",
              country: "United States",
              latitude: 37.21533,
              longitude: -93.29824
            },
            {
              name: "Springfield",
              admin1: "Illinois",
              country: "United States",
              latitude: 39.80172,
              longitude: -89.64371
            }
          ];
        }

        throw new Error(`unexpected city query: ${city}`);
      }

      async getCurrentWeather(location: LocationCandidate): Promise<CurrentWeather> {
        expect(location.admin1).toBe("Missouri");

        return {
          temperatureC: 22,
          windSpeedMS: 4,
          windDirectionDegrees: 90,
          weatherCode: 3,
          isDay: true,
          observedAt: "2026-04-21T12:00"
        };
      }
    }

    const service = new WeatherService(new ClarifyingStubClient() as never);

    await expect(service.getWeatherByCity("Springfield, Missouri")).resolves.toMatchObject({
      resultType: "weather_found",
      location: { admin1: "Missouri" }
    });
  });

  it("returns provider errors for upstream failures", async () => {
    const service = new WeatherService(
      new StubClient([], undefined, new OpenMeteoError("boom")) as never
    );

    await expect(service.getWeatherByCity("Phoenix")).resolves.toMatchObject({
      resultType: "provider_error"
    });
  });
});
