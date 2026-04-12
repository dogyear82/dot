import type { Logger } from "pino";

import { createEmailActionCompletedEvent, type EmailActionRequestedEvent } from "./events.js";
import type { EventBus } from "./eventBus.js";
import type { OutlookMailClient } from "./outlookMail.js";
import type { Persistence } from "./persistence.js";

export function registerEmailActionsConsumer(params: {
  bus: EventBus;
  logger: Logger;
  mailClient: OutlookMailClient;
  persistence: Persistence;
}): () => void {
  const { bus, logger, mailClient, persistence } = params;

  return bus.subscribe<EmailActionRequestedEvent>("email.action.requested", async (event) => {
    const action = persistence.getEmailAction(event.payload.actionId);
    if (!action) {
      await bus.publish(
        createEmailActionCompletedEvent({
          requestEvent: event,
          status: "blocked",
          reply: `Email action #${event.payload.actionId} was not found.`
        })
      );
      return;
    }

    if (event.payload.operation === "create_draft") {
      if (action.outlookDraftId && action.status === "awaiting_approval") {
        await bus.publish(
          createEmailActionCompletedEvent({
            requestEvent: event,
            status: "awaiting_approval",
            reply: buildDraftCreatedReply(action.id, action.recipientEmail, action.outlookDraftWebLink)
          })
        );
        return;
      }

      if (!action.recipientEmail) {
        persistence.updateEmailAction({
          id: action.id,
          status: "draft_failed",
          lastError: "recipient email missing"
        });
        await bus.publish(
          createEmailActionCompletedEvent({
            requestEvent: event,
            status: "draft_failed",
            reply: `Email action #${action.id} failed to draft: recipient email is missing.`
          })
        );
        return;
      }

      try {
        const draft = await mailClient.createDraft({
          to: action.recipientEmail,
          subject: action.subject,
          body: action.body
        });
        persistence.updateEmailAction({
          id: action.id,
          status: "awaiting_approval",
          outlookDraftId: draft.id,
          outlookDraftWebLink: draft.webLink
        });
        logger.info({ actionId: action.id, outlookDraftId: draft.id }, "Created Outlook email draft");
        await bus.publish(
          createEmailActionCompletedEvent({
            requestEvent: event,
            status: "awaiting_approval",
            reply: buildDraftCreatedReply(action.id, action.recipientEmail, draft.webLink)
          })
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        persistence.updateEmailAction({
          id: action.id,
          status: "draft_failed",
          lastError: detail
        });
        logger.warn({ err: error, actionId: action.id }, "Failed to create Outlook email draft");
        await bus.publish(
          createEmailActionCompletedEvent({
            requestEvent: event,
            status: "draft_failed",
            reply: `Unable to create the Outlook draft right now: ${detail}`
          })
        );
      }

      return;
    }

    if (action.status === "sent") {
      await bus.publish(
        createEmailActionCompletedEvent({
          requestEvent: event,
          status: "sent",
          reply: `Email action #${action.id} has already been sent.`
        })
      );
      return;
    }

    if (!action.outlookDraftId) {
      persistence.updateEmailAction({
        id: action.id,
        status: "send_failed",
        lastError: "draft missing"
      });
      await bus.publish(
        createEmailActionCompletedEvent({
          requestEvent: event,
          status: "send_failed",
          reply: `Email action #${action.id} has no Outlook draft to send.`
        })
      );
      return;
    }

    try {
      await mailClient.sendDraft(action.outlookDraftId);
      persistence.updateEmailAction({
        id: action.id,
        status: "sent",
        sentAt: new Date().toISOString()
      });
      logger.info({ actionId: action.id, outlookDraftId: action.outlookDraftId }, "Sent Outlook email draft");
      await bus.publish(
        createEmailActionCompletedEvent({
          requestEvent: event,
          status: "sent",
          reply: `Sent email action #${action.id} to ${action.recipientEmail ?? "the configured recipient"}.`
        })
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      persistence.updateEmailAction({
        id: action.id,
        status: "send_failed",
        lastError: detail
      });
      logger.warn({ err: error, actionId: action.id }, "Failed to send Outlook email draft");
      await bus.publish(
        createEmailActionCompletedEvent({
          requestEvent: event,
          status: "send_failed",
          reply: `Email action #${action.id} failed to send: ${detail}`
        })
      );
    }
  });
}

function buildDraftCreatedReply(actionId: number, recipientEmail: string | null, draftWebLink: string | null) {
  return [
    `Created draft email action #${actionId} for ${recipientEmail ?? "the configured recipient"}.`,
    draftWebLink ? `Draft: ${draftWebLink}` : "Draft created in Outlook.",
    `Send it with: \`!email approve ${actionId}\``
  ].join("\n");
}
