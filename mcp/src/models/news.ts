export type NewsBriefingItem = {
  title: string;
  url: string | null;
  snippet: string;
  source: "newsdata" | "gdelt";
  publisher: string | null;
  publishedAt: string | null;
};

export type NewsBriefingFoundResult = {
  resultType: "news_briefing_found";
  query: string;
  briefing: NewsBriefingItem[];
};

export type NewsBriefingNoResultsResult = {
  resultType: "news_briefing_no_results";
  query: string;
  message: string;
};

export type NewsBriefingProviderErrorResult = {
  resultType: "news_briefing_provider_error";
  query: string;
  message: string;
};

export type NewsBriefingResult =
  | NewsBriefingFoundResult
  | NewsBriefingNoResultsResult
  | NewsBriefingProviderErrorResult;
