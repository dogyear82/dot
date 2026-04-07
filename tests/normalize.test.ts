import test from "node:test";
import assert from "node:assert/strict";

import { normalizeMessage } from "../src/discord/normalize.js";

test("normalizeMessage maps Discord message shape into IncomingMessage", () => {
  const createdAt = new Date("2026-04-07T00:00:00.000Z");

  const normalized = normalizeMessage(
    {
      id: "msg-1",
      channelId: "channel-1",
      guildId: "guild-1",
      author: {
        id: "user-1",
        username: "tan"
      },
      content: "hello dot",
      mentions: {
        users: {
          has: (id: string) => id === "bot-1"
        }
      },
      createdAt
    } as never,
    "bot-1"
  );

  assert.deepEqual(normalized, {
    id: "msg-1",
    channelId: "channel-1",
    guildId: "guild-1",
    authorId: "user-1",
    authorUsername: "tan",
    content: "hello dot",
    isDirectMessage: false,
    mentionedBot: true,
    createdAt: createdAt.toISOString()
  });
});
