import { createEmailActionRequestedEvent, type EmailActionCompletedEvent, type EmailActionOperation } from "./events.js";
import type { EventBus } from "./eventBus.js";
import { createPolicyEngine } from "./policyEngine.js";
import type { Persistence } from "./persistence.js";

const EMAIL_USAGE = [
  "Email commands:",
  "- `!email list`",
  "- `!email show <actionId>`",
  "- `!email draft <contact> | <subject> | <body>`",
  "- `!email approve <actionId>`"
].join("\n");

export function isEmailCommand(content: string): boolean {
  return content.startsWith("!email");
}

export async function handleEmailCommand(params: {
  actorId: string;
  bus: EventBus;
  content: string;
  conversationId: string;
  persistence: Persistence;
}): Promise<string> {
  const { actorId, bus, content, conversationId, persistence } = params;
  const trimmed = content.trim();
  const parts = trimmed.split(/\s+/);

  if (parts.length === 1 || parts[1] === "help") {
    return EMAIL_USAGE;
  }

  if (parts[1] === "list") {
    const actions = persistence.listEmailActions(10);
    if (actions.length === 0) {
      return "No email actions recorded yet.";
    }

    return [
      "Recent email actions:",
      ...actions.map((action) => `- #${action.id} ${action.status} -> ${action.contactQuery} (${action.subject})`)
    ].join("\n");
  }

  if (parts[1] === "show" && parts[2]) {
    const actionId = Number(parts[2]);
    if (!Number.isInteger(actionId) || actionId <= 0) {
      return "Email action IDs must be positive integers.";
    }

    const action = persistence.getEmailAction(actionId);
    if (!action) {
      return `Email action #${actionId} was not found.`;
    }

    return formatEmailAction(action);
  }

  if (parts[1] === "draft") {
    const parsed = parseDraftCommand(trimmed);
    if (!parsed) {
      return "Usage: `!email draft <contact> | <subject> | <body>`.";
    }

    const policyDecision = createPolicyEngine(persistence).evaluateOutboundAction({
      actionType: "email.send",
      contactQuery: parsed.contactQuery
    });

    if (policyDecision.decision === "needs_contact_classification") {
      const pending = persistence.createPendingContactClassification({
        actionType: "email.send",
        contactQuery: parsed.contactQuery,
        conversationId
      });
      const action = persistence.createEmailAction({
        contactQuery: parsed.contactQuery,
        subject: parsed.subject,
        body: parsed.body,
        status: "pending_contact_classification",
        riskLevel: policyDecision.riskLevel,
        policyReason: policyDecision.reason
      });

      return [
        `Email action #${action.id} is waiting on contact classification.`,
        policyDecision.reason,
        `Classify it with: \`!contact classify ${pending.id} <trusted|approval_required|untrusted> [name=...] [email=...] [phone=...] [discord=...] [alias=...]\``
      ].join("\n");
    }

    if (policyDecision.decision === "block") {
      const blockedAction = persistence.createEmailAction({
        contactQuery: parsed.contactQuery,
        contactId: policyDecision.contact?.contact.id ?? null,
        recipientEmail: resolveRecipientEmail(policyDecision.contact),
        subject: parsed.subject,
        body: parsed.body,
        status: "blocked",
        riskLevel: policyDecision.riskLevel,
        policyReason: policyDecision.reason
      });

      return [
        `Email action #${blockedAction.id} was blocked.`,
        policyDecision.reason
      ].join("\n");
    }

    const recipientEmail = resolveRecipientEmail(policyDecision.contact);
    if (!recipientEmail) {
      const action = persistence.createEmailAction({
        contactQuery: parsed.contactQuery,
        contactId: policyDecision.contact.contact.id,
        subject: parsed.subject,
        body: parsed.body,
        status: "blocked",
        riskLevel: "high",
        policyReason: `${policyDecision.contact.contact.canonicalName} does not have an email endpoint on file.`
      });

      return [
        `Email action #${action.id} was blocked.`,
        `${policyDecision.contact.contact.canonicalName} does not have an email endpoint on file.`
      ].join("\n");
    }

    const action = persistence.createEmailAction({
      contactQuery: parsed.contactQuery,
      contactId: policyDecision.contact.contact.id,
      recipientEmail,
      subject: parsed.subject,
      body: parsed.body,
      status: "draft_requested",
      riskLevel: policyDecision.riskLevel,
      policyReason: policyDecision.reason
    });

    return dispatchEmailAction({
      actionId: action.id,
      actorId,
      bus,
      conversationId,
      operation: "create_draft",
      timeoutReply: `Email action #${action.id} is queued for draft creation. Check \`!email show ${action.id}\` shortly.`
    });
  }

  if (parts[1] === "approve" && parts[2]) {
    const actionId = Number(parts[2]);
    if (!Number.isInteger(actionId) || actionId <= 0) {
      return "Email action IDs must be positive integers.";
    }

    const action = persistence.getEmailAction(actionId);
    if (!action) {
      return `Email action #${actionId} was not found.`;
    }

    if (action.status === "sent") {
      return `Email action #${action.id} has already been sent.`;
    }

    if (!action.outlookDraftId) {
      return `Email action #${action.id} has no Outlook draft to send.`;
    }

    const policyDecision = createPolicyEngine(persistence).evaluateOutboundAction({
      actionType: "email.send",
      contactQuery: action.contactQuery
    });

    if (policyDecision.decision === "needs_contact_classification") {
      const pending = persistence.createPendingContactClassification({
        actionType: "email.send",
        contactQuery: action.contactQuery,
        conversationId
      });
      persistence.updateEmailAction({
        id: action.id,
        status: "pending_contact_classification",
        riskLevel: policyDecision.riskLevel,
        policyReason: policyDecision.reason
      });

      return [
        `Email action #${action.id} is waiting on contact classification before it can be sent.`,
        `Classify it with: \`!contact classify ${pending.id} <trusted|approval_required|untrusted> [name=...] [email=...] [phone=...] [discord=...] [alias=...]\``
      ].join("\n");
    }

    if (policyDecision.decision === "block") {
      persistence.updateEmailAction({
        id: action.id,
        status: "blocked",
        riskLevel: policyDecision.riskLevel,
        policyReason: policyDecision.reason
      });
      return [
        `Email action #${action.id} was blocked before send.`,
        policyDecision.reason
      ].join("\n");
    }

    persistence.updateEmailAction({
      id: action.id,
      status: "send_requested",
      contactId: policyDecision.contact.contact.id,
      recipientEmail: resolveRecipientEmail(policyDecision.contact) ?? action.recipientEmail,
      riskLevel: policyDecision.riskLevel,
      policyReason: policyDecision.reason
    });

    return dispatchEmailAction({
      actionId: action.id,
      actorId,
      bus,
      conversationId,
      operation: "send_draft",
      timeoutReply: `Email action #${action.id} is queued to send. Check \`!email show ${action.id}\` shortly.`
    });
  }

  return "Invalid email command. Use `!email help`.";
}

