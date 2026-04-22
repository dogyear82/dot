import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { McpServerConfig, McpToolCallResult, McpToolDescriptor } from "./types.js";

type ListToolsResponse = {
  tools?: Array<{
    name?: string;
    description?: string;
    inputSchema?: {
      type?: string;
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
  }>;
};

type CallToolResponse = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
};

export class McpServerCollection {
  private readonly serversByName = new Map<string, McpServerConfig>();

  constructor(private readonly servers: McpServerConfig[]) {
    for (const server of servers) {
      this.serversByName.set(server.name, server);
    }
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const results = await Promise.all(
      this.servers.map(async (server) => {
        try {
          const response = await this.withClient(server, async (client) => {
            return (await client.listTools()) as ListToolsResponse;
          });

          return (response.tools ?? [])
            .filter((tool): tool is NonNullable<ListToolsResponse["tools"]>[number] & { name: string } => {
              return typeof tool.name === "string" && tool.name.trim() !== "";
            })
            .map((tool) => ({
              serverName: server.name,
              remoteName: tool.name,
              qualifiedName: `${server.name}.${tool.name}`,
              description: tool.description ?? "",
              inputSchema: tool.inputSchema
            }));
        } catch {
          return [];
        }
      })
    );

    return results.flat();
  }

  async callTool(
    qualifiedName: string,
    args: Record<string, string | number>
  ): Promise<McpToolCallResult> {
    const separatorIndex = qualifiedName.indexOf(".");
    if (separatorIndex <= 0 || separatorIndex === qualifiedName.length - 1) {
      throw new Error(
        `MCP tool name "${qualifiedName}" must be qualified as "<server>.<tool>".`
      );
    }

    const serverName = qualifiedName.slice(0, separatorIndex);
    const remoteName = qualifiedName.slice(separatorIndex + 1);
    const server = this.serversByName.get(serverName);

    if (!server) {
      throw new Error(`No MCP server named "${serverName}" is configured.`);
    }

    const response = await this.withClient(server, async (client) => {
      return (await client.callTool({
        name: remoteName,
        arguments: args
      })) as CallToolResponse;
    });

    return {
      serverName,
      remoteName,
      qualifiedName,
      content: formatToolResult(response),
      structuredContent:
        response.structuredContent === undefined ? null : response.structuredContent
    };
  }

  private async withClient<T>(
    server: McpServerConfig,
    operation: (client: Client) => Promise<T>
  ): Promise<T> {
    const client = new Client({
      name: "dot",
      version: "0.1.0"
    });
    const transport = new StreamableHTTPClientTransport(new URL(server.url));

    try {
      await client.connect(transport);
      return await operation(client);
    } finally {
      try {
        await transport.terminateSession();
      } catch {}

      await client.close();
    }
  }
}

function formatToolResult(response: CallToolResponse): string {
  if (response.structuredContent !== undefined) {
    return JSON.stringify(response.structuredContent, null, 2);
  }

  const textContent = (response.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text?.trim() ?? "")
    .filter((item) => item !== "")
    .join("\n\n");

  if (textContent !== "") {
    return textContent;
  }

  return JSON.stringify(response, null, 2);
}
