import assert from "node:assert";
import { describe, it } from "node:test";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { PiAutocommitConfig } from "./config.js";
import {
  organizeWipCommits,
  WIP_COMMIT_MARKER,
} from "./commit-organizer.js";
import {
  completeCommitGroups,
  type CompleteFn,
} from "./commit-prompt.js";
import type { CommitStore } from "./commit-store.js";

/** Minimal model stub for fake adapters. */
const stubModel = { id: "test-model" } as unknown as Parameters<CompleteFn>[0];

function fakeCompleteReturning(text: string): CompleteFn {
  return async () =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
    }) as never;
}

function makeCtx(model: unknown) {
  return {
    model,
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    },
  } as never;
}

function config(over: Partial<PiAutocommitConfig> = {}): PiAutocommitConfig {
  return { lang: "en", enable: true, ...over };
}

void describe("completeCommitGroups parsing", () => {
  void it("returns an empty array when the LLM returns empty groups", async () => {
    const complete = fakeCompleteReturning("");
    await assert.rejects(
      completeCommitGroups(
        makeCtx(stubModel),
        config(),
        { diff: "diff", reasoning: "" },
        complete,
      ),
      /Empty reorganiser response/,
    );
  });

  void it("parses a single commit group", async () => {
    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login

Implement login with JWT.
=== FILES ===
src/auth/login.ts
src/auth/types.ts
=== END ===
`.trim();
    const complete = fakeCompleteReturning(input);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      config(),
      { diff: "diff", reasoning: "" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat(auth): add JWT login\n\nImplement login with JWT.",
        files: ["src/auth/login.ts", "src/auth/types.ts"],
      },
    ]);
  });

  void it("parses multiple commit groups", async () => {
    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login

Implement login.
=== FILES ===
src/auth/login.ts
=== END ===
=== COMMIT 2 ===
refactor(db): extract query builder

Move query logic.
=== FILES ===
src/db/query.ts
=== END ===
`.trim();
    const complete = fakeCompleteReturning(input);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      config(),
      { diff: "diff", reasoning: "" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat(auth): add JWT login\n\nImplement login.",
        files: ["src/auth/login.ts"],
      },
      {
        message: "refactor(db): extract query builder\n\nMove query logic.",
        files: ["src/db/query.ts"],
      },
    ]);
  });

  void it("ignores blocks without a files section", async () => {
    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
src/auth/login.ts
=== END ===
=== COMMIT 2 ===
invalid commit without files
=== END ===
`.trim();
    const complete = fakeCompleteReturning(input);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      config(),
      { diff: "diff", reasoning: "" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat(auth): add JWT login",
        files: ["src/auth/login.ts"],
      },
    ]);
  });

  void it("ignores empty file lines and comments", async () => {
    const input = `
=== COMMIT 1 ===
chore(deps): update lockfile
=== FILES ===

# this is a comment
package-lock.json

=== END ===
`.trim();
    const complete = fakeCompleteReturning(input);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      config(),
      { diff: "diff", reasoning: "" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "chore(deps): update lockfile",
        files: ["package-lock.json"],
      },
    ]);
  });
});

/**
 * In-memory CommitStore for testing the reorganiser policy without a real git
 * repository. Tracks staged files and committed messages so tests can assert
 * on the sequence of operations and the final state.
 */
class InMemoryCommitStore implements CommitStore {
  public commits: string[] = [];
  public stagedFiles: string[] = [];
  public operations: string[] = [];

  constructor(
    private readonly options: {
      insideRepo?: boolean;
      wipCommits?: Array<{ message: string; files: string[] }>;
    } = {},
  ) {}

  async isInsideGitRepo(): Promise<boolean> {
    this.operations.push("isInsideGitRepo");
    return this.options.insideRepo ?? true;
  }

  async countWipCommits(marker: string): Promise<number> {
    this.operations.push(`countWipCommits:${marker}`);
    const wip = this.options.wipCommits ?? [];
    let count = 0;
    for (const commit of wip) {
      if (commit.message.startsWith(marker)) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  async checkUncommittedChanges(): Promise<boolean> {
    this.operations.push("checkUncommittedChanges");
    return this.stagedFiles.length > 0;
  }

  async resetSoft(commitCount: number): Promise<void> {
    this.operations.push(`resetSoft:${commitCount}`);
    const wip = this.options.wipCommits ?? [];
    const removed = wip.splice(0, commitCount);
    for (const commit of removed) {
      for (const file of commit.files) {
        if (!this.stagedFiles.includes(file)) {
          this.stagedFiles.push(file);
        }
      }
    }
  }

  async getStagedMaterials(): Promise<{
    diff: string;
    nameStatus: string;
    stat: string;
  }> {
    this.operations.push("getStagedMaterials");
    const nameStatus = this.stagedFiles
      .map((file) => `M\t${file}`)
      .join("\n");
    return {
      diff: this.stagedFiles.map((file) => `diff --git a/${file} b/${file}`).join("\n"),
      nameStatus,
      stat: this.stagedFiles.map((file) => `${file} | 1 +`).join("\n"),
    };
  }

  async unstageAll(): Promise<void> {
    this.operations.push("unstageAll");
    this.stagedFiles = [];
  }

  async stageFiles(files: string[]): Promise<void> {
    this.operations.push(`stageFiles:${files.join(",")}`);
    this.stagedFiles = [...files];
  }

  async stageAll(): Promise<void> {
    this.operations.push("stageAll");
  }

  async commit(message: string): Promise<ExecResult> {
    this.operations.push(`commit:${message.split("\n")[0]}`);
    this.commits.push(message);
    this.stagedFiles = [];
    return { code: 0, stdout: "", stderr: "", killed: false };
  }
}

function makeEvent(): AgentEndEvent {
  return { messages: [] } as unknown as AgentEndEvent;
}

void describe("organizeWipCommits", () => {
  void it("returns no-op when not inside a git repo", async () => {
    const store = new InMemoryCommitStore({ insideRepo: false });

    const result = await organizeWipCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(""),
    );

    assert.strictEqual(result.organised, false);
    assert.deepStrictEqual(store.operations, ["isInsideGitRepo"]);
  });

  void it("returns no-op when there are no WIP commits", async () => {
    const store = new InMemoryCommitStore({ wipCommits: [] });

    const result = await organizeWipCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(""),
    );

    assert.strictEqual(result.organised, false);
    assert.strictEqual(
      result.events.some((e) => e.type === "stage-changed" && !e.hasChanges),
      true,
    );
    assert.deepStrictEqual(store.operations, [
      "isInsideGitRepo",
      `countWipCommits:${WIP_COMMIT_MARKER}`,
      "checkUncommittedChanges",
    ]);
  });

  void it("reorganises a single WIP commit into one logical group", async () => {
    const store = new InMemoryCommitStore({
      wipCommits: [
        {
          message: `${WIP_COMMIT_MARKER} turn 1`,
          files: ["src/auth/login.ts", "src/auth/types.ts"],
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login

Implement login with JWT.
=== FILES ===
src/auth/login.ts
src/auth/types.ts
=== END ===
`.trim();

    const result = await organizeWipCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(
      result.events.some(
        (e) =>
          e.type === "organised" &&
          e.checkpointCount === 1 &&
          e.commitCount === 1,
      ),
      true,
    );
    assert.strictEqual(store.commits.length, 1);
    assert.ok(store.commits[0]?.startsWith("feat(auth):"));
    assert.deepStrictEqual(store.stagedFiles, []);
  });

  void it("reorganises multiple WIP commits into multiple logical groups", async () => {
    const store = new InMemoryCommitStore({
      wipCommits: [
        { message: `${WIP_COMMIT_MARKER} turn 2`, files: ["src/db/query.ts"] },
        { message: `${WIP_COMMIT_MARKER} turn 1`, files: ["src/auth/login.ts"] },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
src/auth/login.ts
=== END ===
=== COMMIT 2 ===
refactor(db): extract query builder
=== FILES ===
src/db/query.ts
=== END ===
`.trim();

    const result = await organizeWipCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(
      result.events.some(
        (e) =>
          e.type === "organised" &&
          e.checkpointCount === 2 &&
          e.commitCount === 2,
      ),
      true,
    );
    assert.strictEqual(store.commits.length, 2);
    assert.ok(store.commits[0]?.startsWith("feat(auth):"));
    assert.ok(store.commits[1]?.startsWith("refactor(db):"));
  });

  void it("falls back to a single commit when group proposition fails", async () => {
    const store = new InMemoryCommitStore({
      wipCommits: [
        {
          message: `${WIP_COMMIT_MARKER} turn 1`,
          files: ["src/auth/login.ts"],
        },
      ],
    });

    // Empty LLM response makes completeCommitGroups throw, triggering the
    // catch-block fallback path.
    const emptyComplete: CompleteFn = async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "" }],
      }) as never;

    const result = await organizeWipCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      emptyComplete,
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(
      result.events.some((e) => e.type === "fallback"),
      true,
    );
    assert.strictEqual(store.commits.length, 1);
    assert.ok(store.operations.includes("stageAll"));
  });

  void it("stages each group independently and leaves the index clean", async () => {
    const store = new InMemoryCommitStore({
      wipCommits: [
        {
          message: `${WIP_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts", "src/b.ts"],
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat(a): change a
=== FILES ===
src/a.ts
=== END ===
=== COMMIT 2 ===
feat(b): change b
=== FILES ===
src/b.ts
=== END ===
`.trim();

    await organizeWipCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
    );

    const stageOps = store.operations.filter((op) => op.startsWith("stageFiles"));
    assert.deepStrictEqual(stageOps, [
      "stageFiles:src/a.ts",
      "stageFiles:src/b.ts",
    ]);
    assert.deepStrictEqual(store.stagedFiles, []);
  });
});