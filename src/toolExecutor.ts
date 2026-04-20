import { newsBriefingTool } from "./tools/news/briefing.js";
import type { Tool, ToolContext, ToolResult } from "./tools/types.js";

const tools = {
    [newsBriefingTool.name]: newsBriefingTool
} as Record<string, Tool>;

export type { ToolContext, ToolResult } from "./tools/types.js";

export async function executeTool(name: string, args: Record<string, string | number>, context: ToolContext): Promise<ToolResult> {
    const tool = tools[name];

    if (!tool) {
        throw new Error(`executeTool is not implemented for tool "${name}"`);
    }

    return await tool.execute(args, context);
}
