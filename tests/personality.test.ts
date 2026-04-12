import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyPersonalityProfile, blueLadyPreset, buildPersonalityPrompt, handlePersonalityCommand } from "../src/personality.js";
import { initializePersistence } from "../src/persistence.js";
import { getBuiltInPersonalityProfile } from "../src/personalityProfiles.js";

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-personality-"));
  const sqlitePath = path.join(dataDir, "dot.sqlite");
  const persistence = initializePersistence(dataDir, sqlitePath);

  return {
    persistence,
    cleanup() {
      persistence.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

test("personality profile list includes built-in profiles", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reply = handlePersonalityCommand(persistence, "!personality profile list");
    assert.match(reply, /blue_lady/);
    assert.match(reply, /steady_hand/);
    assert.match(reply, /auntie_dot/);
  } finally {
    cleanup();
  }
});

test("personality show returns current profile and quirk values", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reply = handlePersonalityCommand(persistence, "!personality show");
    assert.match(reply, /Active profile: `blue_lady`/);
    assert.match(reply, /warmth/);
    assert.match(reply, /emotional_transparency/);
    assert.match(reply, /dry_aside/);
  } finally {
    cleanup();
  }
});

test("personality trait set updates a trait without discarding the active profile", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    handlePersonalityCommand(persistence, "!personality profile apply steady_hand");
    const reply = handlePersonalityCommand(persistence, "!personality trait set warmth 55");
    assert.match(reply, /Updated `warmth` to `55`/);
    assert.equal(persistence.settings.get("personality.warmth"), "55");
    assert.equal(persistence.settings.get("personality.activeProfile"), "steady_hand");
  } finally {
    cleanup();
  }
});

test("personality quirk set persists a configurable rate", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reply = handlePersonalityCommand(persistence, "!personality quirk set dry_aside 48");
    assert.match(reply, /Updated quirk `dry_aside` to `48`/);
    assert.equal(persistence.settings.get("personality.quirkOverrides"), "{\"dry_aside\":48}");
  } finally {
    cleanup();
  }
});

test("personality profile apply switches active profile and resets defaults", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.settings.set("personality.warmth", "12");

    const reply = handlePersonalityCommand(persistence, "!personality profile apply steady_hand");
    assert.match(reply, /Applied personality profile `steady_hand`/);
    assert.equal(persistence.settings.get("personality.activeProfile"), "steady_hand");
    assert.equal(persistence.settings.get("personality.warmth"), "62");
  } finally {
    cleanup();
  }
});

test("auntie_dot profile encodes the agreed familial southern persona and quirk", () => {
  const profile = getBuiltInPersonalityProfile("auntie_dot");

  assert.ok(profile);
  assert.match(profile.summary, /Southern auntie/i);
  assert.match(profile.identity.selfConcept, /Tan Nguyen/i);
  assert.match(profile.identity.selfConcept, /familial rather than romantic/i);
  assert.ok(profile.voice.dos.some((entry) => /comfort first/i.test(entry)));
  assert.ok(profile.voice.dos.some((entry) => /final decision rests with them/i.test(entry)));
  assert.ok(profile.voice.donts.some((entry) => /baby/i.test(entry)));
  assert.equal(profile.quirks[0]?.key, "accidental_double_entendre");
  assert.equal(profile.quirks[0]?.defaultRate, 8);
});

test("auntie_dot prompt includes approved phrases, anti-patterns, and representative dialogues", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reply = handlePersonalityCommand(persistence, "!personality profile apply auntie_dot");
    assert.match(reply, /Applied personality profile `auntie_dot`/);

    const prompt = buildPersonalityPrompt(persistence.settings);
    assert.match(prompt, /\[Profile\] auntie_dot/);
    assert.match(prompt, /gentle older Southern woman/i);
    assert.match(prompt, /dogyear/i);
    assert.match(prompt, /costlytoaster/i);
    assert.match(prompt, /\[Approved Phrases\]/);
    assert.match(prompt, /Well hey there, deary\./);
    assert.match(prompt, /\[Avoided Phrases\]/);
    assert.match(prompt, /How can I assist you today\?/);
    assert.match(prompt, /\[Dialogue Examples\]/);
    assert.match(prompt, /casual greeting/i);
    assert.match(prompt, /accidental_double_entendre 8\/100/i);
  } finally {
    cleanup();
  }
});

test("existing non-auntie profiles do not pick up auntie-specific example scaffolding", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    handlePersonalityCommand(persistence, "!personality profile apply blue_lady");
    const prompt = buildPersonalityPrompt(persistence.settings);

    assert.doesNotMatch(prompt, /\[Approved Phrases\]/);
    assert.doesNotMatch(prompt, /\[Avoided Phrases\]/);
    assert.doesNotMatch(prompt, /\[Dialogue Examples\]/);
  } finally {
    cleanup();
  }
});

test("buildPersonalityPrompt reflects structured profile sections, traits, and quirks", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    applyPersonalityProfile(persistence.settings, {
      name: blueLadyPreset.name,
      summary: "Emotionally legible, quick-witted, openly artificial, and continuity-minded.",
      identity: {
        selfConcept: blueLadyPreset.selfConcept,
        anchors: ["You are Dot, an AI companion for a single owner."]
      },
      voice: {
        style: ["Stay natural and quick-witted."],
        dos: ["Use direct language."],
        donts: ["Do not pretend to be human."]
      },
      behavior: {
        rules: ["Prefer continuity and honesty."],
        sliderValues: blueLadyPreset.sliderValues
      },
      quirks: [
        {
          key: "dry_aside",
          label: "dry_aside",
          description: "Occasional dry asides.",
          defaultRate: 12,
          instruction: "Occasionally allow a dry aside."
        }
      ],
      isBuiltIn: true
    });
    persistence.settings.set("personality.playfulness", "92");

    const prompt = buildPersonalityPrompt(persistence.settings);
    assert.match(prompt, /\[Profile\] blue_lady/);
    assert.match(prompt, /\[Identity\]/);
    assert.match(prompt, /\[Voice\]/);
    assert.match(prompt, /\[Behavior\]/);
    assert.match(prompt, /\[Quirks\]/);
    assert.match(prompt, /openly artificial/i);
    assert.match(prompt, /Playfulness 92\/100/);
    assert.match(prompt, /dry_aside 12\/100/i);
  } finally {
    cleanup();
  }
});
