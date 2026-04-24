import { OpenMeteoClient, OpenMeteoError } from "../../integrations/openMeteo.js";
import type {
  LocationCandidate,
  LocationAmbiguousResult,
  LocationNotFoundResult,
  ProviderErrorResult,
  WeatherFoundResult,
  WeatherLookupResult
} from "../../models/weather.js";

export type WeatherSettings = {
    searchLimit: number;
    openMeteoGeocodingUrl: string;
    openMeteoForecastUrl: string;
}

export const createWeatherService = (settings: WeatherSettings): WeatherService => {
    return new  WeatherService(
        new OpenMeteoClient({
            geocodingUrl: settings.openMeteoGeocodingUrl,
            forecastUrl: settings.openMeteoForecastUrl,
            searchLimit: settings.searchLimit
        })
    );
}

export class WeatherService {
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
    const [baseCity, ...qualifierParts] = city
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    if (!baseCity) {
      return [];
    }

    const matches = await this.client.searchCity(baseCity);
    if (qualifierParts.length === 0) {
      return matches;
    }

    const qualifiers = qualifierParts.map((part) => part.toLowerCase());

    return matches.filter((candidate) => this.matchesQualifiers(candidate, qualifiers));
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
    ].filter(Boolean)
      .map((value) => value!.toLowerCase());

    const normalizedTokens = new Set<string>(haystack);
    const admin1Abbreviation = candidate.admin1 ? US_STATE_ABBREVIATIONS[candidate.admin1.toLowerCase()] : undefined;
    if (admin1Abbreviation) {
      normalizedTokens.add(admin1Abbreviation);
    }

    return qualifiers.every((qualifier) => {
      for (const token of normalizedTokens) {
        if (token.includes(qualifier)) {
          return true;
        }
      }

      return false;
    });
  }
}

const US_STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: "al",
  alaska: "ak",
  arizona: "az",
  arkansas: "ar",
  california: "ca",
  colorado: "co",
  connecticut: "ct",
  delaware: "de",
  florida: "fl",
  georgia: "ga",
  hawaii: "hi",
  idaho: "id",
  illinois: "il",
  indiana: "in",
  iowa: "ia",
  kansas: "ks",
  kentucky: "ky",
  louisiana: "la",
  maine: "me",
  maryland: "md",
  massachusetts: "ma",
  michigan: "mi",
  minnesota: "mn",
  mississippi: "ms",
  missouri: "mo",
  montana: "mt",
  nebraska: "ne",
  nevada: "nv",
  "new hampshire": "nh",
  "new jersey": "nj",
  "new mexico": "nm",
  "new york": "ny",
  "north carolina": "nc",
  "north dakota": "nd",
  ohio: "oh",
  oklahoma: "ok",
  oregon: "or",
  pennsylvania: "pa",
  "rhode island": "ri",
  "south carolina": "sc",
  "south dakota": "sd",
  tennessee: "tn",
  texas: "tx",
  utah: "ut",
  vermont: "vt",
  virginia: "va",
  washington: "wa",
  "west virginia": "wv",
  wisconsin: "wi",
  wyoming: "wy",
  "district of columbia": "dc"
};
