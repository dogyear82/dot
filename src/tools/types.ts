import type { OutlookCalendarClient } from "../outlookCalendar.js";
import type { Persistence } from "../persistence.js";
import type { WorldLookupSourceName } from "../types.js";
import type { WorldLookupAdapter } from "../worldLookup.js";
import type { WorldLookupArticleReader } from "../worldLookupArticles.js";
import type { WeatherLookupClient } from "../weatherLookup.js";

export type ToolName =
    | "prompt_injection.alert"
    | "reminder.add"
    | "reminder.show"
    | "reminder.ack"
    | "calendar.show"
    | "calendar.remind"
    | "weather.lookup"
    | "news.briefing"
    | "news.follow_up"
    | "world.lookup";

export type ToolResult =
    | {
        success: true;
        result: string;
    }
    | {
        success: false;
        reason: string;
    };

export interface ToolContext {
    calendarClient?: OutlookCalendarClient;
    persistence: Persistence;
    conversationId?: string;
    userMessage?: string;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
    articleReader?: WorldLookupArticleReader;
    weatherClient?: WeatherLookupClient;
}

export interface Tool {
    name: ToolName;
    description: string;
    execute(args: string[], context: ToolContext): Promise<ToolResult> | ToolResult;
}
