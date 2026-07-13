import assert from "node:assert";
import { describe, it } from "node:test";
import { isGitCommitCommand } from "./commit-guard.js";

void describe("isGitCommitCommand", () => {
  void it("returns false for empty string", () => {
    assert.strictEqual(isGitCommitCommand(""), false);
  });

  void it("returns false for unrelated commands", () => {
    assert.strictEqual(isGitCommitCommand("git status"), false);
    assert.strictEqual(isGitCommitCommand("git add -A"), false);
    assert.strictEqual(isGitCommitCommand("git reset --soft HEAD~1"), false);
    assert.strictEqual(isGitCommitCommand("git stash"), false);
    assert.strictEqual(isGitCommitCommand("ls -la"), false);
    assert.strictEqual(isGitCommitCommand("npm test"), false);
  });

  void it("detects basic git commit", () => {
    assert.strictEqual(
      isGitCommitCommand('git commit -m "feat: add thing"'),
      true,
    );
  });

  void it("detects git commit --amend", () => {
    assert.strictEqual(
      isGitCommitCommand('git commit --amend -m "fixed"'),
      true,
    );
  });

  void it("detects git commit --no-verify", () => {
    assert.strictEqual(
      isGitCommitCommand('git commit --no-verify -m "x"'),
      true,
    );
  });

  void it("detects git with global options before commit", () => {
    assert.strictEqual(
      isGitCommitCommand("git -C /some/path commit -m msg"),
      true,
    );
  });

  void it("detects git commit after && separator", () => {
    assert.strictEqual(
      isGitCommitCommand('git add -A && git commit -m "feat: x"'),
      true,
    );
  });

  void it("detects git commit after ; separator", () => {
    assert.strictEqual(
      isGitCommitCommand('git add foo; git commit -m "y"'),
      true,
    );
  });

  void it("detects git commit after || separator", () => {
    assert.strictEqual(
      isGitCommitCommand('false || git commit -m "z"'),
      true,
    );
  });

  void it("detects git commit after pipe separator", () => {
    assert.strictEqual(
      isGitCommitCommand('echo hi | git commit -m "piped"'),
      true,
    );
  });

  void it("detects git commit on a new line", () => {
    assert.strictEqual(
      isGitCommitCommand('git add -A\ngit commit -m "newline"'),
      true,
    );
  });

  void it("detects git commit nested in sh -c quotes", () => {
    assert.strictEqual(
      isGitCommitCommand('sh -c "git commit -m \\"nested\\""'),
      true,
    );
  });

  void it("does not false-positive on git add containing the word commit", () => {
    assert.strictEqual(
      isGitCommitCommand("git add commit-message.txt"),
      false,
    );
  });

  void it("does not false-positive on a file named git-commit", () => {
    // `git commit` requires whitespace between `git` and `commit`.
    assert.strictEqual(isGitCommitCommand("./git-commit"), false);
    assert.strictEqual(isGitCommitCommand("git-commit"), false);
  });

  void it("does not false-positive on git log --grep=commit", () => {
    assert.strictEqual(
      isGitCommitCommand("git log --grep=commit"),
      false,
    );
  });

  void it("detects when only one segment of many is a commit", () => {
    assert.strictEqual(
      isGitCommitCommand(
        "npm run build\ngit status\ngit add dist\ngit commit -m release",
      ),
      true,
    );
  });
});
