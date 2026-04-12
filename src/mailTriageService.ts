import process from "node:process";

import { loadConfig } from "./config.js";
import { createHostHealthEvent } from "./diagnostics.js";
import { createConfiguredEventBus } from "./eventBus.js";
import { createLogger } from "./logger.js";
import { createMailTriageService, registerMailTriageConsumer } from "./mailTriage.js";
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
  const triageService = createMailTriageService({
    config,
    settings: persistence.settings
  });

  let observability: ReturnType<typeof startObservability> | undefined;
  let unregisterConsumer: (() => void) | undefined;

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
      name: "llm",
      onStatusChange: emitHostHealth,
      start() {}
    }),
    createServiceHost({
      name: "mail-triage-service",
      onStatusChange: emitHostHealth,
      async start() {
        unregisterConsumer = await registerMailTriageConsumer({
          approvedFolderName: config.OUTLOOK_MAIL_APPROVED_FOLDER,
          bus,
          logger,
          mailClient,
          needsAttentionFolderName: config.OUTLOOK_MAIL_NEEDS_ATTENTION_FOLDER,
          persistence,
          triageService
        });
      },
      stop() {
        unregisterConsumer?.();
        unregisterConsumer = undefined;
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
    "Starting Dot mail triage service"
  );

  logger.info(
    {
      services: ["event-bus", "observability", "outlook", "llm", "mail-triage-service"]
    },
    "Initialized Dot mail triage service topology"
  );

  await coordinator.startAll();

  let stopping = false;
  async function handleSignal(signal: "SIGINT" | "SIGTERM") {
    if (stopping) {
      return;
    }

    stopping = true;
    logger.info({ signal }, "Shutting down mail triage service");

    try {
      await coordinator.stopAll();
      persistence.close();
      process.exit(0);
    } catch (error) {
      logger.fatal({ err: error }, "Mail triage service failed to stop cleanly");
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
  logger.fatal({ err: error }, "Dot mail triage service failed");
  process.exit(1);
});
