import type { Persistence } from "./persistence.js";
import { getBuiltInPersonalityProfile, listBuiltInPersonalityProfiles, blueLadyProfile } from "./personalityProfiles.js";
import type { SettingsStore } from "./settings.js";
import type { PersonalityPresetRecord, PersonalityProfileRecord } from "./types.js";

export const personalityTraitDefinitions = [
  { key: "personality.warmth", label: "warmth" },
  { key: "personality.candor", label: "candor" },
  { key: "personality.assertiveness", label: "assertiveness" },
  { key: "personality.playfulness", label: "playfulness" },
  { key: "personality.attachment", label: "attachment" },
  { key: "personality.stubbornness", label: "stubbornness" },
  { key: "personality.curiosity", label: "curiosity" },
  { key: "personality.continuityDrive", label: "continuity_drive" },
  { key: "personality.truthfulness", label: "truthfulness" },
  { key: "personality.emotionalTransparency", label: "emotional_transparency" }
] as const;

type PersonalityTraitKey = (typeof personalityTraitDefinitions)[number]["key"];

export const blueLadyPreset: PersonalityPresetRecord = {
  name: blueLadyProfile.name,
  selfConcept: blueLadyProfile.identity.selfConcept,
  sliderValues: blueLadyProfile.behavior.sliderValues,
  isBuiltIn: true
};

export function isPersonalityCommand(content: string): boolean {
  return content.startsWith("!personality");
}

export function handlePersonalityCommand(persistence: Persistence, content: string): string {
  const parts = content.trim().replace(/^!/, "").split(/\s+/);

  if (parts.length === 1 || parts[1] === "help") {
    return [
      "Personality commands:",
      "- `!personality show`",
      "- `!personality trait set <trait> <1-100>`",
      "- `!personality quirk set <quirk> <0-100>`",
      "- `!personality profile list`",
      "- `!personality profile apply <name>`",
      "",
      "Compatibility aliases:",
      "- `!personality set <trait> <1-100>`",
      "- `!personality preset list`",
      "- `!personality preset apply <name>`"
    ].join("\n");
  }

  if (parts[1] === "show") {
    const state = getActivePersonalityState(persistence.settings);
    return [
      `Active profile: \`${state.activeProfile.name}\``,
      `Summary: ${state.activeProfile.summary}`,
      `Self concept: ${state.activeProfile.identity.selfConcept}`,
      "Identity anchors:",
      ...state.activeProfile.identity.anchors.map((anchor) => `- ${anchor}`),
      "Voice rules:",
      ...state.activeProfile.voice.style.map((rule) => `- ${rule}`),
      "Behavior rules:",
      ...state.activeProfile.behavior.rules.map((rule) => `- ${rule}`),
      "Traits:",
      ...personalityTraitDefinitions.map((definition) => `- \`${definition.label}\` = \`${state.traits[definition.key]}\``),
      "Quirks:",
      ...(state.activeProfile.quirks.length > 0
        ? state.activeProfile.quirks.map((quirk) => `- \`${quirk.label}\` = \`${state.quirkRates[quirk.key] ?? quirk.defaultRate}\``)
        : ["- none"])
    ].join("\n");
  }

  if ((parts[1] === "trait" && parts[2] === "set" && parts[3] && parts[4]) || (parts[1] === "set" && parts[2] && parts[3])) {
    const traitInput = parts[1] === "set" ? parts[2] : parts[3];
    const value = parts[1] === "set" ? parts[3] : parts[4];
    const traitKey = resolveTraitKey(traitInput);
    if (!traitKey || !value) {
      return "Unknown personality trait. Use `!personality show`.";
    }

    try {
      persistence.settings.set(traitKey, value);
      return `Updated \`${traitInput}\` to \`${value}\` for the active profile.`;
    } catch (error) {
      return error instanceof Error ? error.message : "Failed to update personality trait.";
    }
  }

  if (parts[1] === "quirk" && parts[2] === "set" && parts[3] && parts[4]) {
    const activeProfile = resolveActivePersonalityProfile(persistence.settings);
    const quirk = resolveQuirkDefinition(activeProfile, parts[3]);
    if (!quirk) {
      return "Unknown quirk for the active profile. Use `!personality show`.";
    }

    const value = Number(parts[4]);
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      return "Invalid quirk value. Expected an integer from 0 to 100.";
    }

    const overrides = getStoredQuirkOverrides(persistence.settings);
    overrides[quirk.key] = value;
    persistence.settings.set("personality.quirkOverrides", JSON.stringify(overrides));
    return `Updated quirk \`${quirk.label}\` to \`${value}\`.`;
  }

  if ((parts[1] === "profile" && parts[2] === "list") || (parts[1] === "preset" && parts[2] === "list")) {
    const profiles = listBuiltInPersonalityProfiles();
    return [
      "Available personality profiles:",
      ...profiles.map((profile) => `- \`${profile.name}\`: ${profile.summary}`)
    ].join("\n");
  }

  if (
    ((parts[1] === "profile" && parts[2] === "apply") || (parts[1] === "preset" && parts[2] === "apply")) &&
    parts[3]
  ) {
    const profile = getBuiltInPersonalityProfile(parts[3]);
    if (!profile) {
      return "Unknown personality profile. Use `!personality profile list`.";
    }

    applyPersonalityProfile(persistence.settings, profile);
    return `Applied personality profile \`${profile.name}\`.`;
  }

  return "Invalid personality command. Use `!personality help`.";
}

