import process from "node:process";

import { createLlmService } from "./chat/modelRouter.js";
import { loadConfig } from "./config.js";
import { createDiscordClient } from "./discord/createClient.js";
import { createInMemoryEventBus } from "./eventBus.js";
import { createLogger } from "./logger.js";
import { registerMessagePipeline } from "./messagePipeline.js";
import { MicrosoftGraphOutlookCalendarClient } from "./outlookCalendar.js";
import { MicrosoftOutlookOAuthClient } from "./outlookOAuth.js";
import { initializePersistence } from "./persistence.js";
import { startReminderScheduler } from "./reminders.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const persistence = initializePersistence(config.DATA_DIR, config.SQLITE_PATH);
  const outlookOAuthClient = new MicrosoftOutlookOAuthClient(config, persistence);
  const calendarClient = new MicrosoftGraphOutlookCalendarClient(config, outlookOAuthClient);
  const bus = createInMemoryEventBus();
  const chatService = createLlmService({
    config,
    settings: persistence.settings
  });
  const client = createDiscordClient({
    bus,
    logger,
    ownerUserId: config.DISCORD_OWNER_USER_ID,
    persistence
  });
  const unregisterMessagePipeline = registerMessagePipeline({
    bus,
    calendarClient,
    chatService,
    logger,
    outlookOAuthClient,
    ownerUserId: config.DISCORD_OWNER_USER_ID,
    persistence
  });
  let reminderScheduler: ReturnType<typeof startReminderScheduler> | undefined;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    reminderScheduler?.stop();
    unregisterMessagePipeline();
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
  reminderScheduler = startReminderScheduler({
    client,
    logger,
    ownerUserId: config.DISCORD_OWNER_USER_ID,
    persistence
  });
}

main().catch((error) => {
  const logger = createLogger(process.env.LOG_LEVEL ?? "error");
  logger.fatal({ err: error }, "Dot bootstrap service failed");
  process.exit(1);
});
