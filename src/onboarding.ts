import type { SettingsStore } from "./settings.js";
import { listUserEditableSettingDefinitions } from "./settings.js";

const onboardingQuestions = listUserEditableSettingDefinitions();

export interface OnboardingResult {
  reply: string;
  onboardingComplete: boolean;
}

export function getOnboardingPrompt(settingsStore: SettingsStore): string {
  const nextQuestion = getNextQuestion(settingsStore);

  if (!nextQuestion) {
    return "Onboarding is already complete. Use `settings show` to review your configuration.";
  }

  return formatQuestion(nextQuestion.label, nextQuestion.description, nextQuestion.allowedValues);
}

export function handleOnboardingReply(settingsStore: SettingsStore, reply: string): OnboardingResult {
  const nextQuestion = getNextQuestion(settingsStore);

  if (!nextQuestion) {
    return {
      reply: "Onboarding is already complete. Use `settings show` to review or `settings set <key> <value>` to update a setting.",
      onboardingComplete: true
    };
  }

  const answer = reply.trim();
  if (nextQuestion.allowedValues && !nextQuestion.allowedValues.includes(answer)) {
    return {
      reply: `Please reply with one of: ${nextQuestion.allowedValues.join(", ")}\n\n${formatQuestion(
        nextQuestion.label,
        nextQuestion.description,
        nextQuestion.allowedValues
      )}`,
      onboardingComplete: false
    };
  }

  settingsStore.set(nextQuestion.key, answer);

  const upcomingQuestion = getNextQuestion(settingsStore);

  if (!upcomingQuestion) {
    settingsStore.set("onboarding.completed", "true");
    return {
      reply: "Onboarding complete. Use `settings show` to review your saved settings.",
      onboardingComplete: true
    };
  }

  return {
    reply: `Saved \`${nextQuestion.key}\` = \`${answer}\`\n\n${formatQuestion(
      upcomingQuestion.label,
      upcomingQuestion.description,
      upcomingQuestion.allowedValues
    )}`,
    onboardingComplete: false
  };
}

export function isSettingsCommand(content: string): boolean {
  return content.startsWith("settings");
}

export function handleSettingsCommand(settingsStore: SettingsStore, content: string): string {
  const parts = content.trim().split(/\s+/);

  if (parts.length === 1 || parts[1] === "help") {
    return [
      "Settings commands:",
      "- `settings show`",
      "- `settings set <key> <value>`",
      "User-editable keys:",
      ...listUserEditableSettingDefinitions().map((definition) => `- \`${definition.key}\``)
    ].join("\n");
  }

  if (parts[1] === "show") {
    const settings = settingsStore.getAllUserEditable();
    return [
      "Current settings:",
      ...Object.entries(settings).map(([key, value]) => `- \`${key}\` = \`${value}\``)
    ].join("\n");
  }

  if (parts[1] === "set" && parts.length >= 4) {
    const key = parts[2];
    const value = parts.slice(3).join(" ");
    const definition = listUserEditableSettingDefinitions().find((item) => item.key === key);

    if (!definition) {
      return "Unknown setting key. Use `settings help`.";
    }

    try {
      settingsStore.set(definition.key, value);
      return `Updated \`${definition.key}\` to \`${value}\`.`;
    } catch (error) {
      return error instanceof Error ? error.message : "Failed to update setting.";
    }
  }

  return "Invalid settings command. Use `settings help`.";
}

function getNextQuestion(settingsStore: SettingsStore) {
  return onboardingQuestions.find((definition) => !settingsStore.isConfigured(definition.key));
}

function formatQuestion(label: string, description: string, allowedValues?: readonly string[]) {
  return `Setup: ${label}\n${description}\nReply with one of: ${allowedValues?.join(", ") ?? "free-form"}`;
}
