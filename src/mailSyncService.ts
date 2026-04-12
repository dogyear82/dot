import process from "node:process";

import { loadConfig } from "./config.js";
import { createHostHealthEvent } from "./diagnostics.js";
import { createConfiguredEventBus } from "./eventBus.js";
import { createLogger } from "./logger.js";
import { startOutlookMailSyncWorker } from "./mailSyncWorker.js";
import { startObservability } from "./observability.js";
import { MicrosoftGraphOutlookMailClient } from "./outlookMail.js";
import { MicrosoftOutlookOAuthClient } from "./outlookOAuth.js";
import { initializePersistence } from "./persistence.js";
import { createServiceCoordinator, createServiceHost, type ServiceStatus } from "./runtime/serviceHost.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, config.LOG_FILE_PATH);
  const persistence = initializePersistence(config.DATA_DIR, config.SQLITE_PATH);
  const bus = await createConfiguredEventBus(config);
  const outlookOAuthClient = new MicrosoftOutlookOAuthClient(config, persistence);
  const mailClient = new MicrosoftGraphOutlookMailClient(config, outlookOAuthClient);

  let observability: ReturnType<typeof startObservability> | undefined;
  let worker: ReturnType<typeof startOutlookMailSyncWorker> | undefined;

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

  const coordinator = createServiceCoordinator([
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
        observability = startObservability({ config, logger });
      },
      async stop() {
        await observability?.stop();
        observability = undefined;
      }
    }),
    createServiceHost({
      name: "outlook",
      onStatusChange: emitHostHealth,
      start() {}
    }),
    createServiceHost({
      name: "mail-sync-service",
      onStatusChange: emitHostHealth,
      start() {
        worker = startOutlookMailSyncWorker({
          bus,
          initialLookbackDays: config.OUTLOOK_MAIL_INITIAL_LOOKBACK_DAYS,
          logger,
          mailClient,
          persistence,
          pollIntervalMs: config.OUTLOOK_MAIL_SYNC_INTERVAL_MS
        });
      },
      stop() {
        worker?.stop();
        worker = undefined;
      }
    })
  ]);

  logger.info(
    {
      dataDir: config.DATA_DIR,
      sqlitePath: config.SQLITE_PATH,
      eventBusAdapter: config.EVENT_BUS_ADAPTER,
      natsUrl: config.EVENT_BUS_ADAPTER === "nats" ? config.NATS_URL : null,
      ollamaBaseUrl: config.OLLAMA_BASE_URL,
      ollamaModel: config.OLLAMA_MODEL
    },
    "Starting Dot mail sync service"
  );

  logger.info(
    {
      services: ["event-bus", "observability", "outlook", "mail-sync-service"]
    },
    "Initialized Dot mail sync service topology"
  );

  await coordinator.startAll();

  let stopping = false;
  async function handleSignal(signal: "SIGINT" | "SIGTERM") {
    if (stopping) {
      return;
    }

    stopping = true;
    logger.info({ signal }, "Shutting down mail sync service");

    try {
      await coordinator.stopAll();
      persistence.close();
      process.exit(0);
    } catch (error) {
      logger.fatal({ err: error }, "Mail sync service failed to stop cleanly");
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

main().catch((error) => {
  const logger = createLogger(process.env.LOG_LEVEL ?? "error", process.env.LOG_FILE_PATH);
  logger.fatal({ err: error }, "Dot mail sync service failed");
  process.exit(1);
});
