import assert from "node:assert";
import { describe, it } from "node:test";
import {
  blockedInterleavingVerb,
  buildBlockReason,
  interleavingAllowedWithoutCheckpoints,
  shouldBlockGitCommit,
  shouldBlockGitHardReset,
  shouldBlockGitPush,
  shouldCreateCheckpointCommit,
  shouldSkipReorganisation,
} from "./commit-policy.js";

function makeToolResult(toolName: string) {
  return {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName,
    content: [{ type: "text" as const, text: "ok" }],
    isError: false,
    timestamp: Date.now(),
  };
}

void describe("shouldCreateCheckpointCommit", () => {
  void it("returns false for empty tool results", () => {
    assert.strictEqual(shouldCreateCheckpointCommit([]), false);
  });

  void it("returns false for read-only tools", () => {
    assert.strictEqual(
      shouldCreateCheckpointCommit([
        makeToolResult("read"),
        makeToolResult("grep"),
        makeToolResult("find"),
        makeToolResult("ls"),
      ]),
      false,
    );
  });

  void it("returns true for write tool", () => {
    assert.strictEqual(shouldCreateCheckpointCommit([makeToolResult("write")]), true);
  });

  void it("returns true for edit tool", () => {
    assert.strictEqual(shouldCreateCheckpointCommit([makeToolResult("edit")]), true);
  });

  void it("returns true for bash tool", () => {
    assert.strictEqual(shouldCreateCheckpointCommit([makeToolResult("bash")]), true);
  });

  void it("returns true when any tool is potentially mutating", () => {
    assert.strictEqual(
      shouldCreateCheckpointCommit([
        makeToolResult("read"),
        makeToolResult("edit"),
        makeToolResult("grep"),
      ]),
      true,
    );
  });
});

void describe("shouldBlockGitCommit", () => {
  void it("returns false for empty string", () => {
    assert.strictEqual(shouldBlockGitCommit(""), false);
  });

  void it("returns false for unrelated commands", () => {
    assert.strictEqual(shouldBlockGitCommit("git status"), false);
    assert.strictEqual(shouldBlockGitCommit("git add -A"), false);
    assert.strictEqual(shouldBlockGitCommit("git reset --soft HEAD~1"), false);
    assert.strictEqual(shouldBlockGitCommit("git stash"), false);
    assert.strictEqual(shouldBlockGitCommit("ls -la"), false);
    assert.strictEqual(shouldBlockGitCommit("npm test"), false);
  });

  void it("detects basic git commit", () => {
    assert.strictEqual(
      shouldBlockGitCommit('git commit -m "feat: add thing"'),
      true,
    );
  });

  void it("detects git commit --amend", () => {
    assert.strictEqual(
      shouldBlockGitCommit('git commit --amend -m "fixed"'),
      true,
    );
  });

  void it("detects git commit --no-verify", () => {
    assert.strictEqual(
      shouldBlockGitCommit('git commit --no-verify -m "x"'),
      true,
    );
  });

  void it("detects git with global options before commit", () => {
    assert.strictEqual(
      shouldBlockGitCommit("git -C /some/path commit -m msg"),
      true,
    );
  });

  void it("detects git commit after && separator", () => {
    assert.strictEqual(
      shouldBlockGitCommit('git add -A && git commit -m "feat: x"'),
      true,
    );
  });

  void it("detects git commit after ; separator", () => {
    assert.strictEqual(
      shouldBlockGitCommit('git add foo; git commit -m "y"'),
      true,
    );
  });

  void it("detects git commit after || separator", () => {
    assert.strictEqual(
      shouldBlockGitCommit('false || git commit -m "z"'),
      true,
    );
  });

  void it("detects git commit after pipe separator", () => {
    assert.strictEqual(
      shouldBlockGitCommit('echo hi | git commit -m "piped"'),
      true,
    );
  });

  void it("detects git commit on a new line", () => {
    assert.strictEqual(
      shouldBlockGitCommit('git add -A\ngit commit -m "newline"'),
      true,
    );
  });

  void it("detects git commit nested in sh -c quotes", () => {
    assert.strictEqual(
      shouldBlockGitCommit('sh -c "git commit -m \\"nested\\""'),
      true,
    );
  });

  void it("does not false-positive on git add containing the word commit", () => {
    assert.strictEqual(
      shouldBlockGitCommit("git add commit-message.txt"),
      false,
    );
  });

  void it("does not false-positive on a file named git-commit", () => {
    // `git commit` requires whitespace between `git` and `commit`.
    assert.strictEqual(shouldBlockGitCommit("./git-commit"), false);
    assert.strictEqual(shouldBlockGitCommit("git-commit"), false);
  });

  void it("does not false-positive on git log --grep=commit", () => {
    assert.strictEqual(
      shouldBlockGitCommit("git log --grep=commit"),
      false,
    );
  });

  void it("detects when only one segment of many is a commit", () => {
    assert.strictEqual(
      shouldBlockGitCommit(
        "npm run build\ngit status\ngit add dist\ngit commit -m release",
      ),
      true,
    );
  });
});

