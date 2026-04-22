import { NewsLookupClient, NewsLookupError } from "../integrations/news.js";
import type {
  NewsBriefingFoundResult,
  NewsBriefingNoResultsResult,
  NewsBriefingProviderErrorResult,
  NewsBriefingResult
} from "../models/news.js";

export class NewsToolService {
  constructor(private readonly client: NewsLookupClient) {}

  async getNewsBriefing(query: string): Promise<NewsBriefingResult> {
    const normalizedQuery = query.trim();

    try {
      const briefing = await this.client.getBriefing(normalizedQuery);

      if (briefing.length === 0) {
        return {
          resultType: "news_briefing_no_results",
          query: normalizedQuery,
          message: "I couldn't pull together a reliable news briefing from the public sources I checked just now."
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
}
