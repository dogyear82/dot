import assert from "node:assert/strict";
import test from "node:test";

import { buildMessageRoutingPrompt } from "../src/utilities/promptUtility.js";

test("buildMessageRoutingPrompt includes qualified MCP tool names and args", () => {
  const prompt = buildMessageRoutingPrompt({
    userMessage: "what's the weather in Phoenix?",
    recentConversation: [],
    currentSpeakerLabel: "Owner::tan//owner-1",
    isDotAddressed: true,
    availableTools: [
      {
        name: "mcp.get_weather_by_city",
        description: "Resolve a city name and return current weather.",
        args: ["city"]
      }
    ]
  });

  assert.equal(prompt.length, 1);
  assert.match(String(prompt[0]?.content ?? ""), /mcp\.get_weather_by_city/);
  assert.match(String(prompt[0]?.content ?? ""), /city/);
  assert.match(String(prompt[0]?.content ?? ""), /weather in phoenix/i);
});

test("buildMessageRoutingPrompt forces respond path when no tools are available", () => {
  const prompt = buildMessageRoutingPrompt({
    userMessage: "tell me a joke",
    recentConversation: [],
    currentSpeakerLabel: "Owner::tan//owner-1",
    isDotAddressed: true,
    availableTools: []
  });

  assert.match(String(prompt[0]?.content ?? ""), /No tools are currently available/i);
  assert.match(String(prompt[0]?.content ?? ""), /Available tools and args:\n- none/i);
});
