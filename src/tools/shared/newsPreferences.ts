import type { Persistence } from "../../persistence.js";
import type { NewsPreferences } from "../../types.js";
import type { SettingsStore } from "../../settings.js";

const DEFAULT_NEWS_PREFERENCES: NewsPreferences = {
  interestedTopics: [],
  uninterestedTopics: [],
  preferredOutlets: [],
  blockedOutlets: []
};

export function isNewsPreferencesCommand(content: string): boolean {
  return content.startsWith("!news");
}

export function getNewsPreferences(settings: SettingsStore): NewsPreferences {
  const raw = settings.get("news.preferences");
  if (!raw) {
    return { ...DEFAULT_NEWS_PREFERENCES };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<NewsPreferences>;
    return {
      interestedTopics: normalizeList(parsed.interestedTopics),
      uninterestedTopics: normalizeList(parsed.uninterestedTopics),
      preferredOutlets: normalizeList(parsed.preferredOutlets),
      blockedOutlets: normalizeList(parsed.blockedOutlets)
    };
  } catch {
    return { ...DEFAULT_NEWS_PREFERENCES };
  }
}

export function setNewsPreferences(settings: SettingsStore, preferences: NewsPreferences): void {
  settings.set(
    "news.preferences",
    JSON.stringify({
      interestedTopics: normalizeList(preferences.interestedTopics),
      uninterestedTopics: normalizeList(preferences.uninterestedTopics),
      preferredOutlets: normalizeList(preferences.preferredOutlets),
      blockedOutlets: normalizeList(preferences.blockedOutlets)
    })
  );
}

export function handleNewsPreferencesCommand(persistence: Persistence, content: string): string {
  const parts = content.trim().split(/\s+/);
  const command = parts[1];
  const action = parts[2];

  if (!command || command === "help") {
    return buildHelpReply();
  }

  if (command !== "prefs") {
    return "Unknown news command. Use `!news help`.";
  }

  const preferences = getNewsPreferences(persistence.settings);
  if (!action || action === "show") {
    return formatPreferences(preferences);
  }

  if (action !== "add" && action !== "remove") {
    return "Unknown news prefs command. Use `!news help`.";
  }

  const category = normalizeCategory(parts[3] ?? "");
  const value = parts.slice(4).join(" ").trim();
  if (!category || value.length === 0) {
    return "Invalid news prefs command. Use `!news help`.";
  }

  const current = preferences[category];
  const normalizedValue = normalizeValue(value);
  const nextValues =
    action === "add"
      ? Array.from(new Set([...current, normalizedValue])).sort()
      : current.filter((entry) => entry !== normalizedValue);
  const nextPreferences: NewsPreferences = {
    ...preferences,
    [category]: nextValues
  };
  setNewsPreferences(persistence.settings, nextPreferences);

  return `${action === "add" ? "Saved" : "Removed"} \`${normalizedValue}\` in \`${category}\`.\n\n${formatPreferences(
    nextPreferences
  )}`;
}

function buildHelpReply(): string {
  return [
    "News preference commands:",
    "- `!news prefs show`",
    "- `!news prefs add interested <topic>`",
    "- `!news prefs add uninterested <topic>`",
    "- `!news prefs add preferred <outlet>`",
    "- `!news prefs add blocked <outlet>`",
    "- `!news prefs remove interested <topic>`",
    "- `!news prefs remove uninterested <topic>`",
    "- `!news prefs remove preferred <outlet>`",
    "- `!news prefs remove blocked <outlet>`"
  ].join("\n");
}

function formatPreferences(preferences: NewsPreferences): string {
  return [
    "News preferences:",
    `- interestedTopics: ${formatList(preferences.interestedTopics)}`,
    `- uninterestedTopics: ${formatList(preferences.uninterestedTopics)}`,
    `- preferredOutlets: ${formatList(preferences.preferredOutlets)}`,
    `- blockedOutlets: ${formatList(preferences.blockedOutlets)}`
  ].join("\n");
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

function normalizeList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map(normalizeValue)
        .filter((value) => value.length > 0)
    )
  ).sort();
}

function normalizeCategory(value: string): keyof NewsPreferences | null {
  switch (value) {
    case "interested":
    case "interestedTopics":
      return "interestedTopics";
    case "uninterested":
    case "uninterestedTopics":
      return "uninterestedTopics";
    case "preferred":
    case "preferredOutlets":
      return "preferredOutlets";
    case "blocked":
    case "blockedOutlets":
      return "blockedOutlets";
    default:
      return null;
  }
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}