void describe("shouldBlockGitPush", () => {
  void it("returns false for empty string", () => {
    assert.strictEqual(shouldBlockGitPush(""), false);
  });

  void it("returns false for unrelated commands", () => {
    assert.strictEqual(shouldBlockGitPush("git status"), false);
    assert.strictEqual(shouldBlockGitPush("git fetch"), false);
    assert.strictEqual(shouldBlockGitPush("git pull"), false);
    assert.strictEqual(shouldBlockGitPush("git add -A"), false);
    assert.strictEqual(shouldBlockGitPush("ls -la"), false);
    assert.strictEqual(shouldBlockGitPush("npm run build"), false);
  });

  void it("detects bare git push", () => {
    assert.strictEqual(shouldBlockGitPush("git push"), true);
  });

  void it("detects git push with refspec", () => {
    assert.strictEqual(
      shouldBlockGitPush("git push origin main"),
      true,
    );
  });

  void it("detects git push with flags", () => {
    assert.strictEqual(
      shouldBlockGitPush("git push --force-with-lease origin main"),
      true,
    );
  });

  void it("detects git push --delete", () => {
    assert.strictEqual(
      shouldBlockGitPush("git push origin --delete feature-branch"),
      true,
    );
  });

  void it("detects git -C push", () => {
    assert.strictEqual(
      shouldBlockGitPush("git -C /some/path push origin main"),
      true,
    );
  });

  void it("detects git push in a compound command", () => {
    assert.strictEqual(
      shouldBlockGitPush('npm run build && git push origin main'),
      true,
    );
  });

  void it("detects git push on a new line", () => {
    assert.strictEqual(
      shouldBlockGitPush('git add -A\ngit push origin main'),
      true,
    );
  });

  void it("detects git push nested in sh -c quotes", () => {
    assert.strictEqual(
      shouldBlockGitPush('sh -c "git push origin main"'),
      true,
    );
  });

  void it("does not false-positive on git log --grep=push", () => {
    assert.strictEqual(
      shouldBlockGitPush("git log --grep=push"),
      false,
    );
  });

  void it("does not false-positive on a file named git-push", () => {
    assert.strictEqual(shouldBlockGitPush("./git-push"), false);
    assert.strictEqual(shouldBlockGitPush("git-push"), false);
  });
});

void describe("shouldBlockGitHardReset", () => {
  void it("detects git reset --hard", () => {
    assert.strictEqual(shouldBlockGitHardReset("git reset --hard"), true);
  });

  void it("detects git reset --hard HEAD~1", () => {
    assert.strictEqual(
      shouldBlockGitHardReset("git reset --hard HEAD~1"),
      true,
    );
  });

  void it("detects git reset --hard with global options", () => {
    assert.strictEqual(
      shouldBlockGitHardReset("git -C /path reset --hard"),
      true,
    );
  });

  void it("detects git reset --hard in a compound command", () => {
    assert.strictEqual(
      shouldBlockGitHardReset("git add -A && git reset --hard"),
      true,
    );
  });

  void it("detects git reset --hard on a new line", () => {
    assert.strictEqual(
      shouldBlockGitHardReset("git reset --hard\ngit status"),
      true,
    );
  });

  void it("allows git reset --soft", () => {
    assert.strictEqual(
      shouldBlockGitHardReset("git reset --soft HEAD~1"),
      false,
    );
  });

  void it("allows git reset --mixed", () => {
    assert.strictEqual(
      shouldBlockGitHardReset("git reset --mixed HEAD~1"),
      false,
    );
  });

  void it("allows plain git reset", () => {
    assert.strictEqual(shouldBlockGitHardReset("git reset HEAD~1"), false);
  });
});

