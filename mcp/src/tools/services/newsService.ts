import { NewsLookupClient, NewsLookupError } from "../../integrations/news.js";
import type {
  NewsBriefingFoundResult,
  NewsBriefingNoResultsResult,
  NewsBriefingProviderErrorResult,
  NewsBriefingResult
} from "../../models/news.js";

export type NewsSettings = {
    newsDataApiKey: string;
    gdeltDocApiUrl: string;
}

export const createNewsService = (settings: NewsSettings): NewsService => {
    return new NewsService(
        new NewsLookupClient({
            newsDataApiKey: settings.newsDataApiKey,
            gdeltDocApiUrl: settings.gdeltDocApiUrl
        })
    );
}

export class NewsService {
  constructor(private readonly client: NewsLookupClient) {}

  async getNewsBriefing(query: string): Promise<NewsBriefingResult> {
    const normalizedQuery = query.trim();

    try {
      const briefing = await this.client.getBriefing(normalizedQuery);

      if (briefing.length === 0) {
        return {
          resultType: "news_briefing_no_results",
          query: normalizedQuery,
          message: `No results found for query: ${normalizedQuery}.`
        } satisfies NewsBriefingNoResultsResult;
      }

      return {
        resultType: "news_briefing_found",
        query: normalizedQuery,
        briefing
      } satisfies NewsBriefingFoundResult;
    } catch (error) {
      return {
        resultType: "news_briefing_provider_error",
        query: normalizedQuery,
        message: error instanceof NewsLookupError ? error.message : String(error)
      } satisfies NewsBriefingProviderErrorResult;
    }
  }

  async testFunc(): Promise<string> {
    const huh = this.getNewsBriefing
    return "blah";
  }
}
