/**
 * Tests for batch-committer helpers.
 *
 * Run: node --import tsx --test src/core/batch-committer.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractDiffSnippetForGroup, verifyConfidence } from "./batch-committer.js";
import type { CommitGroup, DiffHunk } from "../types.js";

function makeDiffHunk(overrides: Partial<DiffHunk> & { globalIndex: number; file: string }): DiffHunk {
  return {
    globalIndex: overrides.globalIndex,
    file: overrides.file,
    hunkIndexInFile: overrides.hunkIndexInFile ?? 0,
    header: overrides.header ?? "@@ -1,1 +1,1 @@",
    content: overrides.content ?? "+change",
    summary: overrides.summary ?? "summary",
    isNewFile: overrides.isNewFile ?? false,
    isDeletedFile: overrides.isDeletedFile ?? false,
    isAtomic: overrides.isAtomic ?? false,
    fileHeader: overrides.fileHeader ?? [
      `diff --git a/${overrides.file} b/${overrides.file}`,
      "--- a/old",
      "+++ b/new",
    ],
  };
}

function makeGroup(hunks: { globalIndex: number; file: string }[], message = "test: message"): CommitGroup {
  return {
    hunks: hunks.map((h) => ({ globalIndex: h.globalIndex, file: h.file })),
    message,
    confidence: "high",
  };
}

// ───────────────────────────────────────────────
// extractDiffSnippetForGroup
// ───────────────────────────────────────────────

describe("extractDiffSnippetForGroup", () => {
  it("joins file headers and hunk contents for grouped hunks", () => {
    const diffHunks: DiffHunk[] = [
      makeDiffHunk({
        globalIndex: 1,
        file: "src/a.ts",
        content: "@@ -1,1 +1,2 @@\n context\n+added a",
        fileHeader: ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts"],
      }),
      makeDiffHunk({
        globalIndex: 2,
        file: "src/b.ts",
        content: "@@ -3,1 +3,2 @@\n context\n+added b",
        fileHeader: ["diff --git a/src/b.ts b/src/b.ts", "--- a/src/b.ts", "+++ b/src/b.ts"],
      }),
    ];
    const group = makeGroup([
      { globalIndex: 1, file: "src/a.ts" },
      { globalIndex: 2, file: "src/b.ts" },
    ]);

    const snippet = extractDiffSnippetForGroup(group, diffHunks);

    assert.ok(snippet.includes("diff --git a/src/a.ts"));
    assert.ok(snippet.includes("diff --git a/src/b.ts"));
    assert.ok(snippet.includes("+added a"));
    assert.ok(snippet.includes("+added b"));
  });

  it("does not duplicate file headers for multiple hunks in the same file", () => {
    const diffHunks: DiffHunk[] = [
      makeDiffHunk({
        globalIndex: 1,
        file: "src/a.ts",
        hunkIndexInFile: 0,
        content: "@@ -1,1 +1,2 @@\n+first",
        fileHeader: ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts"],
      }),
      makeDiffHunk({
        globalIndex: 2,
        file: "src/a.ts",
        hunkIndexInFile: 1,
        content: "@@ -10,1 +10,2 @@\n+second",
        fileHeader: ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts"],
      }),
    ];
    const group = makeGroup([
      { globalIndex: 1, file: "src/a.ts" },
      { globalIndex: 2, file: "src/a.ts" },
    ]);

    const snippet = extractDiffSnippetForGroup(group, diffHunks);
    const matches = snippet.match(/diff --git a\/src\/a\.ts/g);

    assert.equal(matches?.length, 1, "file header should appear exactly once");
    assert.ok(snippet.includes("+first"));
    assert.ok(snippet.includes("+second"));
  });

  it("uses full atomic file content without extra header", () => {
    const diffHunks: DiffHunk[] = [
      {
        globalIndex: 1,
        file: "bin/asset.png",
        hunkIndexInFile: 0,
        header: "diff --git a/bin/asset.png b/bin/asset.png",
        content: "diff --git a/bin/asset.png b/bin/asset.png\nGIT binary patch\nliteral 12345\n...",
        summary: "(binary/mode/rename)",
        isNewFile: false,
        isDeletedFile: false,
        isAtomic: true,
        fileHeader: ["diff --git a/bin/asset.png b/bin/asset.png"],
      },
    ];
    const group = makeGroup([{ globalIndex: 1, file: "bin/asset.png" }]);

    const snippet = extractDiffSnippetForGroup(group, diffHunks);

    assert.ok(snippet.includes("GIT binary patch"));
    assert.equal(snippet.match(/diff --git a\/bin\/asset\.png/g)?.length, 1);
  });

  it("truncates oversized snippets at a line boundary", () => {
    const longLine = "+".repeat(1000);
    const diffHunks: DiffHunk[] = [
      makeDiffHunk({
        globalIndex: 1,
        file: "src/a.ts",
        content: `@@ -1,1 +1,2 @@\n${longLine}`,
      }),
    ];
    const group = makeGroup([{ globalIndex: 1, file: "src/a.ts" }]);

    const snippet = extractDiffSnippetForGroup(group, diffHunks, 500);

    assert.ok(snippet.length <= 600);
    assert.ok(snippet.endsWith("... (truncated)"));
  });

  it("ignores hunk refs that are not present in diffHunks", () => {
    const diffHunks: DiffHunk[] = [
      makeDiffHunk({ globalIndex: 1, file: "src/a.ts", content: "@@ -1,1 +1,2 @@\n+ok" }),
    ];
    const group = makeGroup([
      { globalIndex: 1, file: "src/a.ts" },
      { globalIndex: 999, file: "missing.ts" },
    ]);

    const snippet = extractDiffSnippetForGroup(group, diffHunks);

    assert.ok(snippet.includes("+ok"));
    assert.ok(!snippet.includes("missing.ts"));
  });
});

// ───────────────────────────────────────────────
// verifyConfidence
// ───────────────────────────────────────────────

function makeGroupWithConfidence(
  hunks: number[],
  confidence: "high" | "medium" | "low",
  message?: string,
  note?: string,
): CommitGroup {
  return {
    hunks: hunks.map((i) => ({ globalIndex: i, file: "src/f.ts" })),
    message: message ?? "test: message",
    confidence,
    note,
  };
}

describe("verifyConfidence", () => {
  it("downgrades high to medium when >30% of hunks are low confidence", () => {
    const result = verifyConfidence(
      {
        overallConfidence: "high",
        groups: [
          makeGroupWithConfidence([1, 2], "high"),
          makeGroupWithConfidence([3], "low"),
        ],
      },
      3,
    );

    assert.equal(result.overallConfidence, "medium");
  });

  it("downgrades to low when >50% of hunks are low confidence", () => {
    const result = verifyConfidence(
      {
        overallConfidence: "high",
        groups: [
          makeGroupWithConfidence([1], "high"),
          makeGroupWithConfidence([2, 3], "low"),
        ],
      },
      3,
    );

    assert.equal(result.overallConfidence, "low");
  });

  it("caps high confidence at medium when a catch-all group is present (Japanese note)", () => {
    const result = verifyConfidence(
      {
        overallConfidence: "high",
        groups: [
          makeGroupWithConfidence([1], "high"),
          makeGroupWithConfidence([2], "low", "chore: apply other changes", "AIがグループ化できなかったhunkの自動回収"),
        ],
      },
      2,
    );

    assert.equal(result.overallConfidence, "medium");
  });

  it("caps high confidence at medium when a catch-all message is present", () => {
    const result = verifyConfidence(
      {
        overallConfidence: "high",
        groups: [
          makeGroupWithConfidence([1], "high"),
          makeGroupWithConfidence([2], "low", "chore: apply other changes"),
        ],
      },
      2,
      "en",
    );

    assert.equal(result.overallConfidence, "medium");
  });

  it("does not raise confidence when catch-all is present", () => {
    const result = verifyConfidence(
      {
        overallConfidence: "low",
        groups: [
          makeGroupWithConfidence([1], "high"),
          makeGroupWithConfidence([2], "low", "chore: apply other changes", "AIがグループ化できなかったhunkの自動回収"),
        ],
      },
      2,
    );

    assert.equal(result.overallConfidence, "low");
  });

  it("returns unchanged result when totalHunks is 0", () => {
    const result = verifyConfidence(
      {
        overallConfidence: "high",
        groups: [],
      },
      0,
    );

    assert.equal(result.overallConfidence, "high");
  });
});