function parseDraftCommand(content: string): { contactQuery: string; subject: string; body: string } | null {
  const commandPrefix = "!email draft";
  if (!content.startsWith(commandPrefix)) {
    return null;
  }

  const raw = content.slice(commandPrefix.length).trim();
  const parts = raw.split("|").map((part) => part.trim());
  if (parts.length < 3) {
    return null;
  }

  const [contactQuery, subject, ...bodyParts] = parts;
  const body = bodyParts.join(" | ").trim();
  if (!contactQuery || !subject || !body) {
    return null;
  }

  return { contactQuery, subject, body };
}

function resolveRecipientEmail(contact: { endpoints: Array<{ kind: string; value: string }> } | null): string | null {
  return contact?.endpoints.find((endpoint) => endpoint.kind === "email")?.value ?? null;
}

function formatEmailAction(action: Awaited<ReturnType<Persistence["getEmailAction"]>> extends infer T ? Exclude<T, null> : never) {
  return [
    `Email action #${action.id}`,
    `Status: ${action.status}`,
    `Contact: ${action.contactQuery}`,
    `Recipient: ${action.recipientEmail ?? "none"}`,
    `Subject: ${action.subject}`,
    `Draft: ${action.outlookDraftWebLink ?? action.outlookDraftId ?? "none"}`,
    `Policy: ${action.policyReason ?? "none"}`,
    `Error: ${action.lastError ?? "none"}`
  ].join("\n");
}

async function dispatchEmailAction(params: {
  actionId: number;
  actorId: string;
  bus: EventBus;
  conversationId: string;
  operation: EmailActionOperation;
  timeoutReply: string;
}): Promise<string> {
  const completion = waitForEmailActionCompletion({
    actionId: params.actionId,
    bus: params.bus,
    operation: params.operation
  });

  await params.bus.publish(
    createEmailActionRequestedEvent({
      actionId: params.actionId,
      operation: params.operation,
      correlationId: `email-action:${params.actionId}`,
      conversationId: params.conversationId,
      actorId: params.actorId
    })
  );

  return (await completion) ?? params.timeoutReply;
}

async function waitForEmailActionCompletion(params: {
  actionId: number;
  bus: EventBus;
  operation: EmailActionOperation;
  timeoutMs?: number;
}): Promise<string | null> {
  const { actionId, bus, operation, timeoutMs = 10_000 } = params;

  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;

    const finish = (reply: string | null) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      unsubscribe?.();
      resolve(reply);
    };

    unsubscribe = bus.subscribe<EmailActionCompletedEvent>("email.action.completed", (event) => {
      if (event.payload.actionId !== actionId || event.payload.operation !== operation) {
        return;
      }

      finish(event.payload.reply);
    });

    timeout = setTimeout(() => {
      finish(null);
    }, timeoutMs);
  });
}
