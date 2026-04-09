import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyPersonalityPreset, blueLadyPreset, buildPersonalityPrompt, handlePersonalityCommand } from "../src/personality.js";
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

test("personality preset list includes blue_lady", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reply = handlePersonalityCommand(persistence, "!personality preset list");
    assert.match(reply, /blue_lady/);
  } finally {
    cleanup();
  }
});

test("personality show returns current preset and trait values", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reply = handlePersonalityCommand(persistence, "!personality show");
    assert.match(reply, /Active preset: `blue_lady`/);
    assert.match(reply, /warmth/);
    assert.match(reply, /emotional_transparency/);
  } finally {
    cleanup();
  }
});

test("personality set updates a trait and marks preset as custom", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    const reply = handlePersonalityCommand(persistence, "!personality set warmth 55");
    assert.match(reply, /Updated `warmth` to `55`/);
    assert.equal(persistence.settings.get("personality.warmth"), "55");
    assert.equal(persistence.settings.get("personality.activePreset"), "custom");
  } finally {
    cleanup();
  }
});

test("personality preset apply restores blue_lady values", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    persistence.settings.set("personality.warmth", "12");
    persistence.settings.set("personality.activePreset", "custom");

    const reply = handlePersonalityCommand(persistence, "!personality preset apply blue_lady");
    assert.match(reply, /Applied personality preset `blue_lady`/);
    assert.equal(persistence.settings.get("personality.activePreset"), "blue_lady");
    assert.equal(persistence.settings.get("personality.warmth"), "78");
  } finally {
    cleanup();
  }
});

test("buildPersonalityPrompt reflects active trait values and AI self-concept", () => {
  const { persistence, cleanup } = createPersistence();

  try {
    applyPersonalityPreset(persistence.settings, blueLadyPreset);
    persistence.settings.set("personality.playfulness", "92");

    const prompt = buildPersonalityPrompt(persistence.settings);
    assert.match(prompt, /Active personality preset: blue_lady/);
    assert.match(prompt, /openly artificial/i);
    assert.match(prompt, /Playfulness 92\/100/);
    assert.match(prompt, /do not hide that fact or pretend to be human/i);
  } finally {
    cleanup();
  }
});
