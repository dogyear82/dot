import type { Logger } from "pino";

import { McpServerCollection } from "./collection.js";
import type { McpServerConfig, RoutingToolDefinition } from "./types.js";

export interface ToolCallResult {
    success: boolean;
    toolName: string;
    content: string;
    failureDetail?: string;
}

export interface ToolCallService {
    listToolsForRouting(): Promise<RoutingToolDefinition[]>;
    executeTool(
        toolName: string,
        args: Record<string, string | number>
    ): Promise<ToolCallResult>;
}

export function createMcpToolService(params: {
    logger: Logger;
    servers: McpServerConfig[];
    catalogTtlMs?: number;
}): ToolCallService {
    const collection = new McpServerCollection(params.servers);
    const ttlMs = params.catalogTtlMs ?? 60_000;
    let cachedTools: RoutingToolDefinition[] | null = null;
    let cachedAt = 0;

    return {
        async listToolsForRouting() {
            try {
                const now = Date.now();
                if (cachedTools && now - cachedAt < ttlMs) {
                    return cachedTools;
                }

                const discoveredTools = await collection.listTools();
                cachedTools = discoveredTools.map((tool) => ({
                    name: tool.qualifiedName,
                    description: tool.description || "No description provided.",
                    args: Object.keys(tool.inputSchema?.properties ?? {})
                }));
                cachedAt = now;
                return cachedTools;
            } catch (error) {
                params.logger.warn(
                    { err: error },
                    "Unable to load MCP tool catalog for routing"
                );
                return [];
            }
        },

        async executeTool(toolName, args) {
            try {
                const result = await collection.callTool(toolName, args);
                return {
                    success: true,
                    toolName: result.qualifiedName,
                    content: result.content
                };
            } catch (error) {
                const failureDetail = error instanceof Error ? error.message : String(error);
                params.logger.warn(
                    {
                        toolName,
                        err: error
                    },
                    "MCP tool execution failed"
                );
                return {
                    success: false,
                    toolName,
                    content: "",
                    failureDetail
                };
            }
        }
    };
}
