import type { Persistence } from "./persistence.js";
import { createPolicyEngine } from "./policyEngine.js";
import type { ContactEndpointKind, ContactTrustLevel, PolicyActionType } from "./types.js";

export function isContactCommand(content: string): boolean {
  return content.startsWith("!contact");
}

export function isPolicyCommand(content: string): boolean {
  return content.startsWith("!policy");
}

export function handleContactCommand(params: {
  content: string;
  conversationId: string;
  persistence: Persistence;
}): string {
  const { content, conversationId, persistence } = params;
  const parts = content.trim().split(/\s+/);

  if (parts.length === 1 || parts[1] === "help") {
    return [
      "Contact commands:",
      "- `!contact list`",
      "- `!contact show <name>`",
      "- `!contact add <name> <trusted|approval_required|untrusted> [alias=...] [email=...] [phone=...] [discord=...] [notes=...]`",
      "- `!contact classify <pendingId> <trusted|approval_required|untrusted> [name=...] [alias=...] [email=...] [phone=...] [discord=...] [notes=...]`"
    ].join("\n");
  }

  if (parts[1] === "list") {
    const contacts = persistence.listContacts();
    if (contacts.length === 0) {
      return "No contacts stored yet.";
    }

    return [
      "Stored contacts:",
      ...contacts.map((profile) => `- #${profile.contact.id} ${profile.contact.canonicalName} (${profile.contact.trustLevel})`)
    ].join("\n");
  }

  if (parts[1] === "show" && parts[2]) {
    const profile = persistence.getContactByNameOrAlias(parts.slice(2).join(" "));
    if (!profile) {
      return "No matching contact found.";
    }

    return formatContactProfile(profile);
  }

  if ((parts[1] === "add" || parts[1] === "classify") && parts.length >= 4) {
    if (parts[1] === "add") {
      const trustIndex = parts.findIndex((part, index) => index >= 2 && parseTrustLevel(part) != null);
      if (trustIndex < 3) {
        return "Usage: `!contact add <name> <trusted|approval_required|untrusted> [alias=...] [email=...] [phone=...] [discord=...] [notes=...]`.";
      }

      const canonicalName = parts.slice(2, trustIndex).join(" ").trim();
      const trustLevel = parseTrustLevel(parts[trustIndex] ?? "");
      if (!trustLevel) {
        return "Trust level must be one of: trusted, approval_required, untrusted.";
      }

      const parsed = parseContactFields(parts.slice(trustIndex + 1));
      const profile = persistence.upsertContact({
        canonicalName,
        trustLevel,
        aliases: parsed.aliases,
        endpoints: parsed.endpoints,
        notes: parsed.notes
      });
      return `Saved contact.\n\n${formatContactProfile(profile)}`;
    }

    const pendingId = Number(parts[2]);
    if (!Number.isInteger(pendingId) || pendingId <= 0) {
      return "Pending classification IDs must be positive integers.";
    }

    const pending = persistence.getPendingContactClassification(pendingId);
    if (!pending) {
      return `Pending contact classification #${pendingId} was not found.`;
    }

    const trustLevel = parseTrustLevel(parts[3]);
    if (!trustLevel) {
      return "Trust level must be one of: trusted, approval_required, untrusted.";
    }

    const parsed = parseContactFields(parts.slice(4));
    const canonicalName = parsed.name ?? pending.contactQuery;
    const profile = persistence.upsertContact({
      canonicalName,
      trustLevel,
      aliases: dedupeValues([pending.contactQuery, ...parsed.aliases]),
      endpoints: parsed.endpoints,
      notes: parsed.notes
    });
    persistence.clearPendingContactClassification(pendingId);

    const followUp = createPolicyEngine(persistence).evaluateOutboundAction({
      actionType: pending.actionType,
      contactQuery: pending.contactQuery
    });

    return [
      `Stored contact classification for pending request #${pendingId}.`,
      formatContactProfile(profile),
      "",
      formatPolicyDecision(pending.actionType, followUp)
    ].join("\n");
  }

  return "Invalid contact command. Use `!contact help`.";
}

