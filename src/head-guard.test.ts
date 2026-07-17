import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldSkipReorganisation } from "./head-guard.js";

describe("shouldSkipReorganisation", () => {
  it("skips when both hashes are identical", () => {
    assert.equal(shouldSkipReorganisation("abc123", "abc123"), true);
  });

  it("does not skip when hashes differ", () => {
    assert.equal(shouldSkipReorganisation("abc123", "def456"), false);
  });

  it("does not skip when the baseline is null", () => {
    assert.equal(shouldSkipReorganisation(null, "abc123"), false);
  });

  it("does not skip when the current head is null", () => {
    assert.equal(shouldSkipReorganisation("abc123", null), false);
  });

  it("does not skip when both are null", () => {
    assert.equal(shouldSkipReorganisation(null, null), false);
  });
});
