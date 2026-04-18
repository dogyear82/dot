import { HtmlWorldLookupArticleReader } from "../shared/worldLookupArticles.js";
import type { NewsBrowseSessionItemRecord } from "../../types.js";
import type { Tool } from "../types.js";
import { getStringArg } from "../shared/args.js";
import { buildNewsFollowUpReply } from "../shared/formatting.js";

export const newsFollowUpTool: Tool = {
    name: "news.follow_up",
    description: "Follow up on a previous news item.",
    async execute(args, context) {
        const query = getStringArg(args, "query");
        if (!query) {
            return {
                success: false,
                reason: "Which story do you want to follow up on?"
            };
        }

        if (!context.conversationId) {
            return {
                success: false,
                reason: "I don't have a recent news list in this conversation to follow up on yet."
            };
        }

        const session = context.persistence.getLatestNewsBrowseSession(context.conversationId);
        if (!session) {
            return {
                success: false,
                reason: "I don't have a recent news list in this conversation to follow up on yet."
            };
        }

        const selectedItem = resolveNewsSessionItem(session.items, query);
        if (!selectedItem) {
            return {
                success: false,
                reason: "I couldn't tell which story you meant from the last news list. Give me the number or the outlet name."
            };
        }

        const evidence = [
            {
                source: selectedItem.source,
                title: selectedItem.title,
                url: selectedItem.url,
                snippet: selectedItem.snippet,
                publishedAt: selectedItem.publishedAt,
                publisher: selectedItem.publisher,
                confidence: "high" as const
            }
        ];
        const articleReader = context.articleReader ?? new HtmlWorldLookupArticleReader();
        const articleReadResult = selectedItem.url ? await articleReader.read({ evidence }) : { articles: [], failures: [] };

        return {
            success: true,
            result: buildNewsFollowUpReply(selectedItem, articleReadResult.articles)
        };
    }
};

function resolveNewsSessionItem(items: NewsBrowseSessionItemRecord[], query: string): NewsBrowseSessionItemRecord | null {
    const normalized = normalizeUserMessage(query);
    const ordinal = parseOrdinalReference(normalized);
    if (ordinal != null) {
        return items.find((item) => item.ordinal === ordinal) ?? null;
    }

    return (
        items.find((item) => {
            const publisher = item.publisher ? normalizeUserMessage(item.publisher) : "";
            const title = normalizeUserMessage(item.title);
            return (publisher.length > 0 && normalized.includes(publisher)) || normalized.includes(title);
        }) ?? null
    );
}

function normalizeUserMessage(userMessage: string): string {
    return userMessage
        .trim()
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/\s+/g, " ");
}

function parseOrdinalReference(normalized: string): number | null {
    const mapping: Record<string, number> = {
        first: 1,
        "1st": 1,
        second: 2,
        "2nd": 2,
        third: 3,
        "3rd": 3,
        fourth: 4,
        "4th": 4,
        fifth: 5,
        "5th": 5
    };

    for (const [label, ordinal] of Object.entries(mapping)) {
        if (normalized.includes(label)) {
            return ordinal;
        }
    }

    return null;
}
