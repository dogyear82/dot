import process from "node:process";

import type { Client } from "discord.js";
import type { Logger } from "pino";

import { createLlmService } from "../chat/modelRouter.js";
import type { AppConfig } from "../config.js";
import { createDiscordClient } from "../discord/createClient.js";
import { createConfiguredEventBus } from "../eventBus.js";
import { registerMessagePipeline } from "../messagePipeline.js";
import { MicrosoftGraphOutlookCalendarClient } from "../outlookCalendar.js";
import { MicrosoftOutlookOAuthClient } from "../outlookOAuth.js";
import { initializePersistence } from "../persistence.js";
import { startReminderScheduler } from "../reminders.js";
import type { ServiceHost, ServiceStatus } from "./serviceHost.js";
import { createServiceCoordinator, createServiceHost } from "./serviceHost.js";

export interface DotRuntime {
  start(): Promise<void>;
  stop(signal?: string): Promise<void>;
  getServiceStatuses(): ServiceStatus[];
}

export async function createDotRuntime(params: {
  config: AppConfig;
  logger: Logger;
}): Promise<DotRuntime> {
  const { config, logger } = params;
  const persistence = initializePersistence(config.DATA_DIR, config.SQLITE_PATH);
  const bus = await createConfiguredEventBus(config);
  const outlookOAuthClient = new MicrosoftOutlookOAuthClient(config, persistence);
  const calendarClient = new MicrosoftGraphOutlookCalendarClient(config, outlookOAuthClient);
  const chatService = createLlmService({
    config,
    settings: persistence.settings
  });

  let discordClient: Client | undefined;
  let unregisterMessagePipeline: (() => void) | undefined;
  let reminderScheduler: ReturnType<typeof startReminderScheduler> | undefined;

  const hosts: ServiceHost[] = [
    createServiceHost({
      name: "event-bus",
      async stop() {
        await bus.close();
      }
    }),
    createServiceHost({
      name: "outlook",
      start() {}
    }),
    createServiceHost({
      name: "llm",
      start() {}
    }),
    createServiceHost({
      name: "message-router",
      start() {
        unregisterMessagePipeline = registerMessagePipeline({
          bus,
          calendarClient,
          chatService,
          logger,
          outlookOAuthClient,
          ownerUserId: config.DISCORD_OWNER_USER_ID,
          persistence
        });
      },
      stop() {
        unregisterMessagePipeline?.();
        unregisterMessagePipeline = undefined;
      }
    }),
    createServiceHost({
      name: "discord-transport",
      async start() {
        discordClient = createDiscordClient({
          bus,
          logger,
          ownerUserId: config.DISCORD_OWNER_USER_ID,
          persistence
        });
        await discordClient.login(config.DISCORD_BOT_TOKEN);
      },
      async stop() {
        if (discordClient) {
          await discordClient.destroy();
          discordClient = undefined;
        }
      }
    }),
    createServiceHost({
      name: "reminders",
      start() {
        if (!discordClient) {
          throw new Error("Discord transport must be started before the reminder host.");
        }

        reminderScheduler = startReminderScheduler({
          client: discordClient,
          logger,
          ownerUserId: config.DISCORD_OWNER_USER_ID,
          persistence
        });
      },
      stop() {
        reminderScheduler?.stop();
        reminderScheduler = undefined;
      }
    }),
    createServiceHost({
      name: "diagnostics",
      start() {
        logger.info(
          {
            services: ["event-bus", "outlook", "llm", "message-router", "discord-transport", "reminders", "diagnostics"]
          },
          "Initialized Dot service host topology"
        );
      }
    })
  ];

  const coordinator = createServiceCoordinator(hosts);

  return {
    async start() {
      logger.info(
        {
          dataDir: config.DATA_DIR,
          sqlitePath: config.SQLITE_PATH,
          eventBusAdapter: config.EVENT_BUS_ADAPTER,
          natsUrl: config.EVENT_BUS_ADAPTER === "nats" ? config.NATS_URL : null,
          ollamaBaseUrl: config.OLLAMA_BASE_URL,
          ollamaModel: config.OLLAMA_MODEL
        },
        "Starting Dot bootstrap service"
      );

      await coordinator.startAll();
    },
    async stop(signal = "shutdown") {
      logger.info({ signal }, "Shutting down");

      try {
        await coordinator.stopAll();
      } finally {
        persistence.close();
      }
    },
    getServiceStatuses() {
      return coordinator.getStatuses();
    }
  };
}

export function registerRuntimeSignalHandlers(runtime: DotRuntime) {
  let stopping = false;

  async function handleSignal(signal: "SIGINT" | "SIGTERM") {
    if (stopping) {
      return;
    }

    stopping = true;

    try {
      await runtime.stop(signal);
      process.exit(0);
    } catch (error) {
      console.error(`Failed to stop Dot runtime cleanly after ${signal}.`, error);
      process.exit(1);
    }
  }

  process.once("SIGINT", () => {
    void handleSignal("SIGINT");
  });

  process.once("SIGTERM", () => {
    void handleSignal("SIGTERM");
  });
}
