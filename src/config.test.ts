import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveCommitEveryTurnConfig, loadConfig } from "./config.js";

/**
 * Create a temporary directory with a `.pi/pi-git.json` file.
 */
function withConfigFile(data: Record<string, unknown>): string {
  const dir = mkdtempSync("/tmp/pi-git-test-");
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "pi-git.json"), JSON.stringify(data), "utf-8");
  return dir;
}

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

void describe("loadConfig", () => {
  void it("parses model from config", () => {
    const dir = withConfigFile({ model: "anthropic/claude-sonnet-4" });
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.model, "anthropic/claude-sonnet-4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("omits model when not set", () => {
    const dir = withConfigFile({ lang: "ja" });
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.model, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("ignores empty model string", () => {
    const dir = withConfigFile({ model: "  " });
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.model, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("warns on unknown key but still loads model", () => {
    const dir = withConfigFile({ model: "openai/gpt-4o", unknown_key: true });
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.model, "openai/gpt-4o");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
