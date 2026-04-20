import { getNewsPreferences } from "../shared/newsPreferences.js";
import { executeWorldLookup } from "../shared/worldLookup.js";
import { createDefaultWorldLookupAdapters } from "../shared/worldLookupAdapters.js";
import type { Tool } from "../types.js";
import { WorldLookupResult } from "../../types.js";
import { formatLinks, formatWorldLookupSource } from "../shared/formatting.js";

export const newsBriefingTool: Tool = {
    name: "news.briefing",
    description: "Fetch a news briefing.",
    async execute(args, context) {
        const query = args["query"] as string;

        const newsPreferences = getNewsPreferences(context.persistence.settings);
        const lookupResult = await executeWorldLookup({
            query,
            bucket: "current_events",
            adapters: context.worldLookupAdapters ?? createDefaultWorldLookupAdapters(),
            preferences: newsPreferences,
            maxEvidenceCount: 8
        });

        if (context.conversationId) {
            context.persistence.saveNewsBrowseSession({
                kind: "briefing",
                conversationId: context.conversationId,
                query,
                savedAt: new Date().toISOString(),
                items: lookupResult.evidence.map((record, index) => ({
                    ordinal: index + 1,
                    title: record.title,
                    url: record.url,
                    source: record.source,
                    publisher: record.publisher ?? null,
                    snippet: record.snippet,
                    publishedAt: record.publishedAt
                }))
            });
        }

        return {
            success: true,
            isPrompt: true,
            result: `News lookup results for query "":\n\n${constructPrompt(lookupResult)}`,
            contentToAppend: formatLinks(lookupResult.evidence.slice(0, 5).map((record) => record.url)),
            additionalInstructions: undefined
        };
    }
};

function constructPrompt(result: WorldLookupResult): string {
    if (result.evidence.length === 0) {
        return "I couldn't pull together a reliable news briefing from the public sources I checked just now.";
    }

    const lines = result.evidence.slice(0, 5).map((record, index) => {
        const sourceLabel = record.publisher ?? formatWorldLookupSource(record.source);
        return `${index + 1}. ${record.title} (${sourceLabel})`;
    });

    return `${lines.join("\n")}`;
}
