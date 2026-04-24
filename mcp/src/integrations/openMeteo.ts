import type { CurrentWeather, LocationCandidate } from "../models/weather.js";

type FetchLike = typeof fetch;

type OpenMeteoClientOptions = {
  geocodingUrl: string;
  forecastUrl: string;
  searchLimit: number;
  fetchImpl?: FetchLike;
};

type GeocodingResponse = {
  results?: Array<{
    id?: number;
    name: string;
    country?: string;
    country_code?: string;
    admin1?: string;
    admin2?: string;
    admin3?: string;
    timezone?: string;
    latitude: number;
    longitude: number;
  }>;
};

type ForecastResponse = {
  current?: {
    time: string;
    temperature_2m: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    weather_code: number;
    is_day: number;
  };
  current_units?: {
    temperature_2m?: string;
    wind_speed_10m?: string;
  };
};

export class OpenMeteoError extends Error {}

export class OpenMeteoClient {
  private readonly geocodingUrl: string;
  private readonly forecastUrl: string;
  private readonly searchLimit: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenMeteoClientOptions) {
    this.geocodingUrl = options.geocodingUrl;
    this.forecastUrl = options.forecastUrl;
    this.searchLimit = options.searchLimit;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async searchCity(city: string): Promise<LocationCandidate[]> {
    const url = new URL(this.geocodingUrl);
    url.searchParams.set("name", city);
    url.searchParams.set("count", String(this.searchLimit));
    url.searchParams.set("language", "en");
    url.searchParams.set("format", "json");

    const payload = await this.fetchJson<GeocodingResponse>(url);
    return (payload.results ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      country: item.country,
      countryCode: item.country_code,
      admin1: item.admin1,
      admin2: item.admin2,
      admin3: item.admin3,
      timezone: item.timezone,
      latitude: item.latitude,
      longitude: item.longitude
    }));
  }

  async getCurrentWeather(location: LocationCandidate): Promise<CurrentWeather> {
    const url = new URL(this.forecastUrl);
    url.searchParams.set("latitude", String(location.latitude));
    url.searchParams.set("longitude", String(location.longitude));
    url.searchParams.set(
      "current",
      "temperature_2m,wind_speed_10m,wind_direction_10m,weather_code,is_day"
    );
    url.searchParams.set("timezone", "auto");

    const payload = await this.fetchJson<ForecastResponse>(url);
    if (!payload.current) {
      throw new OpenMeteoError(
        "Open-Meteo forecast response did not include current weather data"
      );
    }

    const windSpeedUnit = payload.current_units?.wind_speed_10m;
    const windSpeedMS =
      windSpeedUnit === "km/h"
        ? Number((payload.current.wind_speed_10m / 3.6).toFixed(2))
        : payload.current.wind_speed_10m;

    return {
      temperatureC: payload.current.temperature_2m,
      windSpeedMS,
      windDirectionDegrees: payload.current.wind_direction_10m,
      weatherCode: payload.current.weather_code,
      isDay: Boolean(payload.current.is_day),
      observedAt: payload.current.time
    };
  }

  private async fetchJson<T>(url: URL): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: "application/json"
        }
      });
    } catch (error) {
      throw new OpenMeteoError(
        `Open-Meteo request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!response.ok) {
      throw new OpenMeteoError(
        `Open-Meteo returned HTTP ${response.status} for ${url.toString()}`
      );
    }

    return (await response.json()) as T;
  }
}

