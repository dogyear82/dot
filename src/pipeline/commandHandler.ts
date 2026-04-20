import { RoutingData } from "./types.js";


export function createRouteDataFromCommand(content: string): {
    isValid: boolean,
    routingData?: RoutingData
} {
    const parts = content.split(" ");
    const command = parts[0];

    if (command === "!news.briefing") {
        return {
            isValid: true,
            routingData: {
                addressed: true,
                reason: `Command Requested: ${command}`,
                route: {
                    name: "execute_tool",
                    toolName: "news.briefing",
                    reason: "From Command",
                    args: {
                        query: parts.slice(1).join(" ")
                    }
                }
            }
        };
    }

    return {
        isValid: false
    };
}
