export type LocationCandidate = {
  id?: number;
  name: string;
  country?: string;
  countryCode?: string;
  admin1?: string;
  admin2?: string;
  admin3?: string;
  timezone?: string;
  latitude: number;
  longitude: number;
};

export type CurrentWeather = {
  temperatureC: number;
  windSpeedMS: number;
  windDirectionDegrees: number;
  weatherCode: number;
  isDay: boolean;
  observedAt: string;
};

export type WeatherFoundResult = {
  resultType: "weather_found";
  location: LocationCandidate;
  currentWeather: CurrentWeather;
};

export type LocationAmbiguousResult = {
  resultType: "location_ambiguous";
  query: string;
  message: string;
  candidates: LocationCandidate[];
};

export type LocationNotFoundResult = {
  resultType: "location_not_found";
  query: string;
  message: string;
};

export type ProviderErrorResult = {
  resultType: "provider_error";
  query: string;
  message: string;
};

export type WeatherLookupResult =
  | WeatherFoundResult
  | LocationAmbiguousResult
  | LocationNotFoundResult
  | ProviderErrorResult;

