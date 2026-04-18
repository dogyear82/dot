import type {
    NewsBrowseSessionItemRecord,
    WorldLookupArticleRecord,
    WorldLookupEvidenceRecord,
    WorldLookupResult,
    WorldLookupSourceName
} from "../../types.js";
import type { WeatherLookupSuccess } from "../../weatherLookup.js";

export function formatWorldLookupSource(source: WorldLookupSourceName): string {
    switch (source) {
        case "newsdata":
            return "NewsData.io";
        case "wikipedia":
            return "Wikipedia";
        case "wikimedia_current_events":
            return "Wikinews";
        case "gdelt":
            return "GDELT";
        case "open_meteo":
            return "Open-Meteo";
        case "world_bank":
            return "World Bank";
    }
}

export function buildNewsBriefingReply(result: WorldLookupResult): string {
    if (result.evidence.length === 0) {
        return "I couldn't pull together a reliable news briefing from the public sources I checked just now.";
    }

    const lines = result.evidence.slice(0, 5).map((record, index) => {
        const sourceLabel = record.publisher ?? formatWorldLookupSource(record.source);
        return `${index + 1}. ${record.title} (${sourceLabel})`;
    });
    const links = formatLinks(result.evidence.slice(0, 5).map((record) => record.url));

    return `Here are the main headlines I found:\n${lines.join("\n")}${links ? `\n\nLinks:\n${links}` : ""}`;
}

export function buildNewsFollowUpReply(
    item: NewsBrowseSessionItemRecord,
    articles: WorldLookupArticleRecord[]
): string {
    if (articles.length > 0) {
        const article = articles[0]!;
        const linkBlock = article.url ? `\n\nLinks:\n- ${article.url}` : "";
        return `${article.publisher} says ${article.excerpt}${linkBlock}`;
    }

    const sourceLabel = item.publisher ?? formatWorldLookupSource(item.source);
    const linkBlock = item.url ? `\n\nLinks:\n- ${item.url}` : "";
    return `From ${sourceLabel}, ${item.snippet}${linkBlock}`;
}

export function buildWorldLookupReply(
    result: WorldLookupResult,
    articles: WorldLookupArticleRecord[]
): string {
    if (result.evidence.length === 0) {
        return "I couldn't verify that from the public sources I checked just now.";
    }

    if (articles.length > 0) {
        const article = articles[0]!;
        const linkBlock = article.url ? `\n\nLinks:\n- ${article.url}` : "";
        return `According to ${article.publisher}, ${article.excerpt}${linkBlock}`;
    }

    const first = result.evidence[0]!;
    const sourceLabel = formatWorldLookupSource(first.source);
    const linkBlock = first.url ? `\n\nLinks:\n- ${first.url}` : "";
    return `According to ${sourceLabel}, ${first.snippet}${linkBlock}`;
}

export function formatWeatherReply(result: WeatherLookupSuccess, userMessage?: string): string {
    const location = result.location.label;
    const temperatureUnit = `°${result.units.temperature}`;
    const currentTemperature = formatNullableNumber(result.current.temperature, temperatureUnit);
    const currentCondition = result.current.condition ?? "unknown conditions";
    const wind = formatNullableNumber(result.current.windSpeed, ` ${result.units.windSpeed}`);

    const daily = selectWeatherDay(result, userMessage);
    if (daily) {
        const high = formatNullableNumber(daily.temperatureMax, temperatureUnit);
        const low = formatNullableNumber(daily.temperatureMin, temperatureUnit);
        const precipitation = formatNullableNumber(daily.precipitationProbabilityMax, "%");
        return `Weather for ${location}: ${daily.date} looks like ${daily.condition ?? "unknown conditions"} with a high of ${high} and a low of ${low}. Precipitation chance is ${precipitation}.`;
    }

    return `Weather for ${location}: currently ${currentTemperature}, ${currentCondition}, with winds around ${wind}.`;
}

function selectWeatherDay(result: WeatherLookupSuccess, userMessage?: string): WeatherLookupSuccess["daily"][number] | null {
    const normalized = (userMessage ?? "").trim().toLowerCase();
    if (normalized.includes("tomorrow")) {
        return result.daily[1] ?? null;
    }

    if (normalized.includes("today")) {
        return result.daily[0] ?? null;
    }

    return null;
}

function formatLinks(urls: Array<string | null | undefined>): string {
    return urls
        .filter((url): url is string => typeof url === "string" && url.length > 0)
        .map((url) => `- ${url}`)
        .join("\n");
}

function formatNullableNumber(value: number | null, suffix: string): string {
    if (typeof value !== "number") {
        return `unknown${suffix.trim() ? ` ${suffix.trim()}` : ""}`.trim();
    }

    return `${Math.round(value)}${suffix}`;
}
