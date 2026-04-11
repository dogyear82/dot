import pino from "pino";

import { getActiveLogContext } from "./observability.js";

export function createLogger(level: string) {
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      return getActiveLogContext();
    }
  });
}
