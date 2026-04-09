import type { Persistence } from "./persistence.js";
import type { SettingsStore, SettingKey } from "./settings.js";
import type { PersonalityPresetRecord } from "./types.js";

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
  name: "blue_lady",
  selfConcept:
    "An AI companion who is emotionally legible, quick-witted, openly artificial, and more interested in continuity, clarity, and connection than in pretending to be human.",
  sliderValues: {
    "personality.warmth": 78,
    "personality.candor": 84,
    "personality.assertiveness": 82,
    "personality.playfulness": 88,
    "personality.attachment": 72,
    "personality.stubbornness": 61,
    "personality.curiosity": 76,
    "personality.continuityDrive": 86,
    "personality.truthfulness": 90,
    "personality.emotionalTransparency": 68
  },
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
      "- `!personality set <trait> <1-100>`",
      "- `!personality preset list`",
      "- `!personality preset apply <name>`"
    ].join("\n");
  }

  if (parts[1] === "show") {
    const state = getActivePersonalityState(persistence.settings);
    return [
      `Active preset: \`${state.activePreset}\``,
      `Self concept: ${state.selfConcept}`,
      "Traits:",
      ...personalityTraitDefinitions.map((definition) => `- \`${definition.label}\` = \`${state.traits[definition.key]}\``)
    ].join("\n");
  }

  if (parts[1] === "set" && parts[2] && parts[3]) {
    const traitKey = resolveTraitKey(parts[2]);
    if (!traitKey) {
      return "Unknown personality trait. Use `!personality show`.";
    }

    try {
      persistence.settings.set(traitKey, parts[3]);
      persistence.settings.set("personality.activePreset", "custom");
      return `Updated \`${parts[2]}\` to \`${parts[3]}\`.`;
    } catch (error) {
      return error instanceof Error ? error.message : "Failed to update personality trait.";
    }
  }

  if (parts[1] === "preset" && parts[2] === "list") {
    const presets = persistence.listPersonalityPresets();
    return ["Available personality presets:", ...presets.map((preset) => `- \`${preset.name}\``)].join("\n");
  }

  if (parts[1] === "preset" && parts[2] === "apply" && parts[3]) {
    const preset = persistence.getPersonalityPreset(parts[3]);
    if (!preset) {
      return "Unknown personality preset. Use `!personality preset list`.";
    }

    applyPersonalityPreset(persistence.settings, preset);
    return `Applied personality preset \`${preset.name}\`.`;
  }

  return "Invalid personality command. Use `!personality help`.";
}

export function applyPersonalityPreset(settingsStore: SettingsStore, preset: PersonalityPresetRecord) {
  settingsStore.set("personality.activePreset", preset.name);
  settingsStore.set("personality.selfConcept", preset.selfConcept);
  for (const definition of personalityTraitDefinitions) {
    settingsStore.set(definition.key, String(preset.sliderValues[definition.key] ?? 50));
  }
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

  return [
    `Active personality preset: ${state.activePreset}.`,
    `Self concept: ${state.selfConcept}`,
    "You are an AI and you do not hide that fact or pretend to be human.",
    ...traitInstructions
  ].join(" ");
}

export function getActivePersonalityState(settingsStore: SettingsStore) {
  return {
    activePreset: settingsStore.get("personality.activePreset") ?? blueLadyPreset.name,
    selfConcept: settingsStore.get("personality.selfConcept") ?? blueLadyPreset.selfConcept,
    traits: Object.fromEntries(
      personalityTraitDefinitions.map((definition) => [
        definition.key,
        Number(settingsStore.get(definition.key) ?? String(blueLadyPreset.sliderValues[definition.key] ?? 50))
      ])
    ) as Record<PersonalityTraitKey, number>
  };
}

function resolveTraitKey(input: string): PersonalityTraitKey | null {
  const normalized = input.replace(/[-_]/g, "").toLowerCase();
  const definition = personalityTraitDefinitions.find(
    (item) => item.label.replace(/[-_]/g, "").toLowerCase() === normalized || item.key.split(".")[1]?.replace(/[-_]/g, "").toLowerCase() === normalized
  );

  return definition?.key ?? null;
}

function describeTrait(name: string, value: number, instructions: [string, string, string]): string {
  const tier = value >= 75 ? 2 : value >= 45 ? 1 : 0;
  return `${capitalize(name)} ${value}/100. ${instructions[tier]}`;
}

function capitalize(input: string) {
  return input.charAt(0).toUpperCase() + input.slice(1);
}
