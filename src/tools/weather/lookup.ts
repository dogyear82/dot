import { OpenMeteoWeatherClient } from "./openMeteoClient.js";
import type { Tool } from "../types.js";
import { getStringArg } from "../shared/args.js";
import { formatWeatherReply } from "../shared/formatting.js";
import * as weatherCache from "./weatherCache.js";

export const weatherLookupTool: Tool = {
    name: "weather.lookup",
    description: "Look up weather for a location.",
    async execute(args, context) {
        const location = getStringArg(args, "location");
        const city = getStringArg(args, "city");
        const admin1 = getStringArg(args, "admin1");
        const country = getStringArg(args, "country");
        const weatherClient = context.weatherClient ?? new OpenMeteoWeatherClient();
        const cachedCandidates = weatherCache.get(context.conversationId);

        if (cachedCandidates.length > 0) {
            const cachedMatch = weatherClient.resolveCachedCandidate(cachedCandidates, {
                location,
                city,
                admin1,
                country
            });

            if (cachedMatch) {
                const forecast = await weatherClient.forecastForCandidate({ candidate: cachedMatch });
                weatherCache.set(context.conversationId, []);
                return {
                    success: true,
                    result: formatWeatherReply(forecast, context.userMessage)
                };
            }
        }

        if (!location && !city) {
            return {
                success: false,
                reason: "Which city and state or province and country should I check the weather for?"
            };
        }

        const searchLocation = location ?? [city, admin1, country].filter(Boolean).join(", ");
        const result = await weatherClient.lookup({ location: searchLocation });
        if (result.kind === "clarify") {
            if (result.reason === "ambiguous_location" && result.candidates?.length && context.conversationId) {
                weatherCache.set(context.conversationId, result.candidates);
            }

            return {
                success: false,
                reason: result.prompt
            };
        }

        weatherCache.set(context.conversationId, []);
        return {
            success: true,
            result: formatWeatherReply(result, context.userMessage)
        };
    }
};
