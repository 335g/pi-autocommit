/**
 * Tests for TurnLog clean-start policy helper.
 *
 * Run: node --import tsx --test src/core/turn-log-cleaner.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { maybeClearTurnLogOnCleanStart } from "./turn-log-cleaner.js";
import { TurnLog } from "./turn-log.js";
import { diagReset, diagSnapshot } from "../utils/diagnostics.js";
import type { AgentEndEvent } from "../types.js";

// ── Test helpers ──

function makeEvent(userMessage?: string): AgentEndEvent {
  const messages: Array<{ role: string; content: unknown }> = [];
  if (userMessage !== undefined) {
    messages.push({ role: "user", content: userMessage });
  }
  return { messages };
}

function makeTempGitRepo(): { root: string; cleanup: () => void } {
  const dir = join(tmpdir(), `pi-git-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "pipe" });
  return {
    root: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeMockPi(statusOutput: string | "throw"): ExtensionAPI {
  return {
    exec: async (command: string, args: string[]) => {
      if (statusOutput === "throw") {
        throw new Error("git status failed");
      }
      if (command === "git" && args[0] === "status" && args[1] === "--porcelain") {
        return { stdout: statusOutput, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  } as unknown as ExtensionAPI;
}

// ── Tests ──

describe("maybeClearTurnLogOnCleanStart", () => {
  beforeEach(() => {
    diagReset();
  });

  it("clears TurnLog when working tree is clean", async () => {
    const pi = makeMockPi("");
    const log = new TurnLog();
    log.append(makeEvent("turn 1"), ["a.ts"]);

    await maybeClearTurnLogOnCleanStart(pi, "/repo", log);

    assert.equal(log.turnCount, 0);
    assert.equal(diagSnapshot().turnLog_autoClearedOnCleanStart, 1);
  });

  it("keeps TurnLog when working tree has unstaged changes", async () => {
    const pi = makeMockPi(" M a.ts\n");
    const log = new TurnLog();
    log.append(makeEvent("turn 1"), ["a.ts"]);

    await maybeClearTurnLogOnCleanStart(pi, "/repo", log);

    assert.equal(log.turnCount, 1);
    assert.equal(diagSnapshot().turnLog_autoClearedOnCleanStart, 0);
  });

  it("keeps TurnLog when working tree has staged changes", async () => {
    const pi = makeMockPi("M  a.ts\n");
    const log = new TurnLog();
    log.append(makeEvent("turn 1"), ["a.ts"]);

    await maybeClearTurnLogOnCleanStart(pi, "/repo", log);

    assert.equal(log.turnCount, 1);
    assert.equal(diagSnapshot().turnLog_autoClearedOnCleanStart, 0);
  });

  it("keeps TurnLog when there are untracked files", async () => {
    const pi = makeMockPi("?? a.ts\n");
    const log = new TurnLog();
    log.append(makeEvent("turn 1"), ["a.ts"]);

    await maybeClearTurnLogOnCleanStart(pi, "/repo", log);

    assert.equal(log.turnCount, 1);
    assert.equal(diagSnapshot().turnLog_autoClearedOnCleanStart, 0);
  });

  it("does nothing when TurnLog is already empty", async () => {
    const pi = makeMockPi("");
    const log = new TurnLog();

    await maybeClearTurnLogOnCleanStart(pi, "/repo", log);

    assert.equal(log.turnCount, 0);
    assert.equal(diagSnapshot().turnLog_autoClearedOnCleanStart, 0);
  });

  it("does not clear when hasChanges throws", async () => {
    const pi = makeMockPi("throw");
    const log = new TurnLog();
    log.append(makeEvent("turn 1"), ["a.ts"]);

    await maybeClearTurnLogOnCleanStart(pi, "/repo", log);

    assert.equal(log.turnCount, 1);
    assert.equal(diagSnapshot().turnLog_autoClearedOnCleanStart, 0);
  });

  it("works with real git repository", async () => {
    const { root, cleanup } = makeTempGitRepo();
    try {
      const pi = {
        exec: async (command: string, args: string[], options?: { cwd?: string }) => {
          try {
            const stdout = execSync(
              [command, ...args].join(" "),
              {
                cwd: options?.cwd ?? root,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
              },
            );
            return { stdout: stdout ?? "", stderr: "", code: 0 };
          } catch (err) {
            const error = err as { stderr?: string; status?: number };
            return {
              stdout: "",
              stderr: error.stderr ?? "",
              code: error.status ?? 1,
            };
          }
        },
      } as unknown as ExtensionAPI;

      const log = new TurnLog();
      log.initialize(root);
      log.append(makeEvent("turn 1"), ["a.ts"]);
      assert.equal(log.turnCount, 1);

      await maybeClearTurnLogOnCleanStart(pi, root, log);

      assert.equal(log.turnCount, 0);
      assert.equal(diagSnapshot().turnLog_autoClearedOnCleanStart, 1);
    } finally {
      cleanup();
    }
  });
});
