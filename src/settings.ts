import type Database from "better-sqlite3";

export type SettingKey =
  | "persona.mode"
  | "persona.balance"
  | "channels.defaultPolicy"
  | "reminders.escalationPolicy"
  | "models.primary"
  | "onboarding.completed";

export interface SettingDefinition {
  key: SettingKey;
  label: string;
  description: string;
  allowedValues?: readonly string[];
  defaultValue?: string;
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
    key: "models.primary",
    label: "Primary model provider",
    description: "Default provider routing preference",
    allowedValues: ["ollama", "1minai"],
    defaultValue: "ollama",
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
    if (definition.key === "onboarding.completed" && definition.defaultValue != null && getStatement.get(definition.key) == null) {
      setStatement.run(definition.key, definition.defaultValue);
    }
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
