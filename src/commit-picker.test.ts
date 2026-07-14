import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCommitItems,
  defaultRange,
  formatSubject,
  type CommitItem,
  type CommitPicker,
  type PickerResult,
} from "./commit-picker.js";

// ── buildCommitItems ─────────────────────────────────────

describe("buildCommitItems", () => {
  it("parses git log output into CommitItems", () => {
    const raw = [
      "abc123\0wip(checkpoint): turn 3",
      "def456\0feat: implement X",
      "789012\0wip(checkpoint): turn 2",
    ].join("\n");

    const items = buildCommitItems(raw);
    assert.equal(items.length, 3);
    assert.equal(items[0].sha, "abc123");
    assert.equal(items[0].subject, "wip(checkpoint): turn 3");
    assert.equal(items[0].isCheckpoint, true);
    assert.equal(items[1].sha, "def456");
    assert.equal(items[1].subject, "feat: implement X");
    assert.equal(items[1].isCheckpoint, false);
    assert.equal(items[2].sha, "789012");
    assert.equal(items[2].subject, "wip(checkpoint): turn 2");
    assert.equal(items[2].isCheckpoint, true);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(buildCommitItems(""), []);
    assert.deepEqual(buildCommitItems("  "), []);
  });

  it("skips lines missing sha or subject", () => {
    const raw = ["abc123\0valid", "invalid-no-null", "\0subject-only"].join("\n");
    const items = buildCommitItems(raw);
    assert.equal(items.length, 1);
    assert.equal(items[0].sha, "abc123");
  });
});

// ── defaultRange ──────────────────────────────────────────

describe("defaultRange", () => {
  it("sets [1] at HEAD and [2] at last checkpoint", () => {
    const items: CommitItem[] = [
      { sha: "a", subject: "wip(checkpoint): turn 3", isCheckpoint: true },
      { sha: "b", subject: "wip(checkpoint): turn 2", isCheckpoint: true },
      { sha: "c", subject: "feat: X", isCheckpoint: false },
    ];

    const { startIndex, endIndex } = defaultRange(items);
    assert.equal(startIndex, 0); // HEAD
    assert.equal(endIndex, 1); // last checkpoint at index 1
  });

  it("falls back to both at HEAD when no checkpoints exist", () => {
    const items: CommitItem[] = [
      { sha: "a", subject: "feat: X", isCheckpoint: false },
      { sha: "b", subject: "fix: Y", isCheckpoint: false },
    ];

    const { startIndex, endIndex } = defaultRange(items);
    assert.equal(startIndex, 0);
    assert.equal(endIndex, 0);
  });

  it("handles single checkpoint at HEAD", () => {
    const items: CommitItem[] = [
      { sha: "a", subject: "wip(checkpoint): turn 1", isCheckpoint: true },
    ];

    const { startIndex, endIndex } = defaultRange(items);
    assert.equal(startIndex, 0);
    assert.equal(endIndex, 0);
  });
});

// ── formatSubject ─────────────────────────────────────────

describe("formatSubject", () => {
  it("strips checkpoint prefix with trailing text", () => {
    assert.equal(
      formatSubject("wip(checkpoint): turn 3"),
      "wip(checkpoint) turn 3",
    );
  });

  it("strips checkpoint prefix with no trailing text", () => {
    assert.equal(formatSubject("wip(checkpoint):"), "wip(checkpoint)");
    assert.equal(formatSubject("wip(checkpoint): "), "wip(checkpoint)");
  });

  it("leaves non-checkpoint subjects unchanged", () => {
    assert.equal(formatSubject("feat: implement X"), "feat: implement X");
    assert.equal(formatSubject("fix: correct Y"), "fix: correct Y");
  });
});

// ── CommitPicker (unit, no DOM) ───────────────────────────

/**
 * A minimal theme stub so CommitPicker.render() does not crash.
 */
const stubTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
};

describe("CommitPicker", () => {
  it("initialises with given items and default markers", async () => {
    // Dynamic import to get the class.
    const mod = await import("./commit-picker.js");
    const { CommitPicker: CP } = mod as typeof mod & {
      CommitPicker: new (
        items: CommitItem[],
        defaultStart: number,
        defaultEnd: number,
        theme: typeof stubTheme,
        maxVisible?: number,
      ) => CommitPicker & {
        onConfirm?: (result: PickerResult) => void;
        onCancel?: () => void;
      };
    };

    const items: CommitItem[] = [
      { sha: "a", subject: "wip(checkpoint): turn 2", isCheckpoint: true },
      { sha: "b", subject: "wip(checkpoint): turn 1", isCheckpoint: true },
      { sha: "c", subject: "feat: X", isCheckpoint: false },
    ];

    const picker = new CP(items, 0, 1, stubTheme);
    assert.ok(picker);

    // Render should not throw.
    const lines = picker.render(60);
    assert.ok(lines.length > 0);

    // Should render all visible lines.
    const rendered = lines.join("\n");
    assert.ok(rendered.includes("▸ [2]")); // cursor at end marker
    assert.ok(rendered.includes("[1]")); // start marker

    picker.onCancel = () => {};
    picker.onConfirm = () => {};
  });
});
