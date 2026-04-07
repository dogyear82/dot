import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt } from "../src/chat/persona.js";

test("buildSystemPrompt includes sheltered persona guidance", () => {
  const prompt = buildSystemPrompt({
    mode: "sheltered",
    balance: "balanced"
  });

  assert.match(prompt, /sheltered/i);
  assert.match(prompt, /Balance companionship and practical assistance evenly/i);
});

test("buildSystemPrompt includes diagnostic persona guidance", () => {
  const prompt = buildSystemPrompt({
    mode: "diagnostic",
    balance: "assistant"
  });

  assert.match(prompt, /cold, detached, technical tone/i);
  assert.match(prompt, /practical help/i);
});
