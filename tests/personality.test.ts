import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyPersonalityProfile, blueLadyPreset, buildPersonalityPrompt, handlePersonalityCommand } from "../src/personality.js";
import { initializePersistence } from "../src/persistence.js";

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
