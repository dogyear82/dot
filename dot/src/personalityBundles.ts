import fs from "node:fs";
import path from "node:path";

import type { PersonalityBundleFileRecord, PersonalityProfileRecord, PersonalityRuntimeHookKey } from "./types.js";

export interface PersonalityBundleLoadError {
  bundlePath: string;
  message: string;
}

export interface PersonalityBundleCatalog {
  profiles: PersonalityProfileRecord[];
  errors: PersonalityBundleLoadError[];
}

const personalityRuntimeHooks = new Set<PersonalityRuntimeHookKey>(["contextual_quirk_suppression"]);
const reportedBundleErrors = new Set<string>();

export function resolvePersonalityBundleDirectory(): string {
  return process.env.DOT_PERSONALITY_BUNDLE_DIR
    ? path.resolve(process.env.DOT_PERSONALITY_BUNDLE_DIR)
    : path.resolve(process.cwd(), "personalities");
}

export function loadPersonalityBundleCatalog(bundleDirectory = resolvePersonalityBundleDirectory()): PersonalityBundleCatalog {
  if (!fs.existsSync(bundleDirectory)) {
    return { profiles: [], errors: [] };
  }

  const entries = fs.readdirSync(bundleDirectory, { withFileTypes: true });
  const profiles: PersonalityProfileRecord[] = [];
  const errors: PersonalityBundleLoadError[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const bundlePath = path.join(bundleDirectory, entry.name, "bundle.json");
    if (!fs.existsSync(bundlePath)) {
      continue;
    }

    const bundle = loadBundleFile(bundlePath);
    if ("error" in bundle) {
      errors.push(bundle.error);
      continue;
    }

    profiles.push(bundle.profile);
  }

  reportBundleErrors(errors);
  return { profiles, errors };
}

function loadBundleFile(bundlePath: string):
  | { profile: PersonalityProfileRecord }
  | { error: PersonalityBundleLoadError } {
  let parsed: unknown;

  try {
    parsed = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  } catch (error) {
    return {
      error: {
        bundlePath,
        message: `Failed to parse bundle JSON: ${error instanceof Error ? error.message : String(error)}`
      }
    };
  }

  const validationErrors = validateBundleFile(parsed);
  if (validationErrors.length > 0) {
    return {
      error: {
        bundlePath,
        message: validationErrors.join("; ")
      }
    };
  }

  const record = parsed as PersonalityBundleFileRecord;
  return {
    profile: {
      name: record.metadata.name,
      summary: record.metadata.summary,
      identity: record.identity,
      voice: record.voice,
      behavior: record.behavior,
      quirks: record.quirks,
      runtimeHooks: record.runtimeHooks ?? [],
      examples: record.examples,
      isBuiltIn: true
    }
  };
}

function validateBundleFile(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["Bundle must be a JSON object."];
  }

  const metadata = value.metadata;
  if (!isRecord(metadata)) {
    errors.push("Missing metadata object.");
  } else {
    requireString(metadata, "name", errors, "metadata");
    requireString(metadata, "summary", errors, "metadata");
    if (typeof metadata.version !== "number" || !Number.isInteger(metadata.version) || metadata.version < 1) {
      errors.push("metadata.version must be an integer >= 1.");
    }
  }

  validateIdentity(value.identity, errors);
  validateVoice(value.voice, errors);
  validateBehavior(value.behavior, errors);
  validateQuirks(value.quirks, errors);

  if (value.runtimeHooks != null) {
    if (!Array.isArray(value.runtimeHooks) || value.runtimeHooks.some((hook) => typeof hook !== "string")) {
      errors.push("runtimeHooks must be an array of strings.");
    } else {
      for (const hook of value.runtimeHooks) {
        if (!personalityRuntimeHooks.has(hook as PersonalityRuntimeHookKey)) {
          errors.push(`Unknown runtime hook \`${hook}\`.`);
        }
      }
    }
  }

  if (value.examples != null) {
    validateExamples(value.examples, errors);
  }

  return errors;
}

