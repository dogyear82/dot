import { get as getCacheValue, set as setCacheValue } from "../../cache.js";
import type { WeatherLookupCandidate } from "./openMeteoClient.js";

const WEATHER_LOOKUP_CACHE_TTL_MS = 15 * 60 * 1000;

type WeatherCacheEntry = {
    savedAt: string;
    candidates: WeatherLookupCandidate[];
};

function buildCacheKey(conversationId: string): string {
    return `weatherLookupCandidates:${conversationId}`;
}

export function set(conversationId: string | undefined, candidates: WeatherLookupCandidate[]): void {
    if (!conversationId) {
        return;
    }

    const entry: WeatherCacheEntry = {
        savedAt: new Date().toISOString(),
        candidates
    };

    setCacheValue(buildCacheKey(conversationId), entry);
}

export function get(conversationId: string | undefined): WeatherLookupCandidate[] {
    if (!conversationId) {
        return [];
    }

    const entry = getCacheValue(buildCacheKey(conversationId)) as WeatherCacheEntry | undefined;
    if (!entry || !Array.isArray(entry.candidates) || entry.candidates.length === 0) {
        return [];
    }

    const savedAt = entry.savedAt ? Date.parse(entry.savedAt) : Number.NaN;
    if (Number.isFinite(savedAt) && Date.now() - savedAt > WEATHER_LOOKUP_CACHE_TTL_MS) {
        setCacheValue(buildCacheKey(conversationId), undefined);
        return [];
    }

    return entry.candidates;
}
