import type { EventBus } from "../eventBus.js";
import type { OutlookCalendarClient } from "../outlookCalendar.js";
import type { Persistence } from "../persistence.js";
import type { WorldLookupSourceName } from "../types.js";
import type { WorldLookupAdapter } from "./shared/worldLookup.js";
import type { WorldLookupArticleReader } from "./shared/worldLookupArticles.js";
import type { WeatherLookupClient } from "./weather/openMeteoClient.js";


export type ToolResult =
    | {
        success: true;
        isPrompt: boolean;
        result: string;
        contentToAppend: string;
        additionalInstructions: string;
    }
    | {
        success: false;
        reason: string;
    };

export interface ToolContext {
    actorId?: string;
    bus?: EventBus;
    calendarClient?: OutlookCalendarClient;
    persistence: Persistence;
    conversationId?: string;
    userMessage?: string;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
    articleReader?: WorldLookupArticleReader;
    weatherClient?: WeatherLookupClient;
}
export interface Tool {
    name: string;
    description: string;
    execute(args: Record<string, string | number>, context: ToolContext): Promise<ToolResult> | ToolResult;
}