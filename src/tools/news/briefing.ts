import { getNewsPreferences } from "../../newsPreferences.js";
import { executeWorldLookup } from "../../worldLookup.js";
import { createDefaultWorldLookupAdapters } from "../../worldLookupAdapters.js";
import type { Tool } from "../types.js";
import { getStringArg } from "../shared/args.js";
import { buildNewsBriefingReply } from "../shared/formatting.js";

export const newsBriefingTool: Tool = {
    name: "news.briefing",
    description: "Fetch a news briefing.",
    async execute(args, context) {
        const query = getStringArg(args, "query");
        if (!query) {
            return {
                success: false,
                reason: "What news topic should I brief you on?"
            };
        }

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
            result: buildNewsBriefingReply(lookupResult)
        };
    }
};
