import test from "node:test";
import assert from "node:assert/strict";

import { splitDiscordMessage } from "../src/discord/outboundChunking.js";

test("splitDiscordMessage keeps short replies unchanged", () => {
  assert.deepEqual(splitDiscordMessage("short reply", 50), ["short reply"]);
});

test("splitDiscordMessage prefers paragraph boundaries", () => {
  const chunks = splitDiscordMessage("para one\n\npara two\n\npara three", 12);

  assert.deepEqual(chunks, ["para one", "para two", "para three"]);
});

test("splitDiscordMessage falls back below paragraph boundaries for oversized blocks", () => {
  const chunks = splitDiscordMessage("This is a large paragraph. It needs sentence splitting. Then a final sentence.", 35);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 35));
  assert.equal(
    chunks.join(" ").replace(/\s+/g, " ").trim(),
    "This is a large paragraph. It needs sentence splitting. Then a final sentence."
  );
});

test("splitDiscordMessage preserves fenced code blocks across chunks", () => {
  const content = "```txt\nline 1\nline 2\nline 3\nline 4\nline 5\n```";
  const chunks = splitDiscordMessage(content, 20);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.startsWith("```txt\n"));
    assert.ok(chunk.endsWith("\n```"));
  }
});
