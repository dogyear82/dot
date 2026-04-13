import type { WorldLookupArticleRecord, WorldLookupEvidenceRecord } from "./types.js";

const DEFAULT_ARTICLE_READ_TIMEOUT_MS = 3_500;

export type FetchLike = typeof fetch;

export interface WorldLookupArticleReader {
  read(params: {
    evidence: WorldLookupEvidenceRecord[];
    timeoutMs?: number;
  }): Promise<{
    articles: WorldLookupArticleRecord[];
    failures: string[];
  }>;
}

export class HtmlWorldLookupArticleReader implements WorldLookupArticleReader {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async read(params: {
    evidence: WorldLookupEvidenceRecord[];
    timeoutMs?: number;
  }): Promise<{
    articles: WorldLookupArticleRecord[];
    failures: string[];
  }> {
    const timeoutMs = params.timeoutMs ?? DEFAULT_ARTICLE_READ_TIMEOUT_MS;
    const candidates = params.evidence
      .filter((record): record is WorldLookupEvidenceRecord & { url: string } => typeof record.url === "string" && record.url.length > 0)
      .slice(0, 3);

    const settled = await Promise.all(
      candidates.map(async (record) => {
        try {
          const response = await this.fetchImpl(record.url, {
            headers: {
              Accept: "text/html,application/xhtml+xml",
              "User-Agent": "dot/0.1 (+https://github.com/dogyear82/dot)"
            },
            signal: AbortSignal.timeout(timeoutMs)
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.includes("text/html")) {
            throw new Error(`unsupported content type: ${contentType || "unknown"}`);
          }

          const html = await response.text();
          const article = extractArticleRecord(record, html);
          if (!article) {
            throw new Error("could not extract usable article text");
          }

          return {
            status: "fulfilled" as const,
            article
          };
        } catch (error) {
          return {
            status: "rejected" as const,
            reason: `${record.url}: ${error instanceof Error ? error.message : "unknown error"}`
          };
        }
      })
    );

    return {
      articles: settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.article] : [])),
      failures: settled.flatMap((entry) => (entry.status === "rejected" ? [entry.reason] : []))
    };
  }
}

function extractArticleRecord(
  record: WorldLookupEvidenceRecord & { url: string },
  html: string
): WorldLookupArticleRecord | null {
  const metaDescription =
    extractMetaContent(html, "meta[name=\"description\"]") ??
    extractMetaContent(html, "meta[property=\"og:description\"]");
  const publisher =
    extractMetaContent(html, "meta[property=\"og:site_name\"]") ??
    extractPublisherFromUrl(record.url) ??
    formatSourceName(record.source);

  const body = extractArticleBody(html);
  const paragraphs = Array.from(body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi))
    .map((match) => cleanupHtmlText(match[1] ?? ""))
    .filter((text) => text.length >= 80)
    .slice(0, 5);

  const excerptParts = [...paragraphs];
  if (excerptParts.length === 0 && metaDescription) {
    excerptParts.push(cleanupHtmlText(metaDescription));
  }
  if (excerptParts.length === 0 && record.snippet.trim().length > 0) {
    excerptParts.push(record.snippet.trim());
  }

  const excerpt = excerptParts
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_800);

  const minimumLength = paragraphs.length > 0 ? 80 : 40;
  if (excerpt.length < minimumLength) {
    return null;
  }

  return {
    source: record.source,
    title: record.title,
    url: record.url,
    publisher,
    publishedAt: record.publishedAt,
    excerpt
  };
}

function extractArticleBody(html: string): string {
  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const bodyCandidate = articleMatch?.[1] ?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return bodyCandidate
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
}

function extractMetaContent(html: string, selector: string): string | null {
  if (selector === "meta[name=\"description\"]") {
    return (
      html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1] ??
      html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i)?.[1] ??
      null
    );
  }

  if (selector === "meta[property=\"og:description\"]") {
    return (
      html.match(/<meta\b[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1] ??
      html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["'][^>]*>/i)?.[1] ??
      null
    );
  }

  if (selector === "meta[property=\"og:site_name\"]") {
    return (
      html.match(/<meta\b[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1] ??
      html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:site_name["'][^>]*>/i)?.[1] ??
      null
    );
  }

  return null;
}

function cleanupHtmlText(value: string): string {
  return decodeEntities(
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractPublisherFromUrl(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    const labels = hostname.split(".");
    const root = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    if (!root) {
      return null;
    }

    return root
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  } catch {
    return null;
  }
}

function formatSourceName(source: WorldLookupEvidenceRecord["source"]): string {
  switch (source) {
    case "newsdata":
      return "NewsData.io";
    case "wikimedia_current_events":
      return "Wikinews";
    case "gdelt":
      return "GDELT";
    case "wikipedia":
      return "Wikipedia";
    case "open_meteo":
      return "Open-Meteo";
    case "world_bank":
      return "World Bank";
  }
}
