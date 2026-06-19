/**
 * Tests for diff-analyzer — diff-hunk parsing, numbered formatting,
 * intent response parsing, and hunk coverage validation.
 *
 * Run: node --import tsx --test src/core/diff-analyzer.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDiffHunks,
  formatNumberedHunks,
  validateHunkCoverage,
  buildIntentPrompt,
} from "./diff-analyzer.js";
import type { DiffHunk, CommitGroup } from "../types.js";

// ───────────────────────────────────────────────
// Sample diffs
// ───────────────────────────────────────────────

/** Two files, 3 hunks total: two in one file, one in another */
const SIMPLE_DIFF = `
diff --git a/src/auth/login.ts b/src/auth/login.ts
index abc123..def456 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -10,5 +10,7 @@
-old code
+new code
+added line
 
@@ -30,3 +32,4 @@ function foo() {
 context line
+another addition
 end of function

diff --git a/README.md b/README.md
index 111222..333444 100644
--- a/README.md
+++ b/README.md
@@ -5,2 +5,2 @@
-typo
+fixed typo
`.trim();

/** New file */
const NEW_FILE_DIFF = `
diff --git a/src/utils/helpers.ts b/src/utils/helpers.ts
new file mode 100644
index 0000000..abcd123
--- /dev/null
+++ b/src/utils/helpers.ts
@@ -0,0 +1,15 @@
+export function helper() {
+  return 42;
+}
+
+export function anotherHelper() {
+  return "hello";
+}
`.trim();

/** Deleted file */
const DELETED_FILE_DIFF = `
diff --git a/src/old/deprecated.ts b/src/old/deprecated.ts
deleted file mode 100644
index abcd123..0000000
--- a/src/old/deprecated.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-export function oldFunc() {
-  return "deprecated";
-}
`.trim();

/** Renamed file with content changes */
const RENAMED_DIFF = `
diff --git a/src/old/name.ts b/src/new/name.ts
similarity index 80%
rename from src/old/name.ts
rename to src/new/name.ts
index abc123..def456 100644
--- a/src/old/name.ts
+++ b/src/new/name.ts
@@ -3,3 +3,5 @@
 context
+new line added
 more context
`.trim();

// ───────────────────────────────────────────────
// parseDiffHunks tests
// ───────────────────────────────────────────────

describe("parseDiffHunks", () => {
  it("parses hunks with 1-based global indices", () => {
    const hunks = parseDiffHunks(SIMPLE_DIFF);
    assert.equal(hunks.length, 3);

    assert.equal(hunks[0].globalIndex, 1);
    assert.equal(hunks[1].globalIndex, 2);
    assert.equal(hunks[2].globalIndex, 3);
  });

  it("assigns correct file paths", () => {
    const hunks = parseDiffHunks(SIMPLE_DIFF);

    assert.equal(hunks[0].file, "src/auth/login.ts");
    assert.equal(hunks[1].file, "src/auth/login.ts");
    assert.equal(hunks[2].file, "README.md");
  });

  it("assigns per-file hunk indices (0-based)", () => {
    const hunks = parseDiffHunks(SIMPLE_DIFF);

    assert.equal(hunks[0].hunkIndexInFile, 0);
    assert.equal(hunks[1].hunkIndexInFile, 1); // second hunk in same file
    assert.equal(hunks[2].hunkIndexInFile, 0);
  });

  it("extracts @@ header and summary", () => {
    const hunks = parseDiffHunks(SIMPLE_DIFF);

    assert.ok(hunks[0].header.startsWith("@@"));
    assert.ok(hunks[0].content.includes("@@ -10,5 +10,7 @@"));
    assert.ok(hunks[0].content.includes("+new code"));
    assert.equal(typeof hunks[0].summary, "string");
    assert.ok(hunks[0].summary.length > 0);
  });

  it("recognizes new files (with @@ hunks → not atomic)", () => {
    const hunks = parseDiffHunks(NEW_FILE_DIFF);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].file, "src/utils/helpers.ts");
    assert.equal(hunks[0].isNewFile, true);
    assert.equal(hunks[0].isDeletedFile, false);
    assert.equal(hunks[0].isAtomic, false);
  });

  it("handles deleted files (with @@ hunks → not atomic)", () => {
    const hunks = parseDiffHunks(DELETED_FILE_DIFF);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].file, "src/old/deprecated.ts");
    assert.equal(hunks[0].isDeletedFile, true);
    // Deleted files have @@ hunks showing removed content — not atomic
    assert.equal(hunks[0].isAtomic, false);
  });

  it("handles renamed files", () => {
    const hunks = parseDiffHunks(RENAMED_DIFF);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].file, "src/new/name.ts");
    assert.equal(hunks[0].isAtomic, false);
  });

  it("handles empty diff", () => {
    const hunks = parseDiffHunks("");
    assert.equal(hunks.length, 0);
  });

  it("handles single-file diff", () => {
    const diff = `
diff --git a/src/single.ts b/src/single.ts
index aaa..bbb 100644
--- a/src/single.ts
+++ b/src/single.ts
@@ -1,3 +1,4 @@
 line1
+line2
 line3
`.trim();
    const hunks = parseDiffHunks(diff);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].file, "src/single.ts");
    assert.equal(hunks[0].globalIndex, 1);
    assert.equal(hunks[0].hunkIndexInFile, 0);
  });
});

