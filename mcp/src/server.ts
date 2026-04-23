import express, { type Express, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { Settings } from "./config.js";
import { createNewsService, NewsService } from "./tools/services/newsService.js";
import { createWeatherService, WeatherService } from "./tools/services/weatherService.js";
import { registerNewsTool } from "./tools/news.js";
import { registerWeatherTool } from "./tools/weather.js";

const createMcpServer = (services: {
    weather: WeatherService
    news: NewsService
}): McpServer => {
    const server = new McpServer(
        {
            name: "dot-mcp",
            version: "0.1.0"
        },
        {
            instructions:
                "A minimal general-purpose MCP server. v1 exposes one weather tool backed by Open-Meteo."
        }
    );

    registerNewsTool(server, services.news);
    registerWeatherTool(server, services.weather);
    return server;
};

const handleMcpRequest = async (
    request: Request,
    response: Response,
    settings: Settings
): Promise<void> => {
    const services = {
        weather: createWeatherService(settings.weather),
        news: createNewsService(settings.news)
    };

    const server = createMcpServer(services);
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
    });

    response.on("close", () => {
        void transport.close();
        void server.close();
    });

    try {
        await server.connect(transport);
        await transport.handleRequest(request, response, request.body);
    } catch (error) {
        if (!response.headersSent) {
            response.status(500).json({
                jsonrpc: "2.0",
                error: {
                    code: -32603,
                    message: "Internal server error"
                },
                id: null
            });
        }

        void transport.close();
        void server.close();

        if (error instanceof Error) {
            console.error(error.message);
            return;
        }

        console.error(String(error));
    }
};

export const buildApp = (settings: Settings): Express => {
    const app = express();
    app.use(express.json());

    app.get("/health", (_request, response) => {
        response.json({ status: "ok" });
    });

    app.post("/mcp", async (request, response) => {
        await handleMcpRequest(request, response, settings);
    });

    app.get("/mcp", (_request, response) => {
        response.status(405).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Method not allowed."
            },
            id: null
        });
    });

    app.delete("/mcp", (_request, response) => {
        response.status(405).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Method not allowed."
            },
            id: null
        });
    });

    return app;
};
