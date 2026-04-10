import type { InboxItemRecord, IncomingMessage } from "./types.js";

export interface InboxStore {
  createInboxItem(message: IncomingMessage): InboxItemRecord;
  listPendingInboxItems(): InboxItemRecord[];
  listUnnotifiedInboxItems(): InboxItemRecord[];
  markInboxItemsNotified(ids: number[]): void;
  markInboxItemHandled(id: number): boolean;
}

export function getNonOwnerPrompt(): string {
  return "I can pass a message to the owner. DM me or mention me with the message you want forwarded.";
}

export function buildContactRelayReply(store: InboxStore, message: IncomingMessage): string {
  const item = store.createInboxItem(message);
  return `Got it. I saved your message for the owner as inbox item #${item.id}.`;
}

export function formatPendingInboxSummary(items: InboxItemRecord[]): string {
  if (items.length === 0) {
    return "Inbox is clear.";
  }

  return [
    `You have ${items.length} pending inbox item${items.length === 1 ? "" : "s"}:`,
    ...items.map((item) => `- #${item.id} from ${item.authorUsername}: ${item.content}`),
    "Use `!inbox done <id>` to mark an item handled."
  ].join("\n");
}

export function isInboxCommand(content: string): boolean {
  return content.startsWith("!inbox");
}

export function handleInboxCommand(store: InboxStore, content: string): string {
  const parts = content.trim().split(/\s+/);

  if (parts.length === 1 || parts[1] === "help") {
    return ["Inbox commands:", "- `!inbox show`", "- `!inbox done <id>`"].join("\n");
  }

  if (parts[1] === "show") {
    return formatPendingInboxSummary(store.listPendingInboxItems());
  }

  if (parts[1] === "done" && parts[2]) {
    const id = Number(parts[2]);

    if (!Number.isInteger(id) || id <= 0) {
      return "Inbox item IDs must be positive integers.";
    }

    return store.markInboxItemHandled(id)
      ? `Marked inbox item #${id} as handled.`
      : `Inbox item #${id} was not found or is already handled.`;
  }

  return "Invalid inbox command. Use `!inbox help`.";
}
