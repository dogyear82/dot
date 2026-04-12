import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

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
  ONEMINAI_API_KEY: z.string().optional().default(""),
  ONEMINAI_BASE_URL: z.string().default(""),
  ONEMINAI_MODEL: z.string().default(""),
  MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  OUTLOOK_ACCESS_TOKEN: z.string().optional().default(""),
  OUTLOOK_CLIENT_ID: z.string().optional().default(""),
  OUTLOOK_TENANT_ID: z.string().default("common"),
  OUTLOOK_OAUTH_SCOPES: z.string().default("offline_access openid profile User.Read Calendars.Read Mail.ReadWrite"),
  OUTLOOK_GRAPH_BASE_URL: z.string().url().default("https://graph.microsoft.com/v1.0"),
  OUTLOOK_CALENDAR_ID: z.string().optional().default(""),
  OUTLOOK_LOOKAHEAD_DAYS: z.coerce.number().int().positive().default(7),
  OUTLOOK_MAIL_APPROVED_FOLDER: z.string().default("Dot Approved"),
  OUTLOOK_MAIL_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(300000)
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
