import test from "node:test";
import assert from "node:assert/strict";

import { OneMinAiChatProvider } from "../src/chat/providers.js";

test("1minAI provider uses the documented endpoint, auth header, and prompt shape", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        aiRecord: {
          aiRecordDetail: {
            resultObject: ["hello from 1minAI"]
          }
        }
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  };

  const provider = new OneMinAiChatProvider("https://api.1min.ai", "secret-key", "gpt-4.1-mini", 20000, fetchFn);
  const reply = await provider.generate([
    { role: "system", content: "You are Dot." },
    { role: "user", content: "hello" }
  ]);

  assert.equal(reply, "hello from 1minAI");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.1min.ai/api/chat-with-ai");
  assert.equal((calls[0]?.init?.headers as Record<string, string>)["API-KEY"], "secret-key");

  const body = JSON.parse(String(calls[0]?.init?.body)) as {
    type: string;
    model: string;
    promptObject: { prompt: string };
  };
  assert.equal(body.type, "UNIFY_CHAT_WITH_AI");
  assert.equal(body.model, "gpt-4.1-mini");
  assert.equal(body.promptObject.prompt, "SYSTEM: You are Dot.\n\nUSER: hello");
});

test("1minAI provider rejects empty result payloads", async () => {
  const fetchFn: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        aiRecord: {
          aiRecordDetail: {
            resultObject: []
          }
        }
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

  const provider = new OneMinAiChatProvider("https://api.1min.ai", "secret-key", "gpt-4.1-mini", 20000, fetchFn);

  await assert.rejects(() => provider.generate([{ role: "user", content: "hello" }]), /1minAI returned an empty response/);
});
