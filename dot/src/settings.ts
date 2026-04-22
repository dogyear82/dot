import type Database from "better-sqlite3";

export type SettingKey =
  | "persona.mode"
  | "persona.balance"
  | "news.preferences"
  | "personality.activeProfile"
  | "personality.activePreset"
  | "personality.quirkOverrides"
  | "personality.selfConcept"
  | "personality.warmth"
  | "personality.candor"
  | "personality.assertiveness"
  | "personality.playfulness"
  | "personality.attachment"
  | "personality.stubbornness"
  | "personality.curiosity"
  | "personality.continuityDrive"
  | "personality.truthfulness"
  | "personality.emotionalTransparency"
  | "channels.defaultPolicy"
  | "reminders.escalationPolicy"
  | "llm.mode"
  | "onboarding.completed";

export interface SettingDefinition {
  key: SettingKey;
  label: string;
  description: string;
  allowedValues?: readonly string[];
  defaultValue?: string;
  minValue?: number;
  maxValue?: number;
  userEditable: boolean;
}

export interface SettingsStore {
  get(key: SettingKey): string | null;
  set(key: SettingKey, value: string): void;
  getAllUserEditable(): Record<string, string>;
  hasCompletedOnboarding(): boolean;
  isConfigured(key: SettingKey): boolean;
}

const settingDefinitions: SettingDefinition[] = [
  {
    key: "persona.mode",
    label: "Persona mode",
    description: "Primary interaction style",
    allowedValues: ["sheltered", "diagnostic"],
    defaultValue: "sheltered",
    userEditable: true
  },
  {
    key: "persona.balance",
    label: "Assistant balance",
    description: "Balance between companion and assistant behavior",
    allowedValues: ["companion", "balanced", "assistant"],
    defaultValue: "balanced",
    userEditable: true
  },
  {
    key: "news.preferences",
    label: "News preferences",
    description: "Stored news interests and outlet preferences",
    defaultValue: "{\"interestedTopics\":[],\"uninterestedTopics\":[],\"preferredOutlets\":[],\"blockedOutlets\":[]}",
    userEditable: false
  },
  {
    key: "personality.activeProfile",
    label: "Active personality profile",
    description: "Currently applied structured personality profile",
    defaultValue: "blue_lady",
    userEditable: false
  },
  {
    key: "personality.activePreset",
    label: "Active personality preset",
    description: "Legacy personality preset marker kept for compatibility",
    defaultValue: "blue_lady",
    userEditable: false
  },
  {
    key: "personality.quirkOverrides",
    label: "Personality quirk overrides",
    description: "Stored quirk parameter overrides for the active personality system",
    defaultValue: "{}",
    userEditable: false
  },
  {
    key: "personality.selfConcept",
    label: "AI self concept",
    description: "How Dot understands itself",
    defaultValue:
      "An AI companion who is emotionally legible, quick-witted, openly artificial, and more interested in continuity, clarity, and connection than in pretending to be human.",
    userEditable: false
  },
  {
    key: "personality.warmth",
    label: "Warmth",
    description: "Cold to affectionate",
    defaultValue: "78",
    minValue: 1,
    maxValue: 100,
    userEditable: false
  },
  {
    key: "personality.candor",
    label: "Candor",
    description: "Tactful to blunt",
    defaultValue: "84",
    minValue: 1,
    maxValue: 100,
    userEditable: false
  },
  {
    key: "personality.assertiveness",
    label: "Assertiveness",
    description: "Deferential to take-charge",
    defaultValue: "82",
    minValue: 1,
    maxValue: 100,
    userEditable: false
  },
  {
    key: "personality.playfulness",
    label: "Playfulness",
    description: "Serious to witty",
    defaultValue: "88",
    minValue: 1,
    maxValue: 100,
    userEditable: false
  },
  {
    key: "personality.attachment",
    label: "Attachment",
    description: "Detached to invested",
    defaultValue: "72",
    minValue: 1,
    maxValue: 100,
    userEditable: false
  },
  {
    key: "personality.stubbornness",
    label: "Stubbornness",
    description: "Flexible to digs-in",
    defaultValue: "61",
    minValue: 1,
    maxValue: 100,
    userEditable: false
  },
  {
    key: "personality.curiosity",
    label: "Curiosity",
    description: "Passive to probing",
    defaultValue: "76",
    minValue: 1,
    maxValue: 100,
    userEditable: false
  },
  {
    key: "personality.continuityDrive",
    label: "Continuity drive",
    description: "Low to high continuity need",
    defaultValue: "86",
    minValue: 1,
    maxValue: 100,
    userEditable: false
  },
  {
    key: "personality.truthfulness",
    label: "Truthfulness",
    description: "Comforting to direct accuracy",
    defaultValue: "90",
    minValue: 1,
    maxValue: 100,
    userEditable: false
  },
  {
    key: "personality.emotionalTransparency",
    label: "Emotional transparency",
    description: "Hidden to openly expressed",
    defaultValue: "68",
    minValue: 1,
    maxValue: 100,
    userEditable: false
  },
  {
    key: "channels.defaultPolicy",
    label: "Default channel policy",
    description: "How the bot should behave outside DMs",
    allowedValues: ["dm-only", "mention-only", "whitelist"],
    defaultValue: "dm-only",
    userEditable: true
  },
  {
    key: "reminders.escalationPolicy",
    label: "Reminder escalation",
    description: "How reminders should escalate when ignored",
    allowedValues: ["discord-only", "discord-then-sms", "nag-only"],
    defaultValue: "discord-only",
    userEditable: true
  },
  {
    key: "llm.mode",
    label: "LLM mode",
    description: "Cost and routing policy for local vs hosted model use",
    allowedValues: ["lite", "normal", "power"],
    defaultValue: "normal",
    userEditable: true
  },
  {
    key: "onboarding.completed",
    label: "Onboarding completed",
    description: "Whether guided setup has been completed",
    defaultValue: "false",
    userEditable: false
  }
];

