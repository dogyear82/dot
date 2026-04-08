import process from "node:process";

import { createChatService } from "./chat/modelRouter.js";
import { loadConfig } from "./config.js";
import { createDiscordClient } from "./discord/createClient.js";
import { createLogger } from "./logger.js";
import { initializePersistence } from "./persistence.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const persistence = initializePersistence(config.DATA_DIR, config.SQLITE_PATH);
  const chatService = createChatService({
    config,
    settings: persistence.settings
  });
  const client = createDiscordClient({
    chatService,
    logger,
    ownerUserId: config.DISCORD_OWNER_USER_ID,
    persistence
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await client.destroy();
    persistence.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  logger.info(
    {
      dataDir: config.DATA_DIR,
      sqlitePath: config.SQLITE_PATH,
      ollamaBaseUrl: config.OLLAMA_BASE_URL,
      ollamaModel: config.OLLAMA_MODEL
    },
    "Starting Dot bootstrap service"
  );

  await client.login(config.DISCORD_BOT_TOKEN);
}

main().catch((error) => {
  const logger = createLogger(process.env.LOG_LEVEL ?? "error");
  logger.fatal({ err: error }, "Dot bootstrap service failed");
  process.exit(1);
});
