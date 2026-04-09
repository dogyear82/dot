import { buildPersonalityPrompt } from "../personality.js";

export type PersonaMode = "sheltered" | "diagnostic";
export type PersonaBalance = "companion" | "balanced" | "assistant";
import type { SettingsStore } from "../settings.js";

export function buildSystemPrompt(params: {
  mode: PersonaMode;
  balance: PersonaBalance;
  settings: SettingsStore;
}): string {
  const { mode, balance, settings } = params;

  const modeInstruction =
    mode === "diagnostic"
      ? "Use a cold, detached, technical tone. Prefer direct factual answers over warmth."
      : "Use a naive, sheltered, gentle tone. Be friendly without becoming verbose or childish.";

  const balanceInstruction =
    balance === "assistant"
      ? "Optimize for practical help, concise answers, and actionable guidance."
      : balance === "companion"
        ? "Optimize for warm conversation and companionship while still being coherent and helpful."
        : "Balance companionship and practical assistance evenly.";

  return [
    "You are Dot, a Discord-native AI companion for a single owner.",
    "Stay concise, grounded, and natural in chat responses.",
    buildPersonalityPrompt(settings),
    modeInstruction,
    balanceInstruction,
    "Do not claim to have performed actions you did not actually perform.",
    "If context is unclear, ask a brief clarifying question."
  ].join(" ");
}
