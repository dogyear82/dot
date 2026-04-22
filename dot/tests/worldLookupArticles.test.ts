import test from "node:test";
import assert from "node:assert/strict";

import { HtmlWorldLookupArticleReader } from "../src/worldLookupArticles.js";

function createHtmlResponse(html: string, contentType = "text/html; charset=utf-8") {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": contentType
    }
  });
}

test("HtmlWorldLookupArticleReader extracts publisher and article paragraphs", async () => {
  const reader = new HtmlWorldLookupArticleReader(async () =>
    createHtmlResponse(`
      <html>
        <head>
          <meta property="og:site_name" content="Reuters" />
          <meta name="description" content="Fallback description that should not be needed." />
        </head>
        <body>
          <article>
            <p>Myanmar's military government extended emergency rule while fighting continued in several parts of the country, according to recent reporting.</p>
            <p>Opposition groups said airstrikes and artillery attacks intensified after the announcement, adding to displacement concerns.</p>
          </article>
        </body>
      </html>
    `)
  );

  const result = await reader.read({
    evidence: [
      {
        source: "newsdata",
        title: "Myanmar junta extends emergency rule",
        url: "https://example.test/myanmar",
        snippet: "Recent reporting from Reuters.",
        publishedAt: "2026-04-11T08:00:00Z",
        confidence: "high"
      }
    ]
  });

  assert.equal(result.failures.length, 0);
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0]?.publisher, "Reuters");
  assert.match(result.articles[0]?.excerpt ?? "", /military government extended emergency rule/i);
  assert.match(result.articles[0]?.excerpt ?? "", /airstrikes and artillery attacks intensified/i);
});

test("HtmlWorldLookupArticleReader falls back to meta description when paragraphs are unavailable", async () => {
  const reader = new HtmlWorldLookupArticleReader(async () =>
    createHtmlResponse(`
      <html>
        <head>
          <meta property="og:site_name" content="CNN" />
          <meta name="description" content="President addresses the nation after overnight clashes near the capital." />
        </head>
        <body><div>No paragraphs here.</div></body>
      </html>
    `)
  );

  const result = await reader.read({
    evidence: [
      {
        source: "gdelt",
        title: "President addresses the nation",
        url: "https://example.test/capital-clashes",
        snippet: "Recent coverage from cnn.com.",
        publishedAt: "2026-04-11T09:00:00Z",
        confidence: "medium"
      }
    ]
  });

  assert.equal(result.failures.length, 0);
  assert.equal(result.articles[0]?.publisher, "CNN");
  assert.match(result.articles[0]?.excerpt ?? "", /overnight clashes near the capital/i);
});
