import type { Logger } from "pino";

import type { MailTriageService } from "./mailTriage.js";
import { OutlookMailDeltaCursorError, type OutlookMailClient } from "./outlookMail.js";
import type { Persistence } from "./persistence.js";

const DELTA_CURSOR_KEY = "outlookMail.deltaCursor";
const APPROVED_FOLDER_ID_KEY = "outlookMail.approvedFolderId";
const NEEDS_ATTENTION_FOLDER_ID_KEY = "outlookMail.needsAttentionFolderId";
const LAST_SYNC_AT_KEY = "outlookMail.lastSyncAt";

export async function syncOutlookMailOnce(params: {
  approvedFolderName: string;
  logger: Logger;
  mailClient: OutlookMailClient;
  needsAttentionFolderName: string;
  persistence: Persistence;
  triageService: MailTriageService;
}) {
  const { approvedFolderName, logger, mailClient, needsAttentionFolderName, persistence, triageService } = params;
  const currentFolderId = persistence.getWorkerState(APPROVED_FOLDER_ID_KEY);
  if (!currentFolderId) {
    const folder = await mailClient.ensureFolder(approvedFolderName);
    persistence.setWorkerState(APPROVED_FOLDER_ID_KEY, folder.id);
    logger.info({ folderId: folder.id, displayName: folder.displayName }, "Ensured Outlook approved-mail folder");
  }
  const approvedFolderId = persistence.getWorkerState(APPROVED_FOLDER_ID_KEY) ?? currentFolderId;

  const currentNeedsAttentionFolderId = persistence.getWorkerState(NEEDS_ATTENTION_FOLDER_ID_KEY);
  if (!currentNeedsAttentionFolderId) {
    const folder = await mailClient.ensureFolder(needsAttentionFolderName);
    persistence.setWorkerState(NEEDS_ATTENTION_FOLDER_ID_KEY, folder.id);
    logger.info({ folderId: folder.id, displayName: folder.displayName }, "Ensured Outlook needs-attention folder");
  }
  const needsAttentionFolderId =
    persistence.getWorkerState(NEEDS_ATTENTION_FOLDER_ID_KEY) ?? currentNeedsAttentionFolderId;

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

  for (const message of result.messages) {
    if (persistence.getMailTriageDecision(message.id)) {
      continue;
    }

    const decision = await triageService.triageMessage(message);
    let destinationFolderId: string | null = null;
    let movedAt: string | null = null;

    if (decision.outcome === "dot_approved" && approvedFolderId) {
      destinationFolderId = approvedFolderId;
    } else if (decision.outcome === "needs_attention" && needsAttentionFolderId) {
      destinationFolderId = needsAttentionFolderId;
    }

    if (destinationFolderId && message.parentFolderId !== destinationFolderId) {
      await mailClient.moveMessageToFolder(message.id, destinationFolderId);
      movedAt = new Date().toISOString();
    }

    persistence.saveMailTriageDecision({
      messageId: message.id,
      senderEmail: message.from,
      outcome: decision.outcome,
      source: decision.source,
      reason: decision.reason,
      route: decision.route,
      sourceFolderId: message.parentFolderId,
      destinationFolderId,
      triagedAt: new Date().toISOString(),
      movedAt
    });

    logger.info(
      {
        messageId: message.id,
        from: message.from,
        outcome: decision.outcome,
        source: decision.source,
        route: decision.route,
        destinationFolderId
      },
      "Triaged Outlook mail message"
    );
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
  needsAttentionFolderName: string;
  persistence: Persistence;
  pollIntervalMs: number;
  triageService: MailTriageService;
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
