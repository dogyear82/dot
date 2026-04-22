export type Settings = {
  host: string;
  port: number;
  weatherSearchLimit: number;
  openMeteoGeocodingUrl: string;
  openMeteoForecastUrl: string;
  newsDataApiKey: string;
  gdeltDocApiUrl: string;
};

const parseInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected integer environment variable, received "${value}"`);
  }

  return parsed;
};

export const loadSettings = (): Settings => ({
  host: process.env.DOT_MCP_HOST ?? "127.0.0.1",
  port: parseInteger(process.env.DOT_MCP_PORT, 8000),
  weatherSearchLimit: parseInteger(process.env.DOT_MCP_WEATHER_SEARCH_LIMIT, 5),
  openMeteoGeocodingUrl:
    process.env.DOT_MCP_OPEN_METEO_GEOCODING_URL ??
    "https://geocoding-api.open-meteo.com/v1/search",
  openMeteoForecastUrl:
    process.env.DOT_MCP_OPEN_METEO_FORECAST_URL ?? "https://api.open-meteo.com/v1/forecast",
  newsDataApiKey: process.env.NEWSDATA_API_KEY?.trim() ?? "",
  gdeltDocApiUrl: process.env.DOT_MCP_GDELT_DOC_API_URL ?? "https://api.gdeltproject.org/api/v2/doc/doc"
});
