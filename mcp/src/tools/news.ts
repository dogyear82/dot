import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NewsService } from "./services/newsService.js";
import * as z from "zod/v4";

export const registerNewsTool = (server: McpServer, service: NewsService) => {
    server.registerTool(
        "news_briefing",
        {
            title: "News Briefing",
            description:
                "Fetch a concise current-events briefing for a topic or headline query from public news sources.",
            inputSchema: {
                query: z.string().min(2).describe("Topic or headline query to brief")
            }
        },
        async ({ query }) => {
            const result = await service.getNewsBriefing(query);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2)
                    }
                ],
                structuredContent: result
            };
        }
    );
}
