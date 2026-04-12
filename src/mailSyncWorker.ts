import type { Logger } from "pino";

import { createOutlookMailMessageDetectedEvent } from "./events.js";
import type { EventBus } from "./eventBus.js";
import { OutlookMailDeltaCursorError, type OutlookMailClient } from "./outlookMail.js";
import type { Persistence } from "./persistence.js";

const DELTA_CURSOR_KEY = "outlookMail.deltaCursor";
const LAST_SYNC_AT_KEY = "outlookMail.lastSyncAt";

export async function syncOutlookMailOnce(params: {
  bus: EventBus;
  initialLookbackDays: number;
  logger: Logger;
  mailClient: OutlookMailClient;
  persistence: Persistence;
}) {
  const { bus, initialLookbackDays, logger, mailClient, persistence } = params;
  const deltaCursor = persistence.getWorkerState(DELTA_CURSOR_KEY);
  let result;
  const initialBaseline = shouldApplyInitialLookback(deltaCursor);
  const initialReceivedAfter = initialBaseline
    ? new Date(Date.now() - initialLookbackDays * 24 * 60 * 60 * 1000).toISOString()
    : null;
  try {
    result = await mailClient.syncInboxDelta(deltaCursor, { receivedAfter: initialReceivedAfter });
  } catch (error) {
    if (!(error instanceof OutlookMailDeltaCursorError) || !deltaCursor) {
      throw error;
    }

    persistence.clearWorkerState(DELTA_CURSOR_KEY);
    logger.warn({ err: error }, "Resetting invalid Outlook mail delta cursor and resyncing from a fresh baseline");
    result = await mailClient.syncInboxDelta(null, { receivedAfter: initialReceivedAfter });
  }

  if (result.deltaCursor) {
    persistence.setWorkerState(DELTA_CURSOR_KEY, result.deltaCursor);
  }

  const eligibleMessages = initialBaseline
    ? filterMessagesByLookback(result.messages, initialLookbackDays)
    : result.messages;

  for (const message of eligibleMessages) {
    if (persistence.getMailTriageDecision(message.id)) {
      continue;
    }
    persistence.enqueueDetectedMailMessage({
      messageId: message.id,
      message,
      initialBaseline
    });
    await bus.publish(
      createOutlookMailMessageDetectedEvent({
        message,
        initialBaseline
      })
    );
  }

  persistence.setWorkerState(LAST_SYNC_AT_KEY, new Date().toISOString());
  logger.info(
    {
      syncedMessages: result.messages.length,
      eligibleMessages: eligibleMessages.length,
      hasDeltaCursor: Boolean(result.deltaCursor),
      baselineLookbackDays: shouldApplyInitialLookback(deltaCursor) ? initialLookbackDays : null
    },
    "Synced Outlook mail delta"
  );
}

export function startOutlookMailSyncWorker(params: {
  bus: EventBus;
  initialLookbackDays: number;
  logger: Logger;
  mailClient: OutlookMailClient;
  persistence: Persistence;
  pollIntervalMs: number;
}) {
  const { pollIntervalMs, logger } = params;
  let running = false;
  let hasLoggedConfigurationFailure = false;

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      await syncOutlookMailOnce(params);
      hasLoggedConfigurationFailure = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown Outlook mail sync failure";
      if (!hasLoggedConfigurationFailure || !message.includes("not configured")) {
        logger.warn({ err: error }, "Skipping Outlook mail sync tick");
      }
      hasLoggedConfigurationFailure = message.includes("not configured");
    } finally {
      running = false;
    }
  };

  void tick();

  const intervalId = setInterval(() => {
    void tick();
  }, pollIntervalMs);

  return {
    stop() {
      clearInterval(intervalId);
    }
  };
}

function shouldApplyInitialLookback(deltaCursor: string | null): boolean {
  return !deltaCursor;
}

function filterMessagesByLookback(messages: Awaited<ReturnType<OutlookMailClient["syncInboxDelta"]>>["messages"], lookbackDays: number) {
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  return messages.filter((message) => {
    const receivedAt = Date.parse(message.receivedAt);
    return Number.isFinite(receivedAt) && receivedAt >= cutoff;
  });
}
