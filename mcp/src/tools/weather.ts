import { OpenMeteoClient, OpenMeteoError } from "../integrations/openMeteo.js";
import type {
  LocationCandidate,
  LocationAmbiguousResult,
  LocationNotFoundResult,
  ProviderErrorResult,
  WeatherFoundResult,
  WeatherLookupResult
} from "../models/weather.js";

export class WeatherToolService {
  constructor(private readonly client: OpenMeteoClient) {}

  async getWeatherByCity(city: string): Promise<WeatherLookupResult> {
    const normalizedCity = city.trim();

    try {
      const candidates = await this.resolveCandidates(normalizedCity);

      if (candidates.length === 0) {
        return {
          resultType: "location_not_found",
          query: normalizedCity,
          message: `No matching locations for "${normalizedCity}"`
        } satisfies LocationNotFoundResult;
      }

      if (candidates.length > 1) {
        return {
          resultType: "location_ambiguous",
          query: normalizedCity,
          message: `Multiple results found for ${normalizedCity}`,
          candidates
        } satisfies LocationAmbiguousResult;
      }

      const location = candidates[0];
      const currentWeather = await this.client.getCurrentWeather(location);

      return {
        resultType: "weather_found",
        location,
        currentWeather
      } satisfies WeatherFoundResult;
    } catch (error) {
      return {
        resultType: "provider_error",
        query: normalizedCity,
        message: error instanceof OpenMeteoError ? error.message : String(error)
      } satisfies ProviderErrorResult;
    }
  }

  private async resolveCandidates(city: string): Promise<LocationCandidate[]> {
    const directMatches = await this.client.searchCity(city);
    if (directMatches.length > 0) {
      return directMatches;
    }

    if (!city.includes(",")) {
      return [];
    }

    const [baseCity, ...qualifierParts] = city
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    if (!baseCity || qualifierParts.length === 0) {
      return [];
    }

    const fallbackMatches = await this.client.searchCity(baseCity);
    const qualifiers = qualifierParts.map((part) => part.toLowerCase());

    return fallbackMatches.filter((candidate) => this.matchesQualifiers(candidate, qualifiers));
  }

  private matchesQualifiers(candidate: LocationCandidate, qualifiers: string[]): boolean {
    const haystack = [
      candidate.name,
      candidate.admin1,
      candidate.admin2,
      candidate.admin3,
      candidate.country,
      candidate.countryCode,
      candidate.timezone
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return qualifiers.every((qualifier) => haystack.includes(qualifier));
  }
}