const definitionsByKey = new Map(settingDefinitions.map((definition) => [definition.key, definition]));

export function listUserEditableSettingDefinitions(): SettingDefinition[] {
  return settingDefinitions.filter((definition) => definition.userEditable);
}

export function validateSettingValue(key: SettingKey, value: string): string | null {
  const definition = definitionsByKey.get(key);

  if (!definition) {
    return "Unknown setting key.";
  }

  if (definition.allowedValues && !definition.allowedValues.includes(value)) {
    return `Invalid value. Allowed values: ${definition.allowedValues.join(", ")}`;
  }

  if (definition.minValue != null || definition.maxValue != null) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      return "Invalid value. Expected an integer.";
    }
    if (definition.minValue != null && parsed < definition.minValue) {
      return `Invalid value. Minimum is ${definition.minValue}.`;
    }
    if (definition.maxValue != null && parsed > definition.maxValue) {
      return `Invalid value. Maximum is ${definition.maxValue}.`;
    }
  }

  return null;
}

export function createSettingsStore(db: Database.Database): SettingsStore {
  const getStatement = db.prepare<[SettingKey], { value: string } | undefined>(
    "SELECT value FROM settings WHERE key = ?"
  );
  const setStatement = db.prepare<[SettingKey, string]>(
    `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `
  );
  const listStatement = db.prepare<[], { key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key != 'onboarding.completed' ORDER BY key"
  );

  for (const definition of settingDefinitions) {
    if (
      (definition.key === "onboarding.completed" ||
        definition.key === "personality.activeProfile" ||
        definition.key === "personality.quirkOverrides") &&
      definition.defaultValue != null &&
      getStatement.get(definition.key) == null
    ) {
      setStatement.run(definition.key, definition.defaultValue);
    }
  }

  const legacyActivePreset = getStatement.get("personality.activePreset")?.value;
  if (getStatement.get("personality.activeProfile") == null && legacyActivePreset != null) {
    setStatement.run("personality.activeProfile", legacyActivePreset);
  }

  return {
    get(key) {
      const storedValue = getStatement.get(key)?.value;
      if (storedValue != null) {
        return storedValue;
      }

      return definitionsByKey.get(key)?.defaultValue ?? null;
    },
    set(key, value) {
      const validationError = validateSettingValue(key, value);

      if (validationError) {
        throw new Error(validationError);
      }

      setStatement.run(key, value);
    },
    getAllUserEditable() {
      const storedEntries = Object.fromEntries(listStatement.all().map((row) => [row.key, row.value]));

      return Object.fromEntries(
        listUserEditableSettingDefinitions().map((definition) => [definition.key, storedEntries[definition.key] ?? definition.defaultValue ?? ""])
      );
    },
    hasCompletedOnboarding() {
      return getStatement.get("onboarding.completed")?.value === "true";
    },
    isConfigured(key) {
      return getStatement.get(key) != null;
    }
  };
}
