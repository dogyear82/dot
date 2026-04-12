import process from "node:process";

import type { Logger } from "pino";

import { createLlmService } from "../chat/modelRouter.js";
import type { AppConfig } from "../config.js";
import { createDiagnosticsObserver, createHostHealthEvent } from "../diagnostics.js";
import { createDiscordClient } from "../discord/createClient.js";
import { createConfiguredEventBus } from "../eventBus.js";
import { createMailTriageService, registerMailTriageConsumer } from "../mailTriage.js";
import { registerMessagePipeline } from "../messagePipeline.js";
import { startObservability } from "../observability.js";
import { MicrosoftGraphOutlookCalendarClient } from "../outlookCalendar.js";
import { MicrosoftGraphOutlookMailClient } from "../outlookMail.js";
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
  const mailClient = new MicrosoftGraphOutlookMailClient(config, outlookOAuthClient);
  const chatService = createLlmService({
    config,
    settings: persistence.settings
  });
  const mailTriageService = createMailTriageService({
    config,
    settings: persistence.settings
  });

  let discordClient: ReturnType<typeof createDiscordClient> | undefined;
  let unregisterMessagePipeline: (() => void) | undefined;
  let reminderScheduler: ReturnType<typeof startReminderScheduler> | undefined;
  let unregisterMailTriageConsumer: (() => void) | undefined;
  let diagnosticsObserver: ReturnType<typeof createDiagnosticsObserver> | undefined;
  let observability: ReturnType<typeof startObservability> | undefined;

  const emitHostHealth = async (status: ServiceStatus) => {
    try {
      await bus.publish(createHostHealthEvent(status));
    } catch (error) {
      logger.warn(
        {
          err: error,
          service: status.name,
          readiness: status.readiness
        },
        "Unable to publish service health event"
      );
    }
  };

  const hosts: ServiceHost[] = [
    createServiceHost({
      name: "event-bus",
      onStatusChange: emitHostHealth,
      async stop() {
        await bus.close();
      }
    }),
    createServiceHost({
      name: "observability",
      onStatusChange: emitHostHealth,
      start() {
        observability = startObservability({
          config,
          logger
        });
      },
      async stop() {
        await observability?.stop();
        observability = undefined;
      }
    }),
    createServiceHost({
      name: "diagnostics",
      onStatusChange: emitHostHealth,
      async start() {
        diagnosticsObserver = createDiagnosticsObserver({
          bus,
          logger,
          persistence
        });
        await emitHostHealth({
          name: "event-bus",
          readiness: "ready",
          detail: null
        });
        await emitHostHealth({
          name: "observability",
          readiness: "ready",
          detail: null
        });
      },
      stop() {
        diagnosticsObserver?.stop();
        diagnosticsObserver = undefined;
      }
    }),
    createServiceHost({
      name: "outlook",
      onStatusChange: emitHostHealth,
      start() {}
    }),
    createServiceHost({
      name: "llm",
      onStatusChange: emitHostHealth,
      start() {}
    }),
    createServiceHost({
      name: "message-router",
      onStatusChange: emitHostHealth,
      start() {
        unregisterMessagePipeline = registerMessagePipeline({
          bus,
          calendarClient,
          chatService,
          logger,
          mailClient,
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
      onStatusChange: emitHostHealth,
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
      onStatusChange: emitHostHealth,
      start() {
        reminderScheduler = startReminderScheduler({
          bus,
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
      name: "mail-triage",
      onStatusChange: emitHostHealth,
      async start() {
        unregisterMailTriageConsumer = await registerMailTriageConsumer({
          approvedFolderName: config.OUTLOOK_MAIL_APPROVED_FOLDER,
          bus,
          logger,
          mailClient,
          needsAttentionFolderName: config.OUTLOOK_MAIL_NEEDS_ATTENTION_FOLDER,
          persistence,
          triageService: mailTriageService
        });
      },
      stop() {
        unregisterMailTriageConsumer?.();
        unregisterMailTriageConsumer = undefined;
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

      logger.info(
        {
          services: ["event-bus", "observability", "diagnostics", "outlook", "llm", "message-router", "discord-transport", "reminders", "mail-triage"]
        },
        "Initialized Dot service host topology"
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
