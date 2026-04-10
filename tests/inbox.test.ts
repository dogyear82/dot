import test from "node:test";
import assert from "node:assert/strict";

import { buildContactRelayReply, formatPendingInboxSummary, getNonOwnerPrompt, handleInboxCommand } from "../src/inbox.js";
import type { InboxItemRecord } from "../src/types.js";

function createInboxItem(overrides: Partial<InboxItemRecord> = {}): InboxItemRecord {
  return {
    id: 1,
    sourceMessageId: "msg-1",
    channelId: "channel-1",
    guildId: "guild-1",
    authorId: "user-1",
    authorUsername: "alice",
    content: "hello owner",
    status: "pending",
    ownerNotifiedAt: null,
    handledAt: null,
    createdAt: "2026-04-10T00:00:00.000Z",
    ...overrides
  };
}

test("buildContactRelayReply saves a non-owner message as an inbox item", () => {
  let saved: InboxItemRecord | undefined;
  const store = {
    createInboxItem(message: { id: string; content: string }) {
      saved = createInboxItem({ sourceMessageId: message.id, content: message.content });
      return saved;
    },
    listPendingInboxItems() {
      return [];
    },
    listUnnotifiedInboxItems() {
      return [];
    },
    markInboxItemsNotified() {},
    markInboxItemHandled() {
      return false;
    }
  };

  const reply = buildContactRelayReply(store, {
    id: "msg-9",
    channelId: "channel-1",
    guildId: "guild-1",
    authorId: "user-2",
    authorUsername: "bob",
    content: "please tell the owner I stopped by",
    isDirectMessage: false,
    mentionedBot: true,
    createdAt: "2026-04-10T00:00:00.000Z"
  });

  assert.match(reply, /inbox item #1/i);
  assert.equal(saved?.sourceMessageId, "msg-9");
});

test("handleInboxCommand can show and mark inbox items handled", () => {
  const items = [createInboxItem(), createInboxItem({ id: 2, authorUsername: "bob", content: "second message" })];
  const handledIds: number[] = [];
  const store = {
    createInboxItem() {
      return createInboxItem();
    },
    listPendingInboxItems() {
      return items;
    },
    listUnnotifiedInboxItems() {
      return items;
    },
    markInboxItemsNotified() {},
    markInboxItemHandled(id: number) {
      handledIds.push(id);
      return id === 2;
    }
  };

  assert.match(handleInboxCommand(store, "!inbox show"), /#1 from alice/);
  assert.match(handleInboxCommand(store, "!inbox done 2"), /Marked inbox item #2/);
  assert.equal(handledIds[0], 2);
  assert.match(handleInboxCommand(store, "!inbox done abc"), /positive integers/i);
});

test("non-owner prompt and empty summary are clear", () => {
  assert.match(getNonOwnerPrompt(), /pass a message to the owner/i);
  assert.equal(formatPendingInboxSummary([]), "Inbox is clear.");
});
