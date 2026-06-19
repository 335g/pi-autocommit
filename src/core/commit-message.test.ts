/**
 * Tests for commit-message utilities.
 *
 * Run: node --import tsx --test src/core/commit-message.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateFallbackMessage,
  isGenericMessage,
  sanitizeCommitMessage,
} from "./commit-message.js";

describe("generateFallbackMessage", () => {
  it("returns English message by default", () => {
    const message = generateFallbackMessage(["src/auth/login.ts"]);
    assert.equal(message, "chore: update login.ts");
  });

  it("returns Japanese message when lang is ja", () => {
    const message = generateFallbackMessage(["src/auth/login.ts"], "ja");
    assert.equal(message, "chore: login.tsを更新");
  });

  it("returns English plural message by default", () => {
    const message = generateFallbackMessage(["a.ts", "b.ts"]);
    assert.equal(message, "chore: update 2 files");
  });

  it("returns Japanese plural message when lang is ja", () => {
    const message = generateFallbackMessage(["a.ts", "b.ts"], "ja");
    assert.equal(message, "chore: 2ファイルを更新");
  });
});

describe("isGenericMessage", () => {
  it("flags short messages", () => {
    assert.equal(isGenericMessage("fix: bug"), true);
  });

  it("flags English generic patterns", () => {
    assert.equal(isGenericMessage("chore: apply changes"), true);
    assert.equal(isGenericMessage("chore: update files"), true);
    assert.equal(isGenericMessage("chore: update src"), true);
  });

  it("flags Japanese generic patterns", () => {
    assert.equal(isGenericMessage("chore: 変更を適用"), true);
    assert.equal(isGenericMessage("fix: 修正しました"), true);
    assert.equal(isGenericMessage("chore: ファイルを更新しました"), true);
  });

  it("accepts specific messages", () => {
    assert.equal(isGenericMessage("feat(auth): add login form validation"), false);
    assert.equal(isGenericMessage("fix(payment): add null check in processor"), false);
    assert.equal(isGenericMessage("docs: fix typo in README installation section"), false);
  });
});

describe("sanitizeCommitMessage", () => {
  it("normalizes valid Conventional Commit messages", () => {
    assert.equal(
      sanitizeCommitMessage("feat(auth): add login form", ["src/auth/login.ts"]),
      "feat(auth): add login form",
    );
  });

  it("truncates overly long subjects", () => {
    const long = "feat: " + "a".repeat(100);
    const result = sanitizeCommitMessage(long, ["src/a.ts"]);
    const subject = result.replace(/^feat:\s*/, "");
    assert.ok(subject.length <= 50);
    assert.ok(subject.endsWith("..."));
  });

  it("wraps non-conventional messages with inferred type", () => {
    assert.equal(
      sanitizeCommitMessage("added login form", ["src/auth/login.ts"]),
      "chore: added login form",
    );
  });

  it("strips trailing period from subject", () => {
    assert.equal(
      sanitizeCommitMessage("fix: resolve null check.", ["src/payment.ts"]),
      "fix: resolve null check",
    );
  });

  it("takes only the first non-empty line", () => {
    assert.equal(
      sanitizeCommitMessage("feat: first line\n\nbody line", ["src/a.ts"]),
      "feat: first line",
    );
  });
});
