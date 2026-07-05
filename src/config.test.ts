import { describe, it } from "node:test";
import assert from "node:assert";
import { resolveCommitEveryTurnConfig } from "./config.js";

void describe("resolveCommitEveryTurnConfig", () => {
  void it("treats undefined as disabled", () => {
    assert.deepStrictEqual(resolveCommitEveryTurnConfig(undefined), {
      enabled: false,
    });
  });

  void it("treats false as disabled", () => {
    assert.deepStrictEqual(resolveCommitEveryTurnConfig(false), {
      enabled: false,
    });
  });

  void it("treats true as enabled", () => {
    assert.deepStrictEqual(resolveCommitEveryTurnConfig(true), {
      enabled: true,
    });
  });
});
