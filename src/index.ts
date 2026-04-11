import process from "node:process";

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createDotRuntime, registerRuntimeSignalHandlers } from "./runtime/dotRuntime.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const runtime = await createDotRuntime({ config, logger });
  registerRuntimeSignalHandlers(runtime);
  await runtime.start();
}

main().catch((error) => {
  const logger = createLogger(process.env.LOG_LEVEL ?? "error");
  logger.fatal({ err: error }, "Dot bootstrap service failed");
  process.exit(1);
});
