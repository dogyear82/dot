import test from "node:test";
import assert from "node:assert/strict";

import { normalizeMessage, stripLeadingBotAddress, stripLeadingBotMention } from "../src/discord/normalize.js";

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
        },
        roles: {
          some: () => false
        }
      },
      createdAt
    } as never,
    { botUserId: "bot-1", botUsername: "Dot", botRoleIds: ["role-bot"] }
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

test("stripLeadingBotMention removes a leading bot mention from server messages", () => {
  assert.equal(stripLeadingBotMention("<@bot-1> sheltered", "bot-1"), "sheltered");
  assert.equal(stripLeadingBotMention("<@!bot-1> settings show", "bot-1"), "settings show");
  assert.equal(stripLeadingBotMention("hello dot", "bot-1"), "hello dot");
});

test("normalizeMessage treats same-name role mentions as Dot mentions", () => {
  const createdAt = new Date("2026-04-07T00:00:00.000Z");

  const normalized = normalizeMessage(
    {
      id: "msg-2",
      channelId: "channel-1",
      guildId: "guild-1",
      author: {
        id: "user-1",
        username: "tan"
      },
      content: "<@&role-1> hello dot",
      mentions: {
        users: {
          has: () => false
        },
        roles: {
          some: (predicate: (role: { id: string }) => boolean) => predicate({ id: "role-bot" })
        }
      },
      createdAt
    } as never,
    { botUserId: "bot-1", botUsername: "Dot", botRoleIds: ["role-bot"] }
  );

  assert.equal(normalized.mentionedBot, true);
});

test("stripLeadingBotAddress removes a same-name role mention prefix", () => {
  assert.equal(
    stripLeadingBotAddress("<@&1492214618611908830> !settings show", {
      botUserId: "bot-1",
      botUsername: "Dot",
      botRoleIds: ["1492214618611908830"]
    }),
    "!settings show"
  );
});

test("normalizeMessage ignores unrelated same-name roles that are not the bot's role", () => {
  const createdAt = new Date("2026-04-07T00:00:00.000Z");

  const normalized = normalizeMessage(
    {
      id: "msg-3",
      channelId: "channel-1",
      guildId: "guild-1",
      author: {
        id: "user-1",
        username: "tan"
      },
      content: "<@&role-other> hello dot",
      mentions: {
        users: {
          has: () => false
        },
        roles: {
          some: (predicate: (role: { id: string }) => boolean) => predicate({ id: "role-other" })
        }
      },
      createdAt
    } as never,
    { botUserId: "bot-1", botUsername: "Dot", botRoleIds: ["role-bot"] }
  );

  assert.equal(normalized.mentionedBot, false);
});

test("stripLeadingBotAddress does not strip unrelated leading role mentions", () => {
  assert.equal(
    stripLeadingBotAddress("<@&role-other> <@&role-bot> !settings show", {
      botUserId: "bot-1",
      botUsername: "Dot",
      botRoleIds: ["role-bot"]
    }),
    "<@&role-other> <@&role-bot> !settings show"
  );
});
