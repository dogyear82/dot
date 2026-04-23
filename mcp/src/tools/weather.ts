import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WeatherService } from "./services/weatherService.js";
import * as z from "zod/v4";

const constructTextResult

export const registerWeatherTool = (server: McpServer, service: WeatherService) => {
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
            const result = await service.getWeatherByCity(city);

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
