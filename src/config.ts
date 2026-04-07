import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DISCORD_BOT_TOKEN: z.string().min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_OWNER_USER_ID: z.string().min(1, "DISCORD_OWNER_USER_ID is required"),
  DISCORD_CLIENT_ID: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  DATA_DIR: z.string().default("./data"),
  SQLITE_PATH: z.string().default("./data/dot.sqlite"),
  OLLAMA_BASE_URL: z.string().url().default("http://ollama:11434"),
  OLLAMA_MODEL: z.string().default("llama3.1:8b"),
  ONEMINAI_API_KEY: z.string().optional().default("")
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