void describe("blockedInterleavingVerb", () => {
  void it("detects git merge", () => {
    assert.strictEqual(blockedInterleavingVerb("git merge main"), "merge");
  });

  void it("allows git merge --squash (no commit is created)", () => {
    assert.strictEqual(
      blockedInterleavingVerb("git merge --squash wt/task1"),
      null,
    );
    assert.strictEqual(
      blockedInterleavingVerb("git merge wt/task1 --squash"),
      null,
    );
  });

  void it("allows git merge --squash in a compound command", () => {
    assert.strictEqual(
      blockedInterleavingVerb("git merge --squash wt/task1 && git status"),
      null,
    );
  });

  void it("blocks git merge --no-squash", () => {
    assert.strictEqual(
      blockedInterleavingVerb("git merge --no-squash main"),
      "merge",
    );
  });

  void it("detects git cherry-pick", () => {
    assert.strictEqual(
      blockedInterleavingVerb("git cherry-pick abc123"),
      "cherry-pick",
    );
  });

  void it("detects git rebase", () => {
    assert.strictEqual(blockedInterleavingVerb("git rebase main"), "rebase");
  });

  void it("detects in a compound command", () => {
    assert.strictEqual(
      blockedInterleavingVerb("git fetch && git rebase main"),
      "rebase",
    );
  });

  void it("returns null for safe verbs", () => {
    assert.strictEqual(blockedInterleavingVerb("git status"), null);
    assert.strictEqual(blockedInterleavingVerb("git add -A"), null);
    assert.strictEqual(blockedInterleavingVerb("git reset --hard"), null);
    assert.strictEqual(blockedInterleavingVerb("git log"), null);
    assert.strictEqual(blockedInterleavingVerb("git fetch origin"), null);
  });
});

void describe("buildBlockReason", () => {
  void it("mentions the disable command in Japanese", () => {
    const reason = buildBlockReason("commit", true);
    assert.ok(reason.includes("commit"));
    assert.ok(reason.includes("/autocommit-enable false"));
  });

  void it("mentions the disable command in English", () => {
    const reason = buildBlockReason("commit", false);
    assert.ok(reason.includes("commit"));
    assert.ok(reason.includes("/autocommit-enable false"));
  });

  void it("rebase reason mentions manual resolution in Japanese", () => {
    const reason = buildBlockReason("rebase", true);
    assert.ok(reason.includes("rebase --abort"));
  });

  void it("rebase reason mentions manual resolution in English", () => {
    const reason = buildBlockReason("rebase", false);
    assert.ok(reason.includes("rebase --abort"));
  });

  void it("reset --hard reason explains the destructive nature", () => {
    const ja = buildBlockReason("reset --hard", true);
    assert.ok(ja.includes("作業ツリー"));
    const en = buildBlockReason("reset --hard", false);
    assert.ok(en.includes("working tree"));
  });

  void it("merge and cherry-pick use the interleaving reason", () => {
    const jaMerge = buildBlockReason("merge", true);
    const jaCherryPick = buildBlockReason("cherry-pick", true);
    assert.ok(jaMerge.includes("チェックポイント"));
    assert.ok(jaMerge.includes("merge"));
    assert.ok(jaCherryPick.includes("cherry-pick"));
  });

  void it("merge reason suggests --squash", () => {
    const ja = buildBlockReason("merge", true);
    const en = buildBlockReason("merge", false);
    assert.ok(ja.includes("--squash"));
    assert.ok(en.includes("--squash"));
  });
});

void describe("interleavingAllowedWithoutCheckpoints", () => {
  const marker = "wip(checkpoint):";

  void it("allows merge when HEAD is not a checkpoint", () => {
    assert.strictEqual(
      interleavingAllowedWithoutCheckpoints("merge", "feat: base", marker),
      true,
    );
  });

  void it("allows cherry-pick when HEAD is not a checkpoint", () => {
    assert.strictEqual(
      interleavingAllowedWithoutCheckpoints("cherry-pick", "feat: base", marker),
      true,
    );
  });

  void it("blocks merge when HEAD is a checkpoint", () => {
    assert.strictEqual(
      interleavingAllowedWithoutCheckpoints(
        "merge",
        "wip(checkpoint): auto-commit at turn 1",
        marker,
      ),
      false,
    );
  });

  void it("blocks merge when HEAD cannot be resolved", () => {
    assert.strictEqual(
      interleavingAllowedWithoutCheckpoints("merge", null, marker),
      false,
    );
  });

  void it("does not apply to other blocked verbs", () => {
    assert.strictEqual(
      interleavingAllowedWithoutCheckpoints("rebase", "feat: base", marker),
      false,
    );
    assert.strictEqual(
      interleavingAllowedWithoutCheckpoints("commit", "feat: base", marker),
      false,
    );
  });
});

void describe("shouldSkipReorganisation", () => {
  void it("skips when both hashes are identical", () => {
    assert.strictEqual(shouldSkipReorganisation("abc123", "abc123"), true);
  });

  void it("does not skip when hashes differ", () => {
    assert.strictEqual(shouldSkipReorganisation("abc123", "def456"), false);
  });

  void it("does not skip when the baseline is null", () => {
    assert.strictEqual(shouldSkipReorganisation(null, "abc123"), false);
  });

  void it("does not skip when the current head is null", () => {
    assert.strictEqual(shouldSkipReorganisation("abc123", null), false);
  });

  void it("does not skip when both are null", () => {
    assert.strictEqual(shouldSkipReorganisation(null, null), false);
  });
});
