import { OpenMeteoWeatherClient, type WeatherLookupCandidate } from "../../weatherLookup.js";
import type { Tool } from "../types.js";
import { getStringArg } from "../shared/args.js";
import { formatWeatherReply } from "../shared/formatting.js";

const WEATHER_LOOKUP_CACHE_TTL_MS = 15 * 60 * 1000;

export const weatherLookupTool: Tool = {
    name: "weather.lookup",
    description: "Look up weather for a location.",
    async execute(args, context) {
        const location = getStringArg(args, "location");
        const city = getStringArg(args, "city");
        const admin1 = getStringArg(args, "admin1");
        const country = getStringArg(args, "country");
        const weatherClient = context.weatherClient ?? new OpenMeteoWeatherClient();
        const cachedCandidates = readWeatherLookupCandidateCache(context.persistence, context.conversationId);

        if (cachedCandidates.length > 0) {
            const cachedMatch = weatherClient.resolveCachedCandidate(cachedCandidates, {
                location,
                city,
                admin1,
                country
            });

            if (cachedMatch) {
                const forecast = await weatherClient.forecastForCandidate({ candidate: cachedMatch });
                clearWeatherLookupCandidateCache(context.persistence, context.conversationId);
                return {
                    success: true,
                    result: formatWeatherReply(forecast, context.userMessage)
                };
            }
        }

        if (!location && !city) {
            return {
                success: false,
                reason: "Which city and state or province and country should I check the weather for?"
            };
        }

        const searchLocation = location ?? [city, admin1, country].filter(Boolean).join(", ");
        const result = await weatherClient.lookup({ location: searchLocation });
        if (result.kind === "clarify") {
            if (result.reason === "ambiguous_location" && result.candidates?.length && context.conversationId) {
                saveWeatherLookupCandidateCache(context.persistence, context.conversationId, result.candidates);
            }

            return {
                success: false,
                reason: result.prompt
            };
        }

        clearWeatherLookupCandidateCache(context.persistence, context.conversationId);
        return {
            success: true,
            result: formatWeatherReply(result, context.userMessage)
        };
    }
};

function weatherLookupCandidateCacheKey(conversationId: string): string {
    return `weatherLookupCandidates:${conversationId}`;
}

function readWeatherLookupCandidateCache(
    persistence: import("../../persistence.js").Persistence,
    conversationId?: string
): WeatherLookupCandidate[] {
    if (!conversationId) {
        return [];
    }

    const raw = persistence.getWorkerState(weatherLookupCandidateCacheKey(conversationId));
    if (!raw) {
        return [];
    }

    try {
        const parsed = JSON.parse(raw) as {
            savedAt?: string;
            candidates?: WeatherLookupCandidate[];
        };

        if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
            return [];
        }

        const savedAt = parsed.savedAt ? Date.parse(parsed.savedAt) : Number.NaN;
        if (Number.isFinite(savedAt) && Date.now() - savedAt > WEATHER_LOOKUP_CACHE_TTL_MS) {
            persistence.clearWorkerState(weatherLookupCandidateCacheKey(conversationId));
            return [];
        }

        return parsed.candidates;
    } catch {
        persistence.clearWorkerState(weatherLookupCandidateCacheKey(conversationId));
        return [];
    }
}

function saveWeatherLookupCandidateCache(
    persistence: import("../../persistence.js").Persistence,
    conversationId: string,
    candidates: WeatherLookupCandidate[]
): void {
    persistence.setWorkerState(
        weatherLookupCandidateCacheKey(conversationId),
        JSON.stringify({
            savedAt: new Date().toISOString(),
            candidates
        })
    );
}

function clearWeatherLookupCandidateCache(
    persistence: import("../../persistence.js").Persistence,
    conversationId?: string
): void {
    if (!conversationId) {
        return;
    }

    persistence.clearWorkerState(weatherLookupCandidateCacheKey(conversationId));
}
