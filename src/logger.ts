import pino from "pino";

import { getActiveLogContext } from "./observability.js";

export function createLogger(level: string, filePath?: string) {
  const streams: pino.StreamEntry[] = [{ stream: process.stdout }];

  if (filePath) {
    streams.push({
      stream: pino.destination({
        dest: filePath,
        mkdir: true,
        sync: false
      })
    });
  }
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      return getActiveLogContext();
    }
  }, pino.multistream(streams));
}