function validateIdentity(value: unknown, errors: string[]) {
  if (!isRecord(value)) {
    errors.push("Missing identity object.");
    return;
  }

  requireString(value, "selfConcept", errors, "identity");
  requireStringArray(value.anchors, "identity.anchors", errors);
}

function validateVoice(value: unknown, errors: string[]) {
  if (!isRecord(value)) {
    errors.push("Missing voice object.");
    return;
  }

  requireStringArray(value.style, "voice.style", errors);
  requireStringArray(value.dos, "voice.dos", errors);
  requireStringArray(value.donts, "voice.donts", errors);
}

function validateBehavior(value: unknown, errors: string[]) {
  if (!isRecord(value)) {
    errors.push("Missing behavior object.");
    return;
  }

  requireStringArray(value.rules, "behavior.rules", errors);

  if (!isRecord(value.sliderValues)) {
    errors.push("behavior.sliderValues must be an object.");
    return;
  }

  for (const [key, sliderValue] of Object.entries(value.sliderValues)) {
    if (typeof sliderValue !== "number" || !Number.isFinite(sliderValue) || sliderValue < 1 || sliderValue > 100) {
      errors.push(`behavior.sliderValues.${key} must be a number from 1 to 100.`);
    }
  }
}

function validateQuirks(value: unknown, errors: string[]) {
  if (!Array.isArray(value)) {
    errors.push("quirks must be an array.");
    return;
  }

  for (const [index, quirk] of value.entries()) {
    if (!isRecord(quirk)) {
      errors.push(`quirks[${index}] must be an object.`);
      continue;
    }

    requireString(quirk, "key", errors, `quirks[${index}]`);
    requireString(quirk, "label", errors, `quirks[${index}]`);
    requireString(quirk, "description", errors, `quirks[${index}]`);
    requireString(quirk, "instruction", errors, `quirks[${index}]`);
    if (
      typeof quirk.defaultRate !== "number" ||
      !Number.isInteger(quirk.defaultRate) ||
      quirk.defaultRate < 0 ||
      quirk.defaultRate > 100
    ) {
      errors.push(`quirks[${index}].defaultRate must be an integer from 0 to 100.`);
    }
  }
}

function validateExamples(value: unknown, errors: string[]) {
  if (!isRecord(value)) {
    errors.push("examples must be an object.");
    return;
  }

  requireStringArray(value.approvedPhrases, "examples.approvedPhrases", errors);
  requireStringArray(value.avoidedPhrases, "examples.avoidedPhrases", errors);

  if (!Array.isArray(value.dialogues)) {
    errors.push("examples.dialogues must be an array.");
    return;
  }

  for (const [index, dialogue] of value.dialogues.entries()) {
    if (!isRecord(dialogue)) {
      errors.push(`examples.dialogues[${index}] must be an object.`);
      continue;
    }

    requireString(dialogue, "situation", errors, `examples.dialogues[${index}]`);
    requireString(dialogue, "user", errors, `examples.dialogues[${index}]`);
    requireString(dialogue, "dot", errors, `examples.dialogues[${index}]`);
  }
}

function requireString(record: Record<string, unknown>, key: string, errors: string[], prefix: string) {
  if (typeof record[key] !== "string" || record[key].trim() === "") {
    errors.push(`${prefix}.${key} must be a non-empty string.`);
  }
}

function requireStringArray(value: unknown, pathLabel: string, errors: string[]) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    errors.push(`${pathLabel} must be an array of non-empty strings.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportBundleErrors(errors: PersonalityBundleLoadError[]) {
  for (const error of errors) {
    const fingerprint = `${error.bundlePath}:${error.message}`;
    if (reportedBundleErrors.has(fingerprint)) {
      continue;
    }

    reportedBundleErrors.add(fingerprint);
    console.warn(`[personality-bundles] ${error.bundlePath}: ${error.message}`);
  }
}
