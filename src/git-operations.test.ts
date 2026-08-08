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

describe("GitOperations.resetSoft", () => {
  it("does nothing when commitCount is 0", async () => {
    let called = false;
    const git = new GitOperations({
      exec: async () => {
        called = true;
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);
    await git.resetSoft(0);
    assert.equal(called, false, "should not call git when count is 0");
  });

  it("does nothing when commitCount is negative", async () => {
    let called = false;
    const git = new GitOperations({
      exec: async () => {
        called = true;
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);
    await git.resetSoft(-3);
    assert.equal(called, false, "should not call git when count is negative");
  });

  it("uses git reset --soft HEAD~N when HEAD~N exists", async () => {
    const calls: Array<{ args?: string[] }> = [];
    const git = new GitOperations({
      exec: async (_cmd: string, args?: string[]) => {
        calls.push({ args });
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);

    await git.resetSoft(3);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ["rev-parse", "--verify", "HEAD~3"]);
    assert.deepEqual(calls[1].args, ["reset", "--soft", "HEAD~3"]);
  });

  it("uses git update-ref -d HEAD when HEAD~N does not exist", async () => {
    const calls: Array<{ args?: string[] }> = [];
    const git = new GitOperations({
      exec: async (_cmd: string, args?: string[]) => {
        calls.push({ args });
        if (args?.[0] === "rev-parse") {
          return { code: 128, stdout: "", stderr: "fatal: ambiguous argument", killed: false };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);

    await git.resetSoft(5);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ["rev-parse", "--verify", "HEAD~5"]);
    assert.deepEqual(calls[1].args, ["update-ref", "-d", "HEAD"]);
  });

  it("throws on reset --soft failure even when HEAD~N exists", async () => {
    const git = new GitOperations({
      exec: async (_cmd: string, args?: string[]) => {
        if (args?.[0] === "rev-parse") {
          return { code: 0, stdout: "abc123", stderr: "", killed: false };
        }
        return { code: 1, stdout: "", stderr: "fatal: something went wrong", killed: false };
      },
    } as unknown as ExtensionAPI);

    await assert.rejects(
      () => git.resetSoft(2),
      /git reset --soft HEAD~2 failed/,
    );
  });

  it("throws on update-ref failure", async () => {
    const git = new GitOperations({
      exec: async (_cmd: string, args?: string[]) => {
        if (args?.[0] === "rev-parse") {
          return { code: 128, stdout: "", stderr: "fatal: ambiguous argument", killed: false };
        }
        return { code: 1, stdout: "", stderr: "fatal: could not update ref", killed: false };
      },
    } as unknown as ExtensionAPI);

    await assert.rejects(
      () => git.resetSoft(5),
      /git update-ref -d HEAD failed/,
    );
  });
});

describe("GitOperations.findCheckpointsSince", () => {
  const marker = "wip(checkpoint):";
  const output = [
    "deadbeef\u0000wip(checkpoint): auto-commit at turn 2\u0000session-2\u0000wt/task1",
    "cafebabe\u0000feat: regular commit\u0000\u0000",
    "12345678\u0000wip(checkpoint): auto-commit at turn 1\u0000session-1\u0000",
  ].join("\n");

  it("returns only marker-matching commits in the range", async () => {
    const git = new GitOperations({
      exec: async (_cmd: string, args?: string[]) => {
        assert.deepEqual(args, [
          "log",
          "--pretty=format:%H%x00%s%x00%(trailers:key=Checkpoint-Session,valueonly,separator=%x00)%x00%(trailers:key=Checkpoint-Branch,valueonly,separator=%x00)",
          "--no-decorate",
          "abc123..HEAD",
        ]);
        return { code: 0, stdout: output + "\n", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);

    const found = await git.findCheckpointsSince("abc123", marker);
    assert.equal(found.length, 2);
    assert.deepEqual(found[0], {
      sha: "deadbeef",
      subject: "wip(checkpoint): auto-commit at turn 2",
      session: "session-2",
      branch: "wt/task1",
    });
    assert.deepEqual(found[1], {
      sha: "12345678",
      subject: "wip(checkpoint): auto-commit at turn 1",
      session: "session-1",
      branch: null,
    });
  });

  it("returns [] when git fails", async () => {
    const git = new GitOperations({
      exec: async () => ({ code: 128, stdout: "", stderr: "fatal", killed: false }),
    } as unknown as ExtensionAPI);
    const found = await git.findCheckpointsSince("abc123", marker);
    assert.deepEqual(found, []);
  });

  it("treats missing trailers as null", async () => {
    const git = new GitOperations({
      exec: async () => ({
        code: 0,
        stdout: "deadbeef\u0000wip(checkpoint): turn\u0000\u0000\n",
        stderr: "",
        killed: false,
      }),
    } as unknown as ExtensionAPI);
    const found = await git.findCheckpointsSince("abc123", marker);
    assert.equal(found[0].session, null);
    assert.equal(found[0].branch, null);
  });
});

describe("GitOperations.getCurrentBranch", () => {
  it("returns the trimmed branch name", async () => {
    const git = new GitOperations({
      exec: async (_cmd: string, args?: string[]) => {
        assert.deepEqual(args, ["branch", "--show-current"]);
        return { code: 0, stdout: "wt/task1\n", stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI);
    assert.equal(await git.getCurrentBranch(), "wt/task1");
  });

  it("returns null on detached HEAD or failure", async () => {
    const git = new GitOperations({
      exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    } as unknown as ExtensionAPI);
    assert.equal(await git.getCurrentBranch(), null);

    const failing = new GitOperations({
      exec: async () => ({ code: 128, stdout: "", stderr: "fatal", killed: false }),
    } as unknown as ExtensionAPI);
    assert.equal(await failing.getCurrentBranch(), null);
  });
});
