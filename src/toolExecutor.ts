import { calendarRemindTool } from "./tools/calendar/remind.js";
import { calendarShowTool } from "./tools/calendar/show.js";
import { emailCommandTool } from "./tools/email/commandTool.js";
import { newsBriefingTool } from "./tools/news/briefing.js";
import { newsFollowUpTool } from "./tools/news/followUp.js";
import { promptInjectionAlertTool } from "./tools/promptInjection/alert.js";
import { reminderAckTool } from "./tools/reminder/ack.js";
import { reminderAddTool } from "./tools/reminder/add.js";
import { reminderShowTool } from "./tools/reminder/show.js";
import { weatherLookupTool } from "./tools/weather/lookup.js";
import { worldLookupTool } from "./tools/world/lookup.js";
import type { Tool, ToolContext, ToolName, ToolResult } from "./tools/types.js";

const tools = {
    [promptInjectionAlertTool.name]: promptInjectionAlertTool,
    [reminderAddTool.name]: reminderAddTool,
    [reminderShowTool.name]: reminderShowTool,
    [reminderAckTool.name]: reminderAckTool,
    [calendarShowTool.name]: calendarShowTool,
    [calendarRemindTool.name]: calendarRemindTool,
    [emailCommandTool.name]: emailCommandTool,
    [weatherLookupTool.name]: weatherLookupTool,
    [newsBriefingTool.name]: newsBriefingTool,
    [newsFollowUpTool.name]: newsFollowUpTool,
    [worldLookupTool.name]: worldLookupTool
} as Record<ToolName, Tool>;

export type { ToolContext, ToolName, ToolResult } from "./tools/types.js";

export async function executeTool(name: ToolName, args: string[], context: ToolContext): Promise<ToolResult> {
    const tool = tools[name];

    if (!tool) {
        throw new Error(`executeTool is not implemented for tool "${name}"`);
    }

    return tool.execute(args, context);
}
