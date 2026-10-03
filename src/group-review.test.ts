import assert from "node:assert";
import { describe, it } from "node:test";
import type { CommitGroup } from "./commit-prompt.js";
import { formatGroupPreview, reviewCommitGroups } from "./group-review.js";

const group = (message: string, files: string[]): CommitGroup => ({
  message,
  files,
});

interface UiCalls {
  confirm: string[];
  editor: string[];
  working: boolean[];
}

/** Minimal ctx stub driving the confirm/editor dialogs from a queue. */
function makeCtx(
  mode: string,
  confirmAnswers: boolean[],
  editorAnswers: (string | undefined)[],
): [never, UiCalls] {
  const calls: UiCalls = { confirm: [], editor: [], working: [] };
  const ctx = {
    mode,
    ui: {
      confirm: async (title: string) => {
        calls.confirm.push(title);
        return confirmAnswers.shift() ?? true;
      },
      editor: async (title: string) => {
        calls.editor.push(title);
        return editorAnswers.shift();
      },
      setWorkingVisible: (visible: boolean) => calls.working.push(visible),
    },
  };
  return [ctx as never, calls];
}

void describe("formatGroupPreview", () => {
  void it("shows the message and its files", () => {
    const preview = formatGroupPreview(group("feat(a): x", ["a.ts", "b.ts"]));
    assert.ok(preview.startsWith("feat(a): x"));
    assert.ok(preview.includes("  a.ts"));
    assert.ok(preview.includes("  b.ts"));
    assert.ok(!preview.includes("他"));
  });

  void it("summarises a file list longer than the preview limit", () => {
    const files = Array.from({ length: 11 }, (_, i) => `f${i}.ts`);
    const preview = formatGroupPreview(group("feat(a): x", files));
    assert.ok(preview.includes("f7.ts"));
    assert.ok(!preview.includes("f8.ts"));
    assert.ok(preview.includes("…他 3 ファイル"));
  });
});

void describe("reviewCommitGroups", () => {
  const groups = [group("feat(a): x", ["a.ts"]), group("test(a): y", ["b.ts"])];

  void it("returns the groups untouched in non-TUI mode", async () => {
    const [ctx, calls] = makeCtx("rpc", [], []);
    assert.deepStrictEqual(await reviewCommitGroups(ctx, groups), groups);
    assert.deepStrictEqual(calls.confirm, []);
  });

  void it("keeps every group when all are confirmed", async () => {
    const [ctx, calls] = makeCtx("tui", [true, true], []);
    assert.deepStrictEqual(await reviewCommitGroups(ctx, groups), groups);
    assert.strictEqual(calls.confirm.length, 2);
    assert.deepStrictEqual(calls.editor, []);
    assert.deepStrictEqual(calls.working, [false, true]);
  });

  void it("replaces the message when the editor returns one", async () => {
    const [ctx, calls] = makeCtx("tui", [false, true], ["fix(a): rewritten\n"]);
    const reviewed = await reviewCommitGroups(ctx, groups);
    assert.strictEqual(reviewed?.[0].message, "fix(a): rewritten");
    assert.deepStrictEqual(reviewed?.[0].files, ["a.ts"]);
    assert.strictEqual(reviewed?.[1].message, "test(a): y");
    assert.strictEqual(calls.editor.length, 1);
  });

  void it("aborts when the editor is cancelled", async () => {
    const [ctx] = makeCtx("tui", [false], [undefined]);
    assert.strictEqual(await reviewCommitGroups(ctx, groups), null);
  });

  void it("aborts when the editor returns an empty message", async () => {
    const [ctx] = makeCtx("tui", [false], ["   "]);
    assert.strictEqual(await reviewCommitGroups(ctx, groups), null);
  });
});
