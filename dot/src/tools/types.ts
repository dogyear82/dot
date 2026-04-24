import type { Persistence } from "../persistence.js";
import type { WorldLookupSourceName } from "../types.js";
import type { WorldLookupAdapter } from "./shared/worldLookup.js";


export type ToolResult = {
    success: boolean;
    isPrompt?: boolean;
    result: string;
    contentToAppend?: string;
    additionalInstructions?: string;
}

export interface ToolContext {
    actorId?: string;
    persistence: Persistence;
    conversationId?: string;
    worldLookupAdapters?: Partial<Record<WorldLookupSourceName, WorldLookupAdapter>>;
}
export interface Tool {
    name: string;
    description: string;
    execute(args: Record<string, string | number>, context: ToolContext): Promise<ToolResult>;
}
