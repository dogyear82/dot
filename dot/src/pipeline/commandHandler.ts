import { RoutingData } from "./types.js";

export function createRouteDataFromCommand(content: string): {
    isValid: boolean,
    routingData?: RoutingData
} {
    const parts = content.split(" ");
    const command = parts[0];

    if (command === "!weather") {
        return {
            isValid: true,
            routingData: {
                addressed: true,
                reason: "Command Requested: !weather",
                route: {
                    name: "execute_tool",
                    toolName: "mcp.get_weather_by_city",
                    reason: "From explicit weather command",
                    args: {
                        city: parts.slice(1).join(" ")
                    }
                }
            }
        };
    }

    if (command === "!tool") {
        const toolName = parts[1]?.trim() ?? "";
        const rawArgs = content.slice(content.indexOf(toolName) + toolName.length).trim();

        if (toolName === "") {
            return {
                isValid: false
            };
        }

        return {
            isValid: true,
            routingData: {
                addressed: true,
                reason: "Command Requested: !tool",
                route: {
                    name: "execute_tool",
                    toolName,
                    reason: "From explicit generic tool command",
                    args: parseToolArgs(rawArgs)
                }
            }
        };
    }

    return {
        isValid: false
    };
}

export function isRegisteredExplicitCommand(content: string): boolean {
    const trimmed = content.trim();
    return trimmed.startsWith("!weather") || trimmed.startsWith("!tool ");
}

function parseToolArgs(payload: string): Record<string, string | number> {
    if (payload === "") {
        return {};
    }

    const trimmed = payload.trim();
    if (trimmed.startsWith("{")) {
        const parsed = JSON.parse(trimmed) as Record<string, string | number>;
        return parsed && typeof parsed === "object" ? parsed : {};
    }

    return {
        input: trimmed
    };
}
