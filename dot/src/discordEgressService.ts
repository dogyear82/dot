import process from "node:process";

import { loadConfig } from "./config.js";
import { createHostHealthEvent } from "./diagnostics.js";
import { createDiscordEgressClient, registerDiscordEgressConsumer, registerDiscordEgressLifecycleLogging } from "./discord/egress.js";
import { createConfiguredEventBus } from "./eventBus.js";
import { createLogger } from "./logger.js";
import { startObservability } from "./observability.js";
import { initializePersistence } from "./persistence.js";
import { createServiceCoordinator, createServiceHost, type ServiceStatus } from "./runtime/serviceHost.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, config.LOG_FILE_PATH);
  const persistence = await initializePersistence(config.DATA_DIR, config.POSTGRES_URL);
  const bus = await createConfiguredEventBus(config);
  const discordClient = createDiscordEgressClient();

  let observability: ReturnType<typeof startObservability> | undefined;
  let unregisterConsumer: (() => void) | undefined;

  registerDiscordEgressLifecycleLogging({
    client: discordClient,
    logger
  });

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
      name: "discord-egress-service",
      onStatusChange: emitHostHealth,
      async start() {
        await discordClient.login(config.DISCORD_BOT_TOKEN);
        unregisterConsumer = registerDiscordEgressConsumer({
          bus,
          client: discordClient,
          logger,
          persistence
        });
      },
      async stop() {
        unregisterConsumer?.();
        unregisterConsumer = undefined;
        await discordClient.destroy();
      }
    })
  ]);

  logger.info(
    {
      dataDir: config.DATA_DIR,
      postgresUrl: redactConnectionString(config.POSTGRES_URL),
      eventBusAdapter: config.EVENT_BUS_ADAPTER,
      natsUrl: config.EVENT_BUS_ADAPTER === "nats" ? config.NATS_URL : null,
      ollamaBaseUrl: config.OLLAMA_BASE_URL,
      ollamaModel: config.OLLAMA_MODEL
    },
    "Starting Dot discord egress service"
  );

  logger.info(
    {
      services: ["event-bus", "observability", "discord-egress-service"]
    },
    "Initialized Dot discord egress service topology"
  );

  await coordinator.startAll();

  let stopping = false;
  async function handleSignal(signal: "SIGINT" | "SIGTERM") {
    if (stopping) {
      return;
    }

    stopping = true;
    logger.info({ signal }, "Shutting down discord egress service");

    try {
      await coordinator.stopAll();
      await persistence.close();
      process.exit(0);
    } catch (error) {
      logger.fatal({ err: error }, "Discord egress service failed to stop cleanly");
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

function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) {
      url.password = "***";
    }
    return url.toString();
  } catch {
    return connectionString;
  }
}

main().catch((error) => {
  const logger = createLogger(process.env.LOG_LEVEL ?? "error", process.env.LOG_FILE_PATH);
  logger.fatal({ err: error }, "Dot discord egress service failed");
  process.exit(1);
});
