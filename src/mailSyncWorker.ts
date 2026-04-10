import type { Logger } from "pino";

import { OutlookMailDeltaCursorError, type OutlookMailClient } from "./outlookMail.js";
import type { Persistence } from "./persistence.js";

const DELTA_CURSOR_KEY = "outlookMail.deltaCursor";
const APPROVED_FOLDER_ID_KEY = "outlookMail.approvedFolderId";
const LAST_SYNC_AT_KEY = "outlookMail.lastSyncAt";

export async function syncOutlookMailOnce(params: {
  approvedFolderName: string;
  logger: Logger;
  mailClient: OutlookMailClient;
  persistence: Persistence;
}) {
  const { approvedFolderName, logger, mailClient, persistence } = params;
  const currentFolderId = persistence.getWorkerState(APPROVED_FOLDER_ID_KEY);
  if (!currentFolderId) {
    const folder = await mailClient.ensureFolder(approvedFolderName);
    persistence.setWorkerState(APPROVED_FOLDER_ID_KEY, folder.id);
    logger.info({ folderId: folder.id, displayName: folder.displayName }, "Ensured Outlook approved-mail folder");
  }

  const deltaCursor = persistence.getWorkerState(DELTA_CURSOR_KEY);
  let result;
  try {
    result = await mailClient.syncInboxDelta(deltaCursor);
  } catch (error) {
    if (!(error instanceof OutlookMailDeltaCursorError) || !deltaCursor) {
      throw error;
    }

    persistence.clearWorkerState(DELTA_CURSOR_KEY);
    logger.warn({ err: error }, "Resetting invalid Outlook mail delta cursor and resyncing from a fresh baseline");
    result = await mailClient.syncInboxDelta(null);
  }
  if (result.deltaCursor) {
    persistence.setWorkerState(DELTA_CURSOR_KEY, result.deltaCursor);
  }

  persistence.setWorkerState(LAST_SYNC_AT_KEY, new Date().toISOString());
  logger.info(
    { syncedMessages: result.messages.length, hasDeltaCursor: Boolean(result.deltaCursor) },
    "Synced Outlook mail delta"
  );
}

export function startOutlookMailSyncWorker(params: {
  approvedFolderName: string;
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

  const intervalId = setInterval(() => {
    void tick();
  }, pollIntervalMs);

  return {
    stop() {
      clearInterval(intervalId);
    }
  };
}
