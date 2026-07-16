import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig, saveEnable, saveModel } from "./config.js";

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

void describe("loadConfig scope", () => {
  void it("parses a path-to-scope mapping", () => {
    const dir = withConfigFile({
      scope: { "packages/frontend/**": "frontend", "**": "app" },
    });
    try {
      const config = loadConfig(dir);
      assert.deepStrictEqual(config.scope, {
        "packages/frontend/**": "frontend",
        "**": "app",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("omits scope when empty", () => {
    const dir = withConfigFile({ scope: {} });
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.scope, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("omits scope when not an object", () => {
    const dir = withConfigFile({ scope: ["a", "b"] });
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.scope, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("drops entries with non-string values", () => {
    const dir = withConfigFile({
      scope: { "**": "app", bad: 123, also: null },
    });
    try {
      const config = loadConfig(dir);
      assert.deepStrictEqual(config.scope, { "**": "app" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("omits scope when all values are invalid", () => {
    const dir = withConfigFile({ scope: { a: "", b: 0 } });
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.scope, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("warns on unknown key but still loads scope", () => {
    const dir = withConfigFile({
      scope: { "**": "app" },
      unknown_key: true,
    });
    try {
      const config = loadConfig(dir);
      assert.deepStrictEqual(config.scope, { "**": "app" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

void describe("saveEnable", () => {
  void it("creates a default file when none exists", () => {
    const dir = mkdtempSync("/tmp/pi-autocommit-test-");
    try {
      saveEnable(dir, false);
      const raw = readFileSync(join(dir, ".pi", "pi-autocommit.json"), "utf-8");
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.enable, false);
      assert.strictEqual(parsed.lang, "en");
      assert.strictEqual(parsed.model, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("overwrites only enable and preserves other known keys", () => {
    const dir = withConfigFile({ lang: "ja", enable: true, model: "anthropic/claude-sonnet-4" });
    try {
      saveEnable(dir, false);
      const config = loadConfig(dir);
      assert.strictEqual(config.enable, false);
      assert.strictEqual(config.lang, "ja");
      assert.strictEqual(config.model, "anthropic/claude-sonnet-4");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("preserves unknown keys", () => {
    const dir = withConfigFile({ enable: true, custom_key: "keep-me" });
    try {
      saveEnable(dir, false);
      const raw = readFileSync(join(dir, ".pi", "pi-autocommit.json"), "utf-8");
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.enable, false);
      assert.strictEqual(parsed.custom_key, "keep-me");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("can re-enable after disabling", () => {
    const dir = withConfigFile({ enable: true, lang: "ja" });
    try {
      saveEnable(dir, false);
      assert.strictEqual(loadConfig(dir).enable, false);
      saveEnable(dir, true);
      assert.strictEqual(loadConfig(dir).enable, true);
      assert.strictEqual(loadConfig(dir).lang, "ja");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

void describe("saveModel", () => {
  void it("creates a default file when none exists", () => {
    const dir = mkdtempSync("/tmp/pi-autocommit-test-");
    try {
      saveModel(dir, "anthropic/claude-sonnet-4");
      const raw = readFileSync(join(dir, ".pi", "pi-autocommit.json"), "utf-8");
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.model, "anthropic/claude-sonnet-4");
      assert.strictEqual(parsed.lang, "en");
      assert.strictEqual(parsed.enable, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("overwrites only model and preserves other known keys", () => {
    const dir = withConfigFile({ lang: "ja", enable: false, model: "openai/gpt-4o" });
    try {
      saveModel(dir, "anthropic/claude-sonnet-4");
      const config = loadConfig(dir);
      assert.strictEqual(config.model, "anthropic/claude-sonnet-4");
      assert.strictEqual(config.lang, "ja");
      assert.strictEqual(config.enable, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("preserves unknown keys", () => {
    const dir = withConfigFile({ enable: true, model: "openai/gpt-4o", custom_key: "keep-me" });
    try {
      saveModel(dir, "anthropic/claude-sonnet-4");
      const raw = readFileSync(join(dir, ".pi", "pi-autocommit.json"), "utf-8");
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.model, "anthropic/claude-sonnet-4");
      assert.strictEqual(parsed.custom_key, "keep-me");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("loads commitPickerMaxCommits from config", () => {
    const dir = withConfigFile({ commitPickerMaxCommits: 50 });
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.commitPickerMaxCommits, 50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("defaults commitPickerMaxCommits to 30 when not set", () => {
    const dir = mkdtempSync("/tmp/pi-autocommit-test-");
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.commitPickerMaxCommits, 30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("ignores non-positive commitPickerMaxCommits and falls back to default", () => {
    const dir = withConfigFile({ commitPickerMaxCommits: -1 });
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.commitPickerMaxCommits, 30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("ignores non-integer commitPickerMaxCommits and falls back to default", () => {
    const dir = withConfigFile({ commitPickerMaxCommits: 3.5 });
    try {
      const config = loadConfig(dir);
      assert.strictEqual(config.commitPickerMaxCommits, 30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("deletes the model key when passed undefined", () => {
    const dir = withConfigFile({ lang: "ja", enable: true, model: "anthropic/claude-sonnet-4" });
    try {
      saveModel(dir, undefined);
      const raw = readFileSync(join(dir, ".pi", "pi-autocommit.json"), "utf-8");
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.model, undefined);
      assert.strictEqual(parsed.lang, "ja");
      assert.strictEqual(parsed.enable, true);
      assert.strictEqual(loadConfig(dir).model, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("can set then clear then set again", () => {
    const dir = mkdtempSync("/tmp/pi-autocommit-test-");
    try {
      saveModel(dir, "anthropic/claude-sonnet-4");
      assert.strictEqual(loadConfig(dir).model, "anthropic/claude-sonnet-4");
      saveModel(dir, undefined);
      assert.strictEqual(loadConfig(dir).model, undefined);
      saveModel(dir, "openai/gpt-4o");
      assert.strictEqual(loadConfig(dir).model, "openai/gpt-4o");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
