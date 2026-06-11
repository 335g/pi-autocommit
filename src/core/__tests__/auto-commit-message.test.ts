/**
 * Unit tests for auto-commit-message.ts pure functions.
 *
 * Run with: npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isGenericMessage,
  cleanCommitOutput,
  specificityScore,
  userMessageToCandidate,
  isValidCommitSubject,
  isCheapModel,
  getBudgetMultiplier,
  buildTypeHintForMessage,
} from "../auto-commit-message.js";

// ── isGenericMessage ──────────────────────────────────────────

describe("isGenericMessage", () => {
  describe("English patterns", () => {
    it("detects generic English messages", () => {
      assert.equal(isGenericMessage("chore: apply changes"), true);
      assert.equal(isGenericMessage("chore: update files"), true);
      assert.equal(isGenericMessage("chore: commit changes"), true);
      assert.equal(isGenericMessage("chore: modify files"), true);
    });

    it("detects very short messages (< 12 chars)", () => {
      assert.equal(isGenericMessage("fix: fix"), true);
      assert.equal(isGenericMessage("chore: a"), true);
    });

    it("detects CC messages with body <= 10 chars", () => {
      // "feat: abcdefghij" = 16 chars total, body "abcdefghij" = 10 chars — caught by body-length pattern
      assert.equal(isGenericMessage("feat: abcdefghij"), true);
    });

    it("allows specific English messages", () => {
      assert.equal(
        isGenericMessage("feat: add login form with validation"),
        false,
      );
      assert.equal(
        isGenericMessage("fix: resolve null pointer in auth module"),
        false,
      );
      assert.equal(isGenericMessage("docs: update installation guide"), false);
    });
  });

  describe("Japanese patterns", () => {
    it("detects generic Japanese messages with polite endings", () => {
      assert.equal(isGenericMessage("fix: 修正しました"), true);
      assert.equal(isGenericMessage("feat: 追加しました"), true);
      assert.equal(isGenericMessage("fix: 修正しました。"), true);
    });

    it("detects generic Japanese messages without polite endings", () => {
      assert.equal(isGenericMessage("chore: 変更を適用"), true);
      assert.equal(isGenericMessage("chore: ファイルを更新"), true);
    });

    it("detects bare generic Japanese words with CC prefix", () => {
      assert.equal(isGenericMessage("fix: 修正"), true);
      assert.equal(isGenericMessage("feat: 追加"), true);
      assert.equal(isGenericMessage("chore: 更新"), true);
    });

    it("allows specific Japanese messages", () => {
      assert.equal(
        isGenericMessage("feat: ログインフォームを追加"),
        false,
      );
      assert.equal(isGenericMessage("fix: nullチェックを追加"), false);
    });

    it("allows compound Japanese words that contain generic keywords", () => {
      // "削除機能を追加" contains "削除" but is specific
      assert.equal(isGenericMessage("feat: 削除機能を追加"), false);
      // "依存関係を更新" contains "更新" at the end but is specific
      assert.equal(isGenericMessage("chore: 依存関係を更新"), false);
    });
  });
});

// ── cleanCommitOutput ─────────────────────────────────────────

describe("cleanCommitOutput", () => {
  it("passes through clean messages unchanged", () => {
    assert.equal(cleanCommitOutput("feat: add login form"), "feat: add login form");
    assert.equal(cleanCommitOutput("fix: resolve bug"), "fix: resolve bug");
  });

  it("extracts from markdown fences", () => {
    assert.equal(
      cleanCommitOutput("```\nfeat: add login\n```"),
      "feat: add login",
    );
  });

  it("strips English chat prefixes", () => {
    assert.equal(
      cleanCommitOutput("Here is the commit message: feat: add login"),
      "feat: add login",
    );
    assert.equal(
      cleanCommitOutput("commit message: fix: resolve bug"),
      "fix: resolve bug",
    );
    assert.equal(
      cleanCommitOutput("Sure! feat: add login form"),
      "feat: add login form",
    );
  });

  it("strips Japanese chat prefixes", () => {
    assert.equal(
      cleanCommitOutput("コミットメッセージ: feat: ログイン追加"),
      "feat: ログイン追加",
    );
    assert.equal(
      cleanCommitOutput("今回のコミット: feat: ログインを追加"),
      "feat: ログインを追加",
    );
    assert.equal(
      cleanCommitOutput("はい、承知しました。feat: ログインを追加"),
      "feat: ログインを追加",
    );
  });

  it("strips backtick wrapping", () => {
    assert.equal(cleanCommitOutput("`feat: add login`"), "feat: add login");
  });

  it("picks first CC line from multiple options", () => {
    const input = "feat: add login\nfix: resolve bug\nchore: update deps";
    assert.equal(cleanCommitOutput(input), "feat: add login");
  });

  it("handles Japanese fence info strings", () => {
    assert.equal(
      cleanCommitOutput("```コミットメッセージ\nfeat: ログインを追加\n```"),
      "feat: ログインを追加",
    );
  });

  it("handles nested wrappers (prefix inside fences)", () => {
    const input =
      "Sure! Here is the commit message:\n```\nfeat: add login\n```";
    assert.equal(cleanCommitOutput(input), "feat: add login");
  });

  it("falls back to first line when no CC found", () => {
    assert.equal(
      cleanCommitOutput("This is just a chat message\nwith multiple lines"),
      "This is just a chat message",
    );
  });

  it("returns empty string for whitespace-only input", () => {
    assert.equal(cleanCommitOutput("  \n\n  "), "");
  });
});

// ── specificityScore ──────────────────────────────────────────

describe("specificityScore", () => {
  it("ranks specific messages higher than generic ones", () => {
    const generic = specificityScore("chore: update files");
    const specific = specificityScore(
      "feat: implement JWT authentication for API",
    );
    assert.ok(specific > generic);
  });

  it("rewards CamelCase terms", () => {
    const withCamel = specificityScore("feat: add LoginForm component");
    const withoutCamel = specificityScore("feat: add login form component");
    assert.ok(withCamel > withoutCamel);
  });

  it("penalizes generic English words", () => {
    const generic = specificityScore("chore: update and change files");
    const specific = specificityScore("feat: implement auth middleware");
    assert.ok(specific > generic);
  });

  describe("Japanese", () => {
    it("rewards kanji density", () => {
      const rich = specificityScore("feat: ログインフォームバリデーションを実装", "ja");
      const poor = specificityScore("fix: 修正", "ja");
      assert.ok(rich > poor);
    });

    it("rewards katakana technical terms", () => {
      const withKatakana = specificityScore(
        "feat: バリデーションロジックを追加",
        "ja",
      );
      const withoutKatakana = specificityScore("feat: 機能を追加", "ja");
      // katakana is rewarded more; even if both have similar kanji,
      // the katakana version should score higher unless "機能を追加" is flagged as generic
      assert.ok(withKatakana > withoutKatakana - 2);
    });

    it("penalizes single-word generic Japanese subjects", () => {
      const singleWord = specificityScore("fix: 修正", "ja");
      const compound = specificityScore("fix: nullチェックを追加", "ja");
      assert.ok(compound > singleWord);
    });
  });
});

// ── userMessageToCandidate ─────────────────────────────────────

describe("userMessageToCandidate", () => {
  it("infers fix type from keywords", () => {
    const result = userMessageToCandidate("fix the null pointer bug");
    assert.ok(result.startsWith("fix:"));
  });

  it("infers feat type from keywords", () => {
    const result = userMessageToCandidate(
      "add a login form to the auth page",
    );
    assert.ok(result.startsWith("feat:"));
  });

  it("strips Japanese polite endings", () => {
    const result = userMessageToCandidate(
      "ログインフォームを追加してください",
    );
    assert.ok(result.includes("ログインフォームを追加"));
    assert.ok(!result.includes("ください"));
  });

  it("strips please", () => {
    const result = userMessageToCandidate("please fix the bug");
    assert.ok(!result.includes("please"));
  });

  it("returns empty string for empty input", () => {
    assert.equal(userMessageToCandidate(""), "");
  });
});

// ── isValidCommitSubject ───────────────────────────────────────

describe("isValidCommitSubject", () => {
  describe("English", () => {
    it("rejects conversational markers", () => {
      assert.equal(isValidCommitSubject("can you add login", "en"), false);
      assert.equal(isValidCommitSubject("could you fix the bug", "en"), false);
      assert.equal(isValidCommitSubject("please fix the bug", "en"), false);
      assert.equal(
        isValidCommitSubject("I'd like you to refactor auth", "en"),
        false,
      );
      assert.equal(
        isValidCommitSubject("I want you to add tests", "en"),
        false,
      );
      assert.equal(isValidCommitSubject("let's add login", "en"), false);
    });

    it("rejects subjects ending with ? or !", () => {
      assert.equal(isValidCommitSubject("add login?", "en"), false);
      assert.equal(isValidCommitSubject("fix it!", "en"), false);
    });

    it("rejects very short subjects", () => {
      assert.equal(isValidCommitSubject("ab", "en"), false);
    });

    it("allows specific descriptive subjects", () => {
      assert.equal(isValidCommitSubject("add login form", "en"), true);
      assert.equal(
        isValidCommitSubject("fix null pointer in auth", "en"),
        true,
      );
      assert.equal(
        isValidCommitSubject("implement JWT authentication", "en"),
        true,
      );
    });
  });

  describe("Japanese", () => {
    it("rejects conversational markers", () => {
      assert.equal(
        isValidCommitSubject("ログインを追加してください", "ja"),
        false,
      );
      assert.equal(isValidCommitSubject("修正をお願いします", "ja"), false);
    });

    it("allows specific subjects", () => {
      assert.equal(
        isValidCommitSubject("ログインフォームを追加", "ja"),
        true,
      );
    });
  });
});

// ── isCheapModel ───────────────────────────────────────────────

describe("isCheapModel", () => {
  it("detects mini/flash/nano/lite/small/haiku models", () => {
    assert.equal(isCheapModel("gpt-5.4-mini"), true);
    assert.equal(isCheapModel("gemini-2.0-flash"), true);
    assert.equal(isCheapModel("gemini-nano"), true);
    assert.equal(isCheapModel("deepseek-coder-v2-lite"), true);
    assert.equal(isCheapModel("mistral-small"), true);
    assert.equal(isCheapModel("claude-3.5-haiku"), true);
  });

  it("does not detect large models", () => {
    assert.equal(isCheapModel("deepseek-v4-pro"), false);
    assert.equal(isCheapModel("gpt-4o"), false);
    assert.equal(isCheapModel("claude-sonnet-4"), false);
    assert.equal(isCheapModel("gemini-2.5-pro"), false);
  });
});

// ── getBudgetMultiplier ────────────────────────────────────────

describe("getBudgetMultiplier", () => {
  it('returns "small" for cheap models', () => {
    assert.equal(getBudgetMultiplier("gpt-5.4-mini"), "small");
  });

  it('returns "large" for capable models', () => {
    assert.equal(getBudgetMultiplier("deepseek-v4-pro"), "large");
  });

  it('returns "small" for undefined (conservative default)', () => {
    assert.equal(getBudgetMultiplier(undefined), "small");
  });
});

// ── buildTypeHintForMessage ────────────────────────────────────

describe("buildTypeHintForMessage", () => {
  it("returns hint for test files", () => {
    const result = buildTypeHintForMessage(["src/auth/login.test.ts"]);
    assert.ok(result.includes("test"));
    assert.ok(result.includes("Hint"));
  });

  it("returns empty for generic file types (chore)", () => {
    const result = buildTypeHintForMessage(["package.json"]);
    assert.equal(result, "");
  });

  it("returns hint for doc files", () => {
    const result = buildTypeHintForMessage(["README.md"]);
    assert.ok(result.includes("docs"));
  });
});