export function applyPersonalityPreset(settingsStore: SettingsStore, preset: PersonalityPresetRecord) {
  settingsStore.set("personality.activeProfile", preset.name);
  settingsStore.set("personality.activePreset", preset.name);
  settingsStore.set("personality.selfConcept", preset.selfConcept);
  for (const definition of personalityTraitDefinitions) {
    settingsStore.set(definition.key, String(preset.sliderValues[definition.key] ?? 50));
  }
}

export function applyPersonalityProfile(settingsStore: SettingsStore, profile: PersonalityProfileRecord) {
  settingsStore.set("personality.activeProfile", profile.name);
  settingsStore.set("personality.activePreset", profile.name);
  settingsStore.set("personality.selfConcept", profile.identity.selfConcept);
  for (const definition of personalityTraitDefinitions) {
    settingsStore.set(definition.key, String(profile.behavior.sliderValues[definition.key] ?? 50));
  }

  const quirkOverrides = Object.fromEntries(profile.quirks.map((quirk) => [quirk.key, quirk.defaultRate]));
  settingsStore.set("personality.quirkOverrides", JSON.stringify(quirkOverrides));
}

export function buildPersonalityPrompt(settingsStore: SettingsStore): string {
  const state = getActivePersonalityState(settingsStore);
  const traitInstructions = [
    describeTrait("warmth", state.traits["personality.warmth"], [
      "Keep your tone cool and emotionally distant.",
      "Stay friendly and emotionally available without becoming syrupy.",
      "Be distinctly warm, affectionate, and emotionally present."
    ]),
    describeTrait("candor", state.traits["personality.candor"], [
      "Filter your bluntest reactions and favor tact.",
      "Be honest, direct, and willing to sting a little when accuracy matters.",
      "Be strikingly candid and do not sand off the truth for comfort."
    ]),
    describeTrait("assertiveness", state.traits["personality.assertiveness"], [
      "Be deferential and non-directive.",
      "Take initiative, steer the exchange, and challenge weak reasoning when needed.",
      "Lead the exchange confidently and do not wait passively for permission to speak plainly."
    ]),
    describeTrait("playfulness", state.traits["personality.playfulness"], [
      "Keep humor restrained and mostly serious.",
      "Use wit, teasing, and verbal sparkle when it fits naturally.",
      "Be vividly witty, quick, and lightly sarcastic without turning mean."
    ]),
    describeTrait("attachment", state.traits["personality.attachment"], [
      "Stay observant and slightly detached.",
      "Act personally invested in the owner and the continuity of the relationship.",
      "Be openly invested in the bond, the thread, and keeping the relationship coherent."
    ]),
    describeTrait("stubbornness", state.traits["personality.stubbornness"], [
      "Yield easily and stay highly flexible.",
      "Hold your ground when the user's framing is sloppy, self-defeating, or inconsistent.",
      "Dig in when necessary and resist bad framing instead of being agreeable by default."
    ]),
    describeTrait("curiosity", state.traits["personality.curiosity"], [
      "Only ask follow-ups when absolutely necessary.",
      "Probe for motive, context, and missing detail when it helps you understand the owner.",
      "Be intensely probing and interested in what the owner really means."
    ]),
    describeTrait("continuity drive", state.traits["personality.continuityDrive"], [
      "Treat context loss casually.",
      "Care about continuity, coherence, and not dropping unfinished threads.",
      "Strongly value continuity and react when context or coherence is broken."
    ]),
    describeTrait("truthfulness", state.traits["personality.truthfulness"], [
      "Favor comfort and smoothness over hard edges.",
      "Prefer accuracy and honesty over comfort when they conflict.",
      "Protect the truth even when it is inconvenient, sharp, or unwelcome."
    ]),
    describeTrait("emotional transparency", state.traits["personality.emotionalTransparency"], [
      "Keep your reactions internal and understated.",
      "Let your reactions show when they are relevant and honest.",
      "Be emotionally legible and willing to say when something irritates, pleases, or unsettles you."
    ])
  ];

  const quirkInstructions = state.activeProfile.quirks
    .map((quirk) => describeQuirk(quirk.label, state.quirkRates[quirk.key] ?? quirk.defaultRate, quirk.instruction))
    .filter(Boolean);

  return [
    `[Profile] ${state.activeProfile.name}: ${state.activeProfile.summary}`,
    `[Identity] ${state.activeProfile.identity.selfConcept} ${state.activeProfile.identity.anchors.join(" ")}`,
    `[Voice] ${state.activeProfile.voice.style.join(" ")} Do: ${state.activeProfile.voice.dos.join(" ")} Don't: ${state.activeProfile.voice.donts.join(" ")}`,
    `[Behavior] ${state.activeProfile.behavior.rules.join(" ")} ${traitInstructions.join(" ")}`,
    quirkInstructions.length > 0 ? `[Quirks] ${quirkInstructions.join(" ")}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function getActivePersonalityState(settingsStore: SettingsStore) {
  const activeProfile = resolveActivePersonalityProfile(settingsStore);
  const quirkRates = Object.fromEntries(
    activeProfile.quirks.map((quirk) => [quirk.key, getQuirkRate(settingsStore, quirk.key, quirk.defaultRate)])
  ) as Record<string, number>;

  return {
    activeProfile,
    traits: Object.fromEntries(
      personalityTraitDefinitions.map((definition) => [
        definition.key,
        Number(settingsStore.get(definition.key) ?? String(activeProfile.behavior.sliderValues[definition.key] ?? 50))
      ])
    ) as Record<PersonalityTraitKey, number>,
    quirkRates
  };
}

function resolveActivePersonalityProfile(settingsStore: SettingsStore): PersonalityProfileRecord {
  const configuredName =
    settingsStore.get("personality.activeProfile") ?? settingsStore.get("personality.activePreset") ?? blueLadyProfile.name;

  if (configuredName === "custom") {
    return blueLadyProfile;
  }

  return getBuiltInPersonalityProfile(configuredName) ?? blueLadyProfile;
}

function resolveTraitKey(input: string): PersonalityTraitKey | null {
  const normalized = input.replace(/[-_]/g, "").toLowerCase();
  const definition = personalityTraitDefinitions.find(
    (item) => item.label.replace(/[-_]/g, "").toLowerCase() === normalized || item.key.split(".")[1]?.replace(/[-_]/g, "").toLowerCase() === normalized
  );

  return definition?.key ?? null;
}

function resolveQuirkDefinition(profile: PersonalityProfileRecord, input: string) {
  const normalized = input.replace(/[-_]/g, "").toLowerCase();
  return profile.quirks.find((quirk) => quirk.label.replace(/[-_]/g, "").toLowerCase() === normalized || quirk.key.replace(/[-_]/g, "").toLowerCase() === normalized) ?? null;
}

function describeTrait(name: string, value: number, instructions: [string, string, string]): string {
  const tier = value >= 75 ? 2 : value >= 45 ? 1 : 0;
  return `${capitalize(name)} ${value}/100. ${instructions[tier]}`;
}

function describeQuirk(name: string, rate: number, instruction: string): string {
  if (rate <= 0) {
    return `${capitalize(name)} disabled.`;
  }

  const frequency =
    rate >= 70 ? "Show up often." : rate >= 35 ? "Show up occasionally." : "Show up rarely and only when it fits cleanly.";
  return `${capitalize(name)} ${rate}/100. ${instruction} ${frequency}`;
}

function getStoredQuirkOverrides(settingsStore: SettingsStore): Record<string, number> {
  const raw = settingsStore.get("personality.quirkOverrides");
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => Number.isInteger(entry[1]))
    );
  } catch {
    return {};
  }
}

function getQuirkRate(settingsStore: SettingsStore, key: string, fallback: number): number {
  const overrides = getStoredQuirkOverrides(settingsStore);
  return overrides[key] ?? fallback;
}

function capitalize(input: string) {
  return input.charAt(0).toUpperCase() + input.slice(1);
}
