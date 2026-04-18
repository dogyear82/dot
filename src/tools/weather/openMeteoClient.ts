import { z } from "zod";

const OPEN_METEO_GEOCODING_URL =
    "https://geocoding-api.open-meteo.com/v1/search";
const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const geocodingCandidateSchema = z.object({
    name: z.string(),
    admin1: z.string().optional().nullable(),
    country: z.string().optional().nullable(),
    country_code: z.string().optional().nullable(),
    latitude: z.number(),
    longitude: z.number(),
    timezone: z.string().optional().nullable(),
});

const geocodingResponseSchema = z.object({
    results: z.array(geocodingCandidateSchema).optional().default([]),
});

const forecastResponseSchema = z.object({
    current: z
        .object({
            time: z.string().optional().nullable(),
            temperature_2m: z.number().optional(),
            apparent_temperature: z.number().optional(),
            wind_speed_10m: z.number().optional(),
            weather_code: z.number().optional(),
            is_day: z.number().optional(),
        })
        .optional(),
    daily: z
        .object({
            time: z.array(z.string()).optional().default([]),
            weather_code: z.array(z.number()).optional().default([]),
            temperature_2m_max: z.array(z.number()).optional().default([]),
            temperature_2m_min: z.array(z.number()).optional().default([]),
            precipitation_probability_max: z
                .array(z.number())
                .optional()
                .default([]),
        })
        .optional(),
});

export interface WeatherLookupLocation {
    name: string;
    admin1: string | null;
    country: string | null;
    countryCode: string | null;
    latitude: number;
    longitude: number;
    timezone: string | null;
    label: string;
}

export interface WeatherLookupCandidate extends WeatherLookupLocation {}

export interface WeatherLookupSuccess {
    kind: "success";
    location: WeatherLookupLocation;
    units: {
        temperature: "F" | "C";
        windSpeed: "mph" | "km/h";
    };
    current: {
        time: string | null;
        temperature: number | null;
        apparentTemperature: number | null;
        windSpeed: number | null;
        condition: string | null;
        isDay: boolean | null;
    };
    daily: Array<{
        date: string;
        condition: string | null;
        temperatureMax: number | null;
        temperatureMin: number | null;
        precipitationProbabilityMax: number | null;
    }>;
}

export interface WeatherLookupClarify {
    kind: "clarify";
    reason: "missing_location" | "ambiguous_location" | "location_not_found";
    prompt: string;
    candidates?: WeatherLookupCandidate[];
}

export type WeatherLookupResult = WeatherLookupSuccess | WeatherLookupClarify;

export interface WeatherLookupClient {
    lookup(params: {
        location: string;
        forecastDays?: number;
        timeoutMs?: number;
    }): Promise<WeatherLookupResult>;
    forecastForCandidate(params: {
        candidate: WeatherLookupCandidate;
        forecastDays?: number;
        timeoutMs?: number;
    }): Promise<WeatherLookupSuccess>;
    resolveCachedCandidate(
        candidates: WeatherLookupCandidate[],
        params: {
            location?: string | null;
            city?: string | null;
            admin1?: string | null;
            country?: string | null;
        },
    ): WeatherLookupCandidate | null;
}

export class OpenMeteoWeatherClient implements WeatherLookupClient {
    constructor(private readonly fetchImpl: typeof fetch = fetch) {}

    async lookup(params: {
        location: string;
        forecastDays?: number;
        timeoutMs?: number;
    }): Promise<WeatherLookupResult> {
        const location = params.location.trim();
        if (!location) {
            return {
                kind: "clarify",
                reason: "missing_location",
                prompt: "Which city and state or city and country should I check the weather for?",
            };
        }

        const candidates = await this.searchCandidates({
            location,
            timeoutMs: params.timeoutMs,
        });
        if (candidates.length === 0) {
            return {
                kind: "clarify",
                reason: "location_not_found",
                prompt: `I couldn't find a weather location for ${JSON.stringify(location)}. Give me a city and state or city and country.`,
            };
        }

        if (candidates.length !== 1) {
            return {
                kind: "clarify",
                reason: "ambiguous_location",
                prompt: buildAmbiguousLocationPrompt(location, candidates),
                candidates,
            };
        }

        return this.forecastForCandidate({
            candidate: candidates[0]!,
            forecastDays: params.forecastDays,
            timeoutMs: params.timeoutMs,
        });
    }

