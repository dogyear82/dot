import type {
    NewsBrowseSessionItemRecord,
    WorldLookupArticleRecord,
    WorldLookupEvidenceRecord,
    WorldLookupResult,
    WorldLookupSourceName
} from "../../types.js";

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

export function formatLinks(urls: Array<string | null | undefined>): string {
    return urls
        .filter((url): url is string => typeof url === "string" && url.length > 0)
        .map((url) => `- ${url}`)
        .join("\n");
}
