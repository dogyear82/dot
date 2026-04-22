import express, { type Express, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";

import type { Settings } from "./config.js";
import { OpenMeteoClient } from "./integrations/openMeteo.js";
import { WeatherToolService } from "./tools/weather.js";

const createMcpServer = (weatherService: WeatherToolService): McpServer => {
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

  server.registerTool(
    "get_weather_by_city",
    {
      title: "Get Weather By City",
      description:
        "Resolve a city name with Open-Meteo and return current weather. If multiple locations match, return candidates so the client can ask for clarification.",
      inputSchema: {
        city: z.string().min(2).describe("City name to search in Open-Meteo geocoding")
      }
    },
    async ({ city }) => {
      const result = await weatherService.getWeatherByCity(city);

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

  return server;
};

const handleMcpRequest = async (
  request: Request,
  response: Response,
  settings: Settings
): Promise<void> => {
  const weatherService = new WeatherToolService(
    new OpenMeteoClient({
      geocodingUrl: settings.openMeteoGeocodingUrl,
      forecastUrl: settings.openMeteoForecastUrl,
      searchLimit: settings.weatherSearchLimit
    })
  );

  const server = createMcpServer(weatherService);
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
