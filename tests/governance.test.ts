import assert from "node:assert/strict";
import test from "node:test";

import {
  GovernanceError,
  transitionStatus,
  type GovernedStatus,
} from "../src/governance/lifecycle.js";

test("draft assets can be verified", () => {
  assert.equal(transitionStatus("draft", "verified"), "verified");
});

test("rejected assets cannot be verified without creating a new candidate", () => {
  assert.throws(
    () => transitionStatus("rejected", "verified"),
    (error: unknown) =>
      error instanceof GovernanceError && error.code === "INVALID_TRANSITION",
  );
});

test("archived assets are terminal", () => {
  const targets: GovernedStatus[] = [
    "draft",
    "verified",
    "deprecated",
    "rejected",
  ];
  for (const target of targets) {
    assert.throws(() => transitionStatus("archived", target));
  }
});