// ───────────────────────────────────────────────
// formatNumberedHunks tests
// ───────────────────────────────────────────────

describe("formatNumberedHunks", () => {
  it("formats hunks with [HN] prefix", () => {
    const hunks = parseDiffHunks(SIMPLE_DIFF);
    const text = formatNumberedHunks(hunks);

    assert.ok(text.includes("[H1]"));
    assert.ok(text.includes("[H2]"));
    assert.ok(text.includes("[H3]"));
  });

  it("includes file paths", () => {
    const hunks = parseDiffHunks(SIMPLE_DIFF);
    const text = formatNumberedHunks(hunks);

    assert.ok(text.includes("src/auth/login.ts"));
    assert.ok(text.includes("README.md"));
  });

  it("handles empty hunks", () => {
    const text = formatNumberedHunks([]);
    assert.equal(text, "");
  });

  it("labels new files and deleted files only when atomic", () => {
    // Regular new files (with @@ hunks) don't get labels
    const newHunks = parseDiffHunks(NEW_FILE_DIFF);
    const newText = formatNumberedHunks(newHunks);
    assert.ok(newText.includes("[H1]"));
    assert.ok(newText.includes("src/utils/helpers.ts"));
    // No label for non-atomic new files

    // Regular deleted files (with @@ hunks) don't get labels
    const deletedHunks = parseDiffHunks(DELETED_FILE_DIFF);
    const deletedText = formatNumberedHunks(deletedHunks);
    assert.ok(deletedText.includes("src/old/deprecated.ts"));
    // No label for non-atomic deleted files
  });
});

// ───────────────────────────────────────────────
// validateHunkCoverage tests
// ───────────────────────────────────────────────

const defaultGroup = (hunks: number[]): CommitGroup => ({
  hunks: hunks.map((i) => ({ globalIndex: i, file: "" })),
  message: `commit ${hunks.join(",")}`,
  confidence: "high",
});

