import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";

/**
 * Create a temporary directory with a `.pi/pi-autocommit.json` file.
 */
function withConfigFile(data: Record<string, unknown>): string {
  const dir = mkdtempSync("/tmp/pi-autocommit-test-");
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "pi-autocommit.json"),
    JSON.stringify(data),
    "utf-8",
  );
  return dir;
}

void describe("loadConfig", () => {
  void it("defaults to enabled when no config file exists", () => {
    const dir = mkdtempSync("/tmp/pi-autocommit-test-");
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.enable, true);
      assert.strictEqual(config.lang, "en");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("respects enable: false", () => {
    const dir = withConfigFile({ enable: false });
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.enable, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("parses lang", () => {
    const dir = withConfigFile({ lang: "ja" });
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.lang, "ja");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
