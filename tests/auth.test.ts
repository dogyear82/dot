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
    canUsePrivilegedFeatures: true,
    shouldReply: false
  });
});

test("evaluateAccess routes non-owner mentions into a limited contact flow", () => {
  const decision = evaluateAccess({
    authorId: "user-2",
    ownerUserId: "owner-1",
    isDirectMessage: false,
    mentionedBot: true
  });

  assert.equal(decision.actorRole, "non-owner");
  assert.equal(decision.canUsePrivilegedFeatures, false);
  assert.equal(decision.shouldReply, true);
  assert.match(
    decision.responseMessage ?? "",
    /only help non-owner users get in touch with the owner/i
  );
});