describe("validateHunkCoverage", () => {
  it("passes through valid groups unchanged", () => {
    const groups = [
      defaultGroup([1, 2]),
      defaultGroup([3]),
    ];
    const result = validateHunkCoverage(groups, 3);

    assert.equal(result.length, 2);
    assert.equal(result[0].hunks.length, 2);
    assert.equal(result[1].hunks.length, 1);
  });

  it("collects unassigned hunks into catch-all group", () => {
    const groups = [
      defaultGroup([1]),
      // hunk 2 and 3 not assigned
    ];
    const result = validateHunkCoverage(groups, 3);

    assert.equal(result.length, 2);
    // Catch-all group should contain hunks 2 and 3
    const catchAll = result.find((g) => g.confidence === "low");
    assert.ok(catchAll);
    assert.equal(catchAll.hunks.length, 2);
    const indices = catchAll.hunks.map((h) => h.globalIndex).sort();
    assert.deepEqual(indices, [2, 3]);
  });

  it("filters out-of-range hunk indices", () => {
    const groups = [
      {
        ...defaultGroup([1]),
        hunks: [
          { globalIndex: 1, file: "" },
          { globalIndex: 999, file: "" }, // out of range
          { globalIndex: -1, file: "" },   // invalid
        ],
      },
    ];
    const result = validateHunkCoverage(groups, 5);

    assert.equal(result.length, 2); // group + catch-all for 2-5
    assert.equal(result[0].hunks.length, 1); // only index 1 kept
    assert.equal(result[0].hunks[0].globalIndex, 1);
  });

  it("deduplicates hunks assigned to multiple groups", () => {
    const groups = [
      defaultGroup([1, 2]),
      defaultGroup([2, 3]), // hunk 2 duplicated
    ];
    const result = validateHunkCoverage(groups, 3);

    // First group gets 1 and 2; second group only gets 3 (2 already taken)
    assert.equal(result[0].hunks.length, 2);
    assert.equal(result[1].hunks.length, 1);
    assert.equal(result[1].hunks[0].globalIndex, 3);
  });

  it("handles empty groups", () => {
    const result = validateHunkCoverage([], 5);
    assert.equal(result.length, 1); // catch-all with all 5 hunks
    assert.equal(result[0].confidence, "low");
    assert.equal(result[0].hunks.length, 5);
  });

  it("handles totalHunks = 0", () => {
    const result = validateHunkCoverage([], 0);
    assert.equal(result.length, 0);
  });

  it("handles perfect coverage (no unassigned)", () => {
    const groups = [
      defaultGroup([1]),
      defaultGroup([2]),
      defaultGroup([3]),
      defaultGroup([4]),
    ];
    const result = validateHunkCoverage(groups, 4);

    assert.equal(result.length, 4);
    // No catch-all needed
    assert.equal(result.every((g) => g.confidence === "high"), true);
  });
});

// ───────────────────────────────────────────────
// Integration: parse → format → coverage round-trip
// ───────────────────────────────────────────────

describe("integration: parse → format → coverage", () => {
  it("parseDiffHunks and formatNumberedHunks produce coherent output", () => {
    const hunks = parseDiffHunks(SIMPLE_DIFF);
    const text = formatNumberedHunks(hunks);

    // Each hunk should appear exactly once
    for (const h of hunks) {
      assert.ok(
        text.includes(`[H${h.globalIndex}]`),
        `Hunk ${h.globalIndex} missing from formatted output`,
      );
    }
  });

  it("hunk count matches coverage expectation", () => {
    const hunks = parseDiffHunks(SIMPLE_DIFF);
    assert.equal(hunks.length, 3);

    const groups = [
      defaultGroup([1, 2]),
      defaultGroup([3]),
    ];
    const validated = validateHunkCoverage(groups, hunks.length);
    assert.equal(validated.length, 2);
    // No catch-all needed
    assert.ok(validated.every((g) => g.confidence !== "low" || g.note));
  });
});

// ───────────────────────────────────────────────
// Prompt integration
// ───────────────────────────────────────────────

describe("buildIntentPrompt prompt integration", () => {
  it("includes conversation history section", () => {
    const turnLogText = "### Turn 1\n【依頼】add login\n【応答】added login\n【ファイル】a.ts";
    const numberedHunks = "[H1] src/auth/login.ts: add form";
    const prompt = buildIntentPrompt(turnLogText, numberedHunks, "en");

    assert.ok(prompt.includes("=== CONVERSATION HISTORY"));
    assert.ok(prompt.includes(turnLogText));
    assert.ok(prompt.includes("=== NUMBERED DIFF HUNKS"));
    assert.ok(prompt.includes(numberedHunks));
  });

  it("includes prompt marker when stored prompts are present", () => {
    const turnLogText =
      "### Turn 1\n【依頼】add login\n【応答】added login\n【プロンプト】System: sys | User: raw\n【ファイル】a.ts";
    const numberedHunks = "[H1] src/auth/login.ts: add form";
    const prompt = buildIntentPrompt(turnLogText, numberedHunks, "en");

    assert.ok(prompt.includes("【プロンプト】"), "should preserve prompt marker");
    assert.ok(prompt.includes("System: sys"), "should include system prompt");
    assert.ok(prompt.includes("User: raw"), "should include raw user prompt");
  });

  it("mentions original prompts in the conversation history header", () => {
    const prompt = buildIntentPrompt("turn log text", "hunks text", "en");
    assert.ok(
      prompt.includes("includes original system/user prompts when available"),
      "should note that original prompts may be included",
    );
  });
});
