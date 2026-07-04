import { describe, it } from "node:test";
import assert from "node:assert";
import { resolveCommitEveryTurnConfig } from "./config.js";

void describe("resolveCommitEveryTurnConfig", () => {
  void it("treats undefined as disabled", () => {
    assert.deepStrictEqual(resolveCommitEveryTurnConfig(undefined), {
      enabled: false,
      trigger: "agent_end",
    });
  });

  void it("treats false as disabled", () => {
    assert.deepStrictEqual(resolveCommitEveryTurnConfig(false), {
      enabled: false,
      trigger: "agent_end",
    });
  });

  void it("treats true as legacy agent_end mode", () => {
    assert.deepStrictEqual(resolveCommitEveryTurnConfig(true), {
      enabled: true,
      trigger: "agent_end",
    });
  });

  void it("resolves explicit agent_end trigger", () => {
    assert.deepStrictEqual(resolveCommitEveryTurnConfig({ trigger: "agent_end" }), {
      enabled: true,
      trigger: "agent_end",
    });
  });

  void it("resolves explicit turn_end trigger", () => {
    assert.deepStrictEqual(resolveCommitEveryTurnConfig({ trigger: "turn_end" }), {
      enabled: true,
      trigger: "turn_end",
    });
  });

  void it("treats unexpected shapes as disabled", () => {
    assert.deepStrictEqual(resolveCommitEveryTurnConfig({ trigger: "unknown" as any }), {
      enabled: false,
      trigger: "agent_end",
    });
  });
});
