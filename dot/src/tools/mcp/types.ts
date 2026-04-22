export interface McpServerConfig {
  name: string;
  url: string;
  enabled?: boolean;
}

export interface McpToolSchemaProperty {
  type?: string;
  description?: string;
}

export interface McpToolInputSchema {
  type?: string;
  properties?: Record<string, McpToolSchemaProperty>;
  required?: string[];
}

export interface McpToolDescriptor {
  serverName: string;
  remoteName: string;
  qualifiedName: string;
  description: string;
  inputSchema?: McpToolInputSchema;
}

export interface McpToolCallResult {
  serverName: string;
  remoteName: string;
  qualifiedName: string;
  content: string;
  structuredContent: unknown | null;
}

export interface RoutingToolDefinition {
  name: string;
  description: string;
  args: string[];
}
