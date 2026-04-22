import { config as loadEnv } from "dotenv";
import { z } from "zod";

import type { McpServerConfig } from "./tools/mcp/types.js";

loadEnv();

const defaultMcpServers = JSON.stringify([
  {
    name: "mcp",
    url: "http://mcp:8000/mcp",
    enabled: true
  }
]);

const mcpServerConfigSchema = z.object({
  name: z.string().min(1, "MCP server name is required"),
  url: z.string().url("MCP server URL must be a valid URL"),
  enabled: z.boolean().default(true)
});

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_OWNER_USER_ID: z.string().min(1, "DISCORD_OWNER_USER_ID is required"),
  DISCORD_CLIENT_ID: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  LOG_FILE_PATH: z.string().optional().default(""),
  OTEL_SERVICE_NAME: z.string().default("dot"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional().default(""),
  METRICS_HOST: z.string().default("0.0.0.0"),
  METRICS_PORT: z.coerce.number().int().min(0).default(9464),
  EVENT_BUS_ADAPTER: z.enum(["in-memory", "nats"]).default("in-memory"),
  NATS_URL: z.string().url().default("nats://localhost:4222"),
  DATA_DIR: z.string().default("./data"),
  SQLITE_PATH: z.string().default("./data/dot.sqlite"),
  OLLAMA_BASE_URL: z.string().url().default("http://ollama:11434"),
  OLLAMA_MODEL: z.string().default("llama3.1:8b"),
  NEWSDATA_API_KEY: z.string().optional().default(""),
  ONEMINAI_API_KEY: z.string().optional().default(""),
  ONEMINAI_BASE_URL: z.string().default(""),
  ONEMINAI_MODEL: z.string().default(""),
  ONEMINAI_INTENT_MODEL: z.string().default(""),
  MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  OUTLOOK_ACCESS_TOKEN: z.string().optional().default(""),
  OUTLOOK_CLIENT_ID: z.string().optional().default(""),
  OUTLOOK_TENANT_ID: z.string().default("common"),
  OUTLOOK_OAUTH_SCOPES: z.string().default("offline_access openid profile User.Read Calendars.Read Mail.ReadWrite Mail.Send"),
  OUTLOOK_GRAPH_BASE_URL: z.string().url().default("https://graph.microsoft.com/v1.0"),
  OUTLOOK_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  OUTLOOK_CALENDAR_ID: z.string().optional().default(""),
  OUTLOOK_LOOKAHEAD_DAYS: z.coerce.number().int().positive().default(7),
  OUTLOOK_MAIL_APPROVED_FOLDER: z.string().default("Dot Approved"),
  OUTLOOK_MAIL_NEEDS_ATTENTION_FOLDER: z.string().default("Needs Attention"),
  OUTLOOK_MAIL_WHITELIST: z.string().default(""),
  OUTLOOK_MAIL_INITIAL_LOOKBACK_DAYS: z.coerce.number().int().positive().default(7),
  OUTLOOK_MAIL_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
  DOT_MCP_SERVERS_JSON: z.string().default(defaultMcpServers)
});

type ParsedEnvConfig = z.infer<typeof envSchema>;

export type AppConfig = Omit<ParsedEnvConfig, "DOT_MCP_SERVERS_JSON"> & {
  DOT_MCP_SERVERS: McpServerConfig[];
};

function parseMcpServers(payload: string): McpServerConfig[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`DOT_MCP_SERVERS_JSON must be valid JSON: ${reason}`);
  }

  const result = z.array(mcpServerConfigSchema).safeParse(parsed);
  if (!result.success) {
    throw new Error(`DOT_MCP_SERVERS_JSON is invalid: ${result.error.message}`);
  }

  return result.data.filter((server) => server.enabled !== false);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  return {
    ...parsed,
    DOT_MCP_SERVERS: parseMcpServers(parsed.DOT_MCP_SERVERS_JSON)
  };
}