    async forecastForCandidate(params: {
        candidate: WeatherLookupCandidate;
        forecastDays?: number;
        timeoutMs?: number;
    }): Promise<WeatherLookupSuccess> {
        const timeoutMs = params.timeoutMs ?? 8000;
        const candidate = params.candidate;
        const useImperial =
            (candidate.countryCode ?? "").toUpperCase() === "US";
        const forecastUrl = new URL(OPEN_METEO_FORECAST_URL);
        forecastUrl.searchParams.set("latitude", String(candidate.latitude));
        forecastUrl.searchParams.set("longitude", String(candidate.longitude));
        forecastUrl.searchParams.set(
            "current",
            "temperature_2m,apparent_temperature,wind_speed_10m,weather_code,is_day",
        );
        forecastUrl.searchParams.set(
            "daily",
            "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        );
        forecastUrl.searchParams.set(
            "forecast_days",
            String(Math.max(1, Math.min(params.forecastDays ?? 7, 7))),
        );
        forecastUrl.searchParams.set("timezone", "auto");
        forecastUrl.searchParams.set(
            "temperature_unit",
            useImperial ? "fahrenheit" : "celsius",
        );
        forecastUrl.searchParams.set(
            "wind_speed_unit",
            useImperial ? "mph" : "kmh",
        );

        const forecast = forecastResponseSchema.parse(
            await fetchJson(this.fetchImpl, forecastUrl, timeoutMs),
        );

        return {
            kind: "success",
            location: candidate,
            units: {
                temperature: useImperial ? "F" : "C",
                windSpeed: useImperial ? "mph" : "km/h",
            },
            current: {
                time: forecast.current?.time ?? null,
                temperature: forecast.current?.temperature_2m ?? null,
                apparentTemperature:
                    forecast.current?.apparent_temperature ?? null,
                windSpeed: forecast.current?.wind_speed_10m ?? null,
                condition: formatWeatherCode(forecast.current?.weather_code),
                isDay:
                    typeof forecast.current?.is_day === "number"
                        ? forecast.current.is_day === 1
                        : null,
            },
            daily:
                forecast.daily?.time.map((date, index) => ({
                    date,
                    condition: formatWeatherCode(
                        forecast.daily?.weather_code?.[index],
                    ),
                    temperatureMax:
                        forecast.daily?.temperature_2m_max?.[index] ?? null,
                    temperatureMin:
                        forecast.daily?.temperature_2m_min?.[index] ?? null,
                    precipitationProbabilityMax:
                        forecast.daily?.precipitation_probability_max?.[
                            index
                        ] ?? null,
                })) ?? [],
        };
    }

    resolveCachedCandidate(
        candidates: WeatherLookupCandidate[],
        params: {
            location?: string | null;
            city?: string | null;
            admin1?: string | null;
            country?: string | null;
        },
    ): WeatherLookupCandidate | null {
        if (!candidates.length) {
            return null;
        }

        const normalizedCity = normalizeToken(params.city);
        const normalizedAdmin1 = normalizeToken(params.admin1);
        const normalizedCountry = normalizeToken(params.country);
        const normalizedLocation = normalizeToken(params.location);

        const matches = candidates.filter((candidate) => {
            const candidateName = normalizeToken(candidate.name);
            const candidateAdmin1 = normalizeToken(candidate.admin1);
            const candidateCountry = normalizeToken(candidate.country);
            const candidateLabel = normalizeToken(candidate.label);

            if (normalizedCity && candidateName !== normalizedCity) {
                return false;
            }
            if (normalizedAdmin1 && candidateAdmin1 !== normalizedAdmin1) {
                return false;
            }
            if (normalizedCountry && candidateCountry !== normalizedCountry) {
                return false;
            }

            if (
                !normalizedCity &&
                !normalizedAdmin1 &&
                !normalizedCountry &&
                normalizedLocation
            ) {
                return (
                    candidateLabel === normalizedLocation ||
                    `${candidateName} ${candidateAdmin1}`.trim() ===
                        normalizedLocation ||
                    `${candidateName} ${candidateCountry}`.trim() ===
                        normalizedLocation ||
                    `${candidateName} ${candidateAdmin1} ${candidateCountry}`.trim() ===
                        normalizedLocation
                );
            }

            return true;
        });

        return matches.length === 1 ? matches[0]! : null;
    }

    private async searchCandidates(params: {
        location: string;
        timeoutMs?: number;
    }): Promise<WeatherLookupCandidate[]> {
        const timeoutMs = params.timeoutMs ?? 8000;
        const geocodingUrl = new URL(OPEN_METEO_GEOCODING_URL);
        geocodingUrl.searchParams.set("name", params.location);
        geocodingUrl.searchParams.set("count", "5");
        geocodingUrl.searchParams.set("language", "en");
        geocodingUrl.searchParams.set("format", "json");

        const geocoding = geocodingResponseSchema.parse(
            await fetchJson(this.fetchImpl, geocodingUrl, timeoutMs),
        );
        return geocoding.results.map(mapCandidate);
    }
}

function mapCandidate(
    result: z.infer<typeof geocodingCandidateSchema>,
): WeatherLookupCandidate {
    return {
        name: result.name,
        admin1: result.admin1 ?? null,
        country: result.country ?? null,
        countryCode: result.country_code ?? null,
        latitude: result.latitude,
        longitude: result.longitude,
        timezone: result.timezone ?? null,
        label: formatGeocodingLabel(result),
    };
}

function buildAmbiguousLocationPrompt(
    location: string,
    candidates: WeatherLookupCandidate[],
): string {
    return `I found multiple places for ${JSON.stringify(location)}. Tell me the city, state or province, and country. I found: ${candidates
        .slice(0, 5)
        .map((candidate) => candidate.label)
        .join("; ")}`;
}

function formatGeocodingLabel(result: {
    name: string;
    admin1?: string | null;
    country?: string | null;
}): string {
    return [result.name, result.admin1, result.country]
        .filter(Boolean)
        .join(", ");
}

function normalizeToken(value: string | null | undefined): string {
    return (value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function formatWeatherCode(code: number | undefined): string | null {
    switch (code) {
        case 0:
            return "clear";
        case 1:
        case 2:
        case 3:
            return "partly cloudy";
        case 45:
        case 48:
            return "foggy";
        case 51:
        case 53:
        case 55:
            return "drizzle";
        case 61:
        case 63:
        case 65:
            return "rain";
        case 66:
        case 67:
            return "freezing rain";
        case 71:
        case 73:
        case 75:
            return "snow";
        case 77:
            return "snow grains";
        case 80:
        case 81:
        case 82:
            return "rain showers";
        case 85:
        case 86:
            return "snow showers";
        case 95:
            return "thunderstorms";
        case 96:
        case 99:
            return "thunderstorms with hail";
        default:
            return null;
    }
}

async function fetchJson(
    fetchImpl: typeof fetch,
    url: URL,
    timeoutMs: number,
): Promise<unknown> {
    const response = await withTimeout(
        fetchImpl(url, {
            method: "GET",
            headers: {
                Accept: "application/json",
            },
        }),
        timeoutMs,
    );

    if (!response.ok) {
        throw new Error(
            `weather lookup request failed with status ${response.status}`,
        );
    }

    return response.json();
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
            () =>
                reject(
                    new Error(`weather lookup timed out after ${timeoutMs}ms`),
                ),
            timeoutMs,
        );
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}
