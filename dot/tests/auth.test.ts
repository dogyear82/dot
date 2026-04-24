import test from "node:test";
import assert from "node:assert/strict";

import { evaluateAccess, resolveActorRole } from "../src/auth.js";

test("resolveActorRole classifies the configured owner deterministically", () => {
  assert.equal(resolveActorRole("owner-1", "owner-1"), "owner");
  assert.equal(resolveActorRole("user-2", "owner-1"), "non-owner");
});

test("evaluateAccess allows owner messages through privileged workflows", () => {
  const decision = evaluateAccess({
    authorId: "owner-1",
    ownerUserId: "owner-1",
    isDirectMessage: true,
    mentionedBot: false
  });

  assert.deepEqual(decision, {
    actorRole: "owner",
    canUsePrivilegedFeatures: true
  });
});

test("evaluateAccess keeps non-owner users out of privileged workflows", () => {
  const decision = evaluateAccess({
    authorId: "user-2",
    ownerUserId: "owner-1",
    isDirectMessage: false,
    mentionedBot: true
  });

  assert.deepEqual(decision, {
    actorRole: "non-owner",
    canUsePrivilegedFeatures: false
  });
});
