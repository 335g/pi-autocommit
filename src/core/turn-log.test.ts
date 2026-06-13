/**
 * Tests for TurnLog persistence.
 *
 * Run: node --import tsx --test src/core/turn-log.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";

// We need to test the TurnLog class directly.
// The module exports a singleton, so we import the class to create test instances.
import { TurnLog, turnLog } from "./turn-log.js";
import type { AgentEndEvent } from "../types.js";

// ── Test helpers ──

function makeEvent(
  userMessage?: string,
  assistantMessage?: string,
): AgentEndEvent {
  const messages: Array<{ role: string; content: unknown }> = [];
  if (userMessage !== undefined) {
    messages.push({ role: "user", content: userMessage });
  }
  if (assistantMessage !== undefined) {
    messages.push({ role: "assistant", content: assistantMessage });
  }
  return { messages };
}

function makeTempGitRepo(): { root: string; cleanup: () => void } {
  const dir = join(tmpdir(), `pi-git-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  // Create initial commit so stash works
  writeFileSync(join(dir, "README.md"), "# test\n");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
  return {
    root: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ── Tests ──

describe("TurnLog persistence", () => {
  describe("initialize() — fresh start", () => {
    it("starts empty when not in a git repo", () => {
      const log = new TurnLog();
      log.initialize(tmpdir()); // tmpdir is not a git repo
      assert.equal(log.turnCount, 0);
    });

    it("starts empty when turn-log.json does not exist", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const log = new TurnLog();
        log.initialize(root);
        assert.equal(log.turnCount, 0);
      } finally {
        cleanup();
      }
    });
  });

  describe("initialize() — load from disk", () => {
    it("restores entries after a simulated reload", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        // Session 1: append some entries
        const log1 = new TurnLog();
        log1.initialize(root);
        log1.append(makeEvent("add login form"), ["src/login.ts"]);
        log1.append(makeEvent("add validation"), ["src/validation.ts"]);
        assert.equal(log1.turnCount, 2);
        assert.equal(log1.warnNotified, false);
        log1.warnNotified = true;

        // Simulate reload: create a new TurnLog instance
        const log2 = new TurnLog();
        log2.initialize(root);
        assert.equal(log2.turnCount, 2);
        assert.equal(log2.warnNotified, true);

        // Verify entry content
        const prompt = log2.formatForPrompt();
        assert.ok(prompt.includes("add login form"));
        assert.ok(prompt.includes("add validation"));
        assert.ok(prompt.includes("src/login.ts"));
        assert.ok(prompt.includes("src/validation.ts"));
      } finally {
        cleanup();
      }
    });

    it("maintains turnIndex continuity across reloads", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const log1 = new TurnLog();
        log1.initialize(root);
        log1.append(makeEvent("turn 1"), ["a.ts"]);
        log1.append(makeEvent("turn 2"), ["b.ts"]);

        // Reload
        const log2 = new TurnLog();
        log2.initialize(root);
        log2.append(makeEvent("turn 3"), ["c.ts"]);

        const prompt = log2.formatForPrompt();
        assert.ok(prompt.includes("Turn 1"), "should contain Turn 1");
        assert.ok(prompt.includes("Turn 2"), "should contain Turn 2");
        assert.ok(prompt.includes("Turn 3"), "should contain Turn 3");
      } finally {
        cleanup();
      }
    });
  });

  describe("clear() — disk cleanup", () => {
    it("deletes turn-log.json after clear", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const log = new TurnLog();
        log.initialize(root);
        log.append(makeEvent("test"), ["a.ts"]);
        assert.equal(log.turnCount, 1);

        const filePath = join(root, ".pi-git", "turn-log.json");
        assert.ok(existsSync(filePath), "file should exist after append");

        log.clear();
        assert.equal(log.turnCount, 0);
        assert.ok(!existsSync(filePath), "file should be deleted after clear");
      } finally {
        cleanup();
      }
    });
  });

  describe("clear() — not in repo", () => {
    it("does not throw when not initialized in a repo", () => {
      const log = new TurnLog();
      log.clear(); // should not throw
    });
  });

  describe("corrupted file", () => {
    it("handles invalid JSON gracefully", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const dir = join(root, ".pi-git");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "turn-log.json"), "not valid json {{{");

        const log = new TurnLog();
        log.initialize(root);
        assert.equal(log.turnCount, 0);
      } finally {
        cleanup();
      }
    });

    it("handles wrong types gracefully (entries is null)", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const dir = join(root, ".pi-git");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "turn-log.json"),
          JSON.stringify({ version: 1, turnIndex: 1, warnNotified: false, entries: null }),
        );

        const log = new TurnLog();
        log.initialize(root);
        assert.equal(log.turnCount, 0);
      } finally {
        cleanup();
      }
    });

    it("handles wrong types gracefully (turnIndex is string)", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const dir = join(root, ".pi-git");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "turn-log.json"),
          JSON.stringify({ version: 1, turnIndex: "abc", warnNotified: false, entries: [] }),
        );

        const log = new TurnLog();
        log.initialize(root);
        assert.equal(log.turnCount, 0);
      } finally {
        cleanup();
      }
    });

    it("handles unsupported version gracefully", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const dir = join(root, ".pi-git");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "turn-log.json"),
          JSON.stringify({ version: 999, turnIndex: 0, warnNotified: false, entries: [] }),
        );

        const log = new TurnLog();
        log.initialize(root);
        assert.equal(log.turnCount, 0);
      } finally {
        cleanup();
      }
    });

    it("skips malformed entries but keeps valid ones", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const dir = join(root, ".pi-git");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "turn-log.json"),
          JSON.stringify({
            version: 1,
            turnIndex: 3,
            warnNotified: false,
            entries: [
              null, // malformed
              { index: 1, userMessage: "good entry", assistantExcerpt: "ok", filesChanged: ["a.ts"] },
              { index: 2 }, // missing fields
              { index: 3, userMessage: "another good", assistantExcerpt: "ok", filesChanged: [] },
            ],
          }),
        );

        const log = new TurnLog();
        log.initialize(root);
        assert.equal(log.turnCount, 2, "should only keep 2 valid entries");
      } finally {
        cleanup();
      }
    });

    it("handles empty file", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const dir = join(root, ".pi-git");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "turn-log.json"), "");

        const log = new TurnLog();
        log.initialize(root);
        assert.equal(log.turnCount, 0);
      } finally {
        cleanup();
      }
    });

    it("handles non-object JSON (array)", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const dir = join(root, ".pi-git");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "turn-log.json"), "[]");

        const log = new TurnLog();
        log.initialize(root);
        assert.equal(log.turnCount, 0);
      } finally {
        cleanup();
      }
    });
  });

  describe("MAX_ENTRIES enforcement", () => {
    it("truncates to MAX_ENTRIES on load", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const dir = join(root, ".pi-git");
        mkdirSync(dir, { recursive: true });

        // Write 25 entries to disk
        const entries = Array.from({ length: 25 }, (_, i) => ({
          index: i + 1,
          userMessage: `message ${i + 1}`,
          assistantExcerpt: "ok",
          filesChanged: ["file.ts"],
        }));
        writeFileSync(
          join(dir, "turn-log.json"),
          JSON.stringify({ version: 1, turnIndex: 26, warnNotified: false, entries }),
        );

        const log = new TurnLog();
        log.initialize(root);
        assert.ok(log.turnCount <= TurnLog.MAX_ENTRIES,
          `should have at most ${TurnLog.MAX_ENTRIES} entries, got ${log.turnCount}`);
      } finally {
        cleanup();
      }
    });
  });

  describe("formatForPrompt() after load", () => {
    it("produces valid prompt text after reload", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const log1 = new TurnLog();
        log1.initialize(root);
        log1.append(makeEvent("add feature X"), ["src/x.ts", "src/y.ts"]);

        const log2 = new TurnLog();
        log2.initialize(root);
        const prompt = log2.formatForPrompt();
        assert.ok(prompt.includes("Turn 1"));
        assert.ok(prompt.includes("add feature X"));
        assert.ok(prompt.includes("src/x.ts"));
        assert.ok(prompt.includes("src/y.ts"));
      } finally {
        cleanup();
      }
    });

    it("returns empty string when no entries", () => {
      const log = new TurnLog();
      log.initialize(tmpdir());
      assert.equal(log.formatForPrompt(), "");
    });
  });

  describe("special characters", () => {
    it("handles newlines, unicode, and quotes in messages", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const log1 = new TurnLog();
        log1.initialize(root);
        log1.append(
          makeEvent('fix: "quoted" string\nwith newline\nand 🎉 emoji'),
          ["src/file.ts"],
        );

        const log2 = new TurnLog();
        log2.initialize(root);
        const prompt = log2.formatForPrompt();
        assert.ok(prompt.includes("🎉"));
        assert.ok(prompt.includes('"quoted"'));
      } finally {
        cleanup();
      }
    });
  });

  describe("double initialize()", () => {
    it("overwrites state on second initialize (no duplicate entries)", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const log = new TurnLog();
        log.initialize(root);
        log.append(makeEvent("first"), ["a.ts"]);

        // Second initialize should reload from disk (overwriting in-memory state)
        log.initialize(root);
        assert.equal(log.turnCount, 1, "should not duplicate entries");
      } finally {
        cleanup();
      }
    });
  });

  describe("deleteFromDisk() — file already missing", () => {
    it("does not throw when file does not exist", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const log = new TurnLog();
        log.initialize(root);
        // clear() calls deleteFromDisk() even though no file exists
        log.clear();
        // should not throw
      } finally {
        cleanup();
      }
    });
  });

  describe("persistence failure — no crash", () => {
    it("continues in-memory operation when write fails", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const log = new TurnLog();
        log.initialize(root);

        // Remove write permission from .pi-git
        const piGitDir = join(root, ".pi-git");
        mkdirSync(piGitDir, { recursive: true });
        const filePath = join(piGitDir, "turn-log.json");
        writeFileSync(filePath, "{}");
        // Make directory read-only to force write failure
        // (Note: on some systems this may not fully prevent write, but the
        //  catch block handles all errors gracefully)
        try {
          execSync(`chmod 555 "${piGitDir}"`, { stdio: "pipe" });
        } catch {
          // chmod may not work on all platforms; skip test if it fails
          return;
        }

        // append should not throw even if save fails
        log.append(makeEvent("should not crash"), ["a.ts"]);
        assert.equal(log.turnCount, 1);

        // Restore permissions for cleanup
        try { execSync(`chmod 755 "${piGitDir}"`, { stdio: "pipe" }); } catch { /* ignore */ }
      } finally {
        cleanup();
      }
    });
  });

  describe("concurrent session collision safety", () => {
    it("uses PID in tmp filename to avoid collisions", () => {
      // Verify that saveToDisk uses a PID-unique tmp path.
      // This is a design-level verification — the code uses
      // `turn-log.json.${process.pid}.tmp` as the tmp filename.
      // We test indirectly by verifying save+load round-trips
      // correctly (which proves the rename works).
      const { root, cleanup } = makeTempGitRepo();
      try {
        const log = new TurnLog();
        log.initialize(root);
        log.append(makeEvent("pid-safe"), ["a.ts"]);

        // Verify no stale .tmp file left
        const dir = join(root, ".pi-git");
        const files = execSync(`ls "${dir}"`, { encoding: "utf-8", stdio: "pipe" }).trim().split("\n");
        const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
        assert.equal(tmpFiles.length, 0, "no .tmp files should remain after save");

        // Verify the actual file exists and is valid JSON
        const raw = readFileSync(join(dir, "turn-log.json"), "utf-8");
        const data = JSON.parse(raw);
        assert.equal(data.entries.length, 1);
      } finally {
        cleanup();
      }
    });
  });

  describe("stale tmp cleanup", () => {
    it("removes stale .tmp file on initialize", () => {
      const { root, cleanup } = makeTempGitRepo();
      try {
        const dir = join(root, ".pi-git");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "turn-log.json.tmp"), "garbage");

        const log = new TurnLog();
        log.initialize(root);

        assert.ok(!existsSync(join(dir, "turn-log.json.tmp")),
          "stale .tmp file should be cleaned up");
      } finally {
        cleanup();
      }
    });
  });
});

// ── Also test the singleton behavior ──

describe("TurnLog singleton", () => {
  it("turnLog is an instance of TurnLog", () => {
    assert.ok(turnLog instanceof TurnLog);
  });
});
