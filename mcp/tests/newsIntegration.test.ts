import { describe, expect, it } from "vitest";

import { NewsLookupClient } from "../src/integrations/news.js";

describe("NewsLookupClient", () => {
  it("returns partial results when one provider fails", async () => {
    const client = new NewsLookupClient({
      newsDataApiKey: "test-key",
      gdeltDocApiUrl: "https://api.gdeltproject.org/api/v2/doc/doc",
      requestTimeoutMs: 50,
      fetchImpl: async (input) => {
        const url = typeof input === "string" || input instanceof URL ? new URL(String(input)) : new URL(input.url);

        if (url.hostname === "newsdata.io") {
          return new Response(
            JSON.stringify({
              results: [
                {
                  title: "Iran talks continue",
                  link: "https://example.com/iran-talks",
                  description: "Diplomatic talks continued overnight.",
                  source_name: "Example News"
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        throw new Error("simulated gdelt timeout");
      }
    });

    await expect(client.getBriefing("iran")).resolves.toMatchObject([
      {
        title: "Iran talks continue"
      }
    ]);
  });
});