export function handlePolicyCommand(params: {
  content: string;
  conversationId: string;
  persistence: Persistence;
}): string {
  const { content, conversationId, persistence } = params;
  const parts = content.trim().split(/\s+/);

  if (parts.length === 1 || parts[1] === "help") {
    return [
      "Policy commands:",
      "- `!policy check <email.send|sms.send|message.send> <contact>`",
      "- `!policy pending`"
    ].join("\n");
  }

  if (parts[1] === "pending") {
    const rows = persistence.listPendingContactClassifications();

    if (rows.length === 0) {
      return "No pending contact classifications.";
    }

    return [
      "Pending contact classifications:",
      ...rows.map((row) => `- #${row.id} ${row.actionType} -> ${row.contactQuery} (${row.createdAt})`)
    ].join("\n");
  }

  if (parts[1] === "check" && parts.length >= 4) {
    const actionType = parseActionType(parts[2]);
    if (!actionType) {
      return "Action type must be one of: email.send, sms.send, message.send.";
    }

    const contactQuery = parts.slice(3).join(" ").trim();
    if (!contactQuery) {
      return "Provide a contact name or alias to check.";
    }

    const decision = createPolicyEngine(persistence).evaluateOutboundAction({
      actionType,
      contactQuery
    });

    if (decision.decision === "needs_contact_classification") {
      const pending = persistence.createPendingContactClassification({
        actionType,
        contactQuery,
        conversationId
      });

      return [
        formatPolicyDecision(actionType, decision),
        `Classify it with: \`!contact classify ${pending.id} <trusted|approval_required|untrusted> [name=...] [email=...] [phone=...] [discord=...] [alias=...]\``
      ].join("\n");
    }

    return formatPolicyDecision(actionType, decision);
  }

  return "Invalid policy command. Use `!policy help`.";
}

function formatContactProfile(profile: ReturnType<Persistence["getContactByNameOrAlias"]> extends infer T ? Exclude<T, null> : never) {
  const aliases = profile.aliases.map((alias) => alias.alias);
  const endpoints = profile.endpoints.map((endpoint) => `${endpoint.kind}=${endpoint.value}`);

  return [
    `Contact #${profile.contact.id}: ${profile.contact.canonicalName}`,
    `Trust: ${profile.contact.trustLevel}`,
    `Aliases: ${aliases.length > 0 ? aliases.join(", ") : "none"}`,
    `Endpoints: ${endpoints.length > 0 ? endpoints.join(", ") : "none"}`,
    `Notes: ${profile.contact.notes ?? "none"}`
  ].join("\n");
}

function parseTrustLevel(value: string): ContactTrustLevel | null {
  if (value === "trusted" || value === "approval_required" || value === "untrusted") {
    return value;
  }

  return null;
}

function parseActionType(value: string): PolicyActionType | null {
  if (value === "email.send" || value === "sms.send" || value === "message.send") {
    return value;
  }

  return null;
}

function parseContactFields(parts: string[]) {
  const aliases: string[] = [];
  const endpoints: Array<{ kind: ContactEndpointKind; value: string; label?: string | null }> = [];
  let notes: string | null = null;
  let name: string | null = null;

  for (const part of parts) {
    const [rawKey, ...valueParts] = part.split("=");
    const key = rawKey?.trim();
    const value = valueParts.join("=").trim();
    if (!key || !value) {
      continue;
    }

    switch (key) {
      case "alias":
        aliases.push(value);
        break;
      case "email":
      case "phone":
      case "discord":
        endpoints.push({ kind: key, value });
        break;
      case "notes":
        notes = value;
        break;
      case "name":
        name = value;
        break;
    }
  }

  return {
    name,
    notes,
    aliases: dedupeValues(aliases),
    endpoints
  };
}

function dedupeValues(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function formatPolicyDecision(
  actionType: PolicyActionType,
  decision: ReturnType<ReturnType<typeof createPolicyEngine>["evaluateOutboundAction"]>
) {
  switch (decision.decision) {
    case "allow":
      return `Policy check for ${actionType}: allow (${decision.riskLevel})\n${decision.reason}`;
    case "requires_confirmation":
      return `Policy check for ${actionType}: requires confirmation (${decision.riskLevel})\n${decision.reason}`;
    case "block":
      return `Policy check for ${actionType}: blocked (${decision.riskLevel})\n${decision.reason}`;
    case "needs_contact_classification":
      return `Policy check for ${actionType}: contact classification required (${decision.riskLevel})\n${decision.reason}`;
  }
}
