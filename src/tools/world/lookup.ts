import { HtmlWorldLookupArticleReader } from "../../worldLookupArticles.js";
import { getNewsPreferences } from "../../newsPreferences.js";
import { executeWorldLookup } from "../../worldLookup.js";
import { createDefaultWorldLookupAdapters } from "../../worldLookupAdapters.js";
import type { Tool } from "../types.js";
import { getStringArg } from "../shared/args.js";
import { buildWorldLookupReply } from "../shared/formatting.js";

export const worldLookupTool: Tool = {
    name: "world.lookup",
    description: "Look up public world information.",
    async execute(args, context) {
        const query = getStringArg(args, "query");
        if (!query) {
            return {
                success: false,
                reason: "What should I look up?"
            };
        }

        const newsPreferences = getNewsPreferences(context.persistence.settings);
        const lookupResult = await executeWorldLookup({
            query,
            adapters: context.worldLookupAdapters ?? createDefaultWorldLookupAdapters(),
            preferences: newsPreferences
        });
        const articleReader = context.articleReader ?? new HtmlWorldLookupArticleReader();
        const articleReadResult =
            lookupResult.bucket === "current_events" && lookupResult.evidence.length > 0
                ? await articleReader.read({ evidence: lookupResult.evidence })
                : { articles: [], failures: [] };

        if (
            context.conversationId &&
            lookupResult.bucket === "current_events" &&
            lookupResult.retrievalStrategy === "current_events_topic_ranked" &&
            lookupResult.evidence.length > 0
        ) {
            context.persistence.saveNewsBrowseSession({
                kind: "topic_lookup",
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
            result: buildWorldLookupReply(lookupResult, articleReadResult.articles)
        };
    }
};
