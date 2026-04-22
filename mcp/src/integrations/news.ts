import type { NewsBriefingItem } from "../models/news.js";

type FetchLike = typeof fetch;

type NewsClientOptions = {
  newsDataApiKey: string;
  gdeltDocApiUrl: string;
  fetchImpl?: FetchLike;
};

type NewsDataResponse = {
  results?: Array<{
    title?: string | null;
    link?: string | null;
    description?: string | null;
    content?: string | null;
    pubDate?: string | null;
    source_name?: string | null;
    source_url?: string | null;
  }>;
};

type GdeltResponse = {
  articles?: Array<{
    title?: string | null;
    url?: string | null;
    seendate?: string | null;
    domain?: string | null;
  }>;
};

export class NewsLookupError extends Error {}

export class NewsLookupClient {
  private readonly newsDataApiKey: string;
  private readonly gdeltDocApiUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: NewsClientOptions) {
    this.newsDataApiKey = options.newsDataApiKey;
    this.gdeltDocApiUrl = options.gdeltDocApiUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getBriefing(query: string): Promise<NewsBriefingItem[]> {
    const normalizedQuery = query.trim();
    const genericHeadlines = looksLikeGenericHeadlinesQuery(normalizedQuery);

    const [newsDataItems, gdeltItems] = await Promise.all([
      this.lookupNewsData(normalizedQuery, genericHeadlines),
      genericHeadlines ? Promise.resolve([]) : this.lookupGdelt(normalizedQuery)
    ]);

    return dedupeBriefingItems([...newsDataItems, ...gdeltItems]).slice(0, 5);
  }

  private async lookupNewsData(query: string, genericHeadlines: boolean): Promise<NewsBriefingItem[]> {
    if (!this.newsDataApiKey) {
      return [];
    }

    const url = new URL("https://newsdata.io/api/1/latest");
    url.searchParams.set("apikey", this.newsDataApiKey);
    if (!genericHeadlines) {
      url.searchParams.set("q", query);
    }
    url.searchParams.set("size", genericHeadlines ? "10" : "6");
    url.searchParams.set("language", "en");

    const payload = await this.fetchJson<NewsDataResponse>(url, "NewsData");

    return (payload.results ?? [])
      .filter((article) => typeof article.title === "string" && article.title.trim() !== "")
      .map((article) => ({
        title: article.title!.trim(),
        url: article.link ?? article.source_url ?? null,
        snippet:
          [article.description, article.content]
            .find((value): value is string => typeof value === "string" && value.trim() !== "")
            ?.trim() ??
          (article.source_name ? `Recent reporting from ${article.source_name}.` : "Recent news coverage."),
        source: "newsdata",
        publisher: article.source_name ?? null,
        publishedAt: article.pubDate ?? null
      }));
  }

  private async lookupGdelt(query: string): Promise<NewsBriefingItem[]> {
    const url = new URL(this.gdeltDocApiUrl);
    url.searchParams.set("query", query);
    url.searchParams.set("mode", "artlist");
    url.searchParams.set("format", "json");
    url.searchParams.set("maxrecords", "6");
    url.searchParams.set("sort", "datedesc");

    const payload = await this.fetchJson<GdeltResponse>(url, "GDELT");

    return (payload.articles ?? [])
      .filter((article) => typeof article.title === "string" && article.title.trim() !== "")
      .map((article) => ({
        title: article.title!.trim(),
        url: article.url ?? null,
        snippet: article.domain ? `Recent coverage reported by ${article.domain}.` : "Recent news coverage.",
        source: "gdelt",
        publisher: article.domain ?? null,
        publishedAt: article.seendate ?? null
      }));
  }

  private async fetchJson<T>(url: URL, provider: string): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: "application/json"
        }
      });
    } catch (error) {
      throw new NewsLookupError(
        `${provider} request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!response.ok) {
      throw new NewsLookupError(`${provider} returned HTTP ${response.status} for ${url.toString()}`);
    }

    return (await response.json()) as T;
  }
}

function looksLikeGenericHeadlinesQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    /\b(latest headlines|top headlines|headline|headlines|top news|news today|today('?s)? news)\b/.test(normalized) ||
    /\bwhat('?s| is) in the news\b/.test(normalized) ||
    /\bbrief me on the news\b/.test(normalized)
  );
}

function dedupeBriefingItems(items: NewsBriefingItem[]): NewsBriefingItem[] {
  const seen = new Set<string>();
  const results: NewsBriefingItem[] = [];

  for (const item of items) {
    const key = `${item.url ?? ""}::${item.title.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(item);
  }

  return results;
}
