import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadPersonalityBundleCatalog } from "../src/personalityBundles.js";
import { handlePersonalityCommand } from "../src/personality.js";
import { initializePersistence } from "../src/persistence.js";

function withBundleDirectory<T>(callback: (bundleDir: string) => T): T {
  const original = process.env.DOT_PERSONALITY_BUNDLE_DIR;
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-bundles-"));
  process.env.DOT_PERSONALITY_BUNDLE_DIR = bundleDir;

  try {
    return callback(bundleDir);
  } finally {
    if (original == null) {
      delete process.env.DOT_PERSONALITY_BUNDLE_DIR;
    } else {
      process.env.DOT_PERSONALITY_BUNDLE_DIR = original;
    }

    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

function createPersistence() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-personality-bundles-"));
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

test("loadPersonalityBundleCatalog loads valid file-backed bundles", () => {
  withBundleDirectory((bundleDir) => {
    const profileDir = path.join(bundleDir, "bundle_test");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "bundle.json"),
      JSON.stringify(
        {
          metadata: {
            name: "bundle_test",
            summary: "Loaded from disk.",
            version: 1
          },
          identity: {
            selfConcept: "A test profile loaded from the filesystem.",
            anchors: ["You are a filesystem-backed test profile."]
          },
          voice: {
            style: ["Keep it simple."],
            dos: ["Say only what matters."],
            donts: ["Do not ramble."]
          },
          behavior: {
            rules: ["Prefer concise answers."],
            sliderValues: {
              "personality.warmth": 50,
              "personality.candor": 60,
              "personality.assertiveness": 55,
              "personality.playfulness": 30,
              "personality.attachment": 40,
              "personality.stubbornness": 25,
              "personality.curiosity": 45,
              "personality.continuityDrive": 70,
              "personality.truthfulness": 90,
              "personality.emotionalTransparency": 35
            }
          },
          quirks: [],
          runtimeHooks: ["contextual_quirk_suppression"]
        },
        null,
        2
      )
    );

    const catalog = loadPersonalityBundleCatalog(bundleDir);
    assert.equal(catalog.errors.length, 0);
    assert.equal(catalog.profiles[0]?.name, "bundle_test");
    assert.equal(catalog.profiles[0]?.summary, "Loaded from disk.");
    assert.deepEqual(catalog.profiles[0]?.runtimeHooks, ["contextual_quirk_suppression"]);
  });
});

test("loadPersonalityBundleCatalog reports invalid bundles without crashing", () => {
  withBundleDirectory((bundleDir) => {
    const profileDir = path.join(bundleDir, "broken_bundle");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "bundle.json"),
      JSON.stringify(
        {
          metadata: {
            name: "broken_bundle",
            summary: "",
            version: 1
          },
          identity: {
            selfConcept: "Broken bundle.",
            anchors: []
          }
        },
        null,
        2
      )
    );

    const catalog = loadPersonalityBundleCatalog(bundleDir);
    assert.equal(catalog.profiles.length, 0);
    assert.equal(catalog.errors.length, 1);
    assert.match(catalog.errors[0]?.message ?? "", /metadata\.summary/);
    assert.match(catalog.errors[0]?.message ?? "", /Missing voice object|voice\.style/);
  });
});

test("personality commands surface bundle validation warnings to operators", () => {
  withBundleDirectory((bundleDir) => {
    const brokenDir = path.join(bundleDir, "broken_bundle");
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(
      path.join(brokenDir, "bundle.json"),
      JSON.stringify(
        {
          metadata: {
            name: "broken_bundle",
            summary: "Broken bundle.",
            version: 1
          },
          identity: {
            selfConcept: "Broken bundle.",
            anchors: ["still broken"]
          },
          voice: {
            style: ["Test voice."],
            dos: ["Do test things."],
            donts: ["Don't do invalid things."]
          },
          behavior: {
            rules: ["Be invalid."],
            sliderValues: {
              "personality.warmth": 150
            }
          },
          quirks: []
        },
        null,
        2
      )
    );

    const { persistence, cleanup } = createPersistence();

    try {
      const reply = handlePersonalityCommand(persistence, "!personality profile list");
      assert.match(reply, /Bundle validation warnings:/);
      assert.match(reply, /broken_bundle/);
      assert.match(reply, /sliderValues/);
    } finally {
      cleanup();
    }
  });
});
