import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GitOperations } from "./git-operations.js";

function makePi(result: ExecResult): ExtensionAPI {
  return {
    exec: async (command: string, args?: string[]) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["rev-parse", "HEAD"]);
      return result;
    },
  } as unknown as ExtensionAPI;
}

describe("GitOperations.getHead", () => {
  it("returns the trimmed HEAD SHA on success", async () => {
    const git = new GitOperations(
      makePi({ code: 0, stdout: "abc123def456\n", stderr: "", killed: false }),
    );
    const head = await git.getHead();
    assert.equal(head, "abc123def456");
  });

  it("returns null when git rev-parse fails", async () => {
    const git = new GitOperations(
      makePi({ code: 1, stdout: "", stderr: "fatal: not a git repository", killed: false }),
    );
    const head = await git.getHead();
    assert.equal(head, null);
  });

  it("returns null when stdout is empty", async () => {
    const git = new GitOperations(makePi({ code: 0, stdout: "", stderr: "", killed: false }));
    const head = await git.getHead();
    assert.equal(head, null);
  });
});
