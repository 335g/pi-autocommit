import assert from "node:assert";
import { describe, it } from "node:test";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { PiAutocommitConfig } from "./config.js";
import {
  organizeCheckpointCommits,
  reorganiseCheckpointsManual,
  CHECKPOINT_COMMIT_MARKER,
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
  return { lang: "en", enable: true, commitPickerMaxCommits: 30, ...over };
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

// ── In-memory CommitStore for tests ────────────────────────

/**
 * Description of one checkpoint commit in the in-memory store.
 *
 * `session` may be set to simulate the `Checkpoint-Session` trailer.
 */
interface CheckpointCommit {
  message: string;
  files: string[];
  session?: string | null;
}

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
      /** Ordered from HEAD (index 0) backward. */
      checkpointCommits?: CheckpointCommit[];
      /**
       * File paths that are considered "already committed" — staging them
       * produces no staged changes (simulates duplicate files across groups).
       */
      alreadyCommitted?: string[];
      /**
       * Override the default commit return value. When set, every call to
       * `commit()` returns this instead of the default success response.
       */
      commitResult?: ExecResult;
    } = {},
  ) {
    // Normalise session to null when absent.
    for (const w of this.options.checkpointCommits ?? []) {
      if (w.session === undefined) w.session = null;
    }
  }

  async isInsideGitRepo(): Promise<boolean> {
    this.operations.push("isInsideGitRepo");
    return this.options.insideRepo ?? true;
  }

  async countCheckpointCommits(marker: string, sessionId?: string): Promise<number> {
    this.operations.push(
      `countCheckpointCommits:${marker}${sessionId !== undefined ? `:${sessionId}` : ""}`,
    );
    const commits = this.options.checkpointCommits ?? [];
    let count = 0;
    for (const commit of commits) {
      if (!commit.message.startsWith(marker)) break;
      if (sessionId !== undefined) {
        if (commit.session === sessionId) {
          count++;
        } else {
          break; // Non-matching session stops the scan.
        }
      } else {
        count++;
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
    const commits = this.options.checkpointCommits ?? [];
    const removed = commits.splice(0, commitCount);
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
      diff: this.stagedFiles
        .map((file) => `diff --git a/${file} b/${file}`)
        .join("\n"),
      nameStatus,
      stat: this.stagedFiles.map((file) => `${file} | 1 +`).join("\n"),
    };
  }

  async unstageAll(): Promise<void> {
    this.operations.push("unstageAll");
    this.stagedFiles = [];
  }

  async hasStagedChanges(): Promise<boolean> {
    this.operations.push("hasStagedChanges");
    return this.stagedFiles.length > 0;
  }

  async stageFiles(files: string[]): Promise<void> {
    this.operations.push(`stageFiles:${files.join(",")}`);
    const committed = this.options.alreadyCommitted ?? [];
    this.stagedFiles = files.filter((f) => !committed.includes(f));
  }

  async stageAll(): Promise<void> {
    this.operations.push("stageAll");
  }

  async commit(message: string): Promise<ExecResult> {
    this.operations.push(`commit:${message.split("\n")[0]}`);
    this.commits.push(message);
    this.stagedFiles = [];
    return this.options.commitResult ?? { code: 0, stdout: "", stderr: "", killed: false };
  }

  async getRecentCommits(maxCount: number): Promise<string> {
    this.operations.push(`getRecentCommits:${maxCount}`);
    const commits = this.options.checkpointCommits ?? [];
    return commits
      .slice(0, maxCount)
      .map((c, i) => `sha-${i}\0${c.message}`)
      .join("\n");
  }

  async findReachableCheckpoints(
    marker: string,
  ): Promise<
    Array<{ sha: string; subject: string; session: string | null }>
  > {
    this.operations.push(`findReachableCheckpoints:${marker}`);
    const commits = this.options.checkpointCommits ?? [];
    return commits.map((c, i) => ({
      sha: `sha-${i}`,
      subject: c.message,
      session: c.session ?? null,
    }));
  }

  async applyCommitDiffToIndex(
    sha: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.operations.push(`applyCommitDiffToIndex:${sha}`);
    const [, indexStr] = sha.split("-");
    const index = parseInt(indexStr, 10);
    const commit = this.options.checkpointCommits?.[index];
    if (commit) {
      for (const file of commit.files) {
        if (!this.stagedFiles.includes(file)) {
          this.stagedFiles.push(file);
        }
      }
    }
    return { success: true };
  }
}

function makeEvent(): AgentEndEvent {
  return { messages: [] } as unknown as AgentEndEvent;
}

// ── organizeCheckpointCommits (agent_end) ─────────────────────────

void describe("organizeCheckpointCommits", () => {
  void it("returns no-op when not inside a git repo", async () => {
    const store = new InMemoryCommitStore({ insideRepo: false });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(""),
    );

    assert.strictEqual(result.organised, false);
    assert.deepStrictEqual(store.operations, ["isInsideGitRepo"]);
  });

  void it("returns no-op when there are no checkpoint commits", async () => {
    const store = new InMemoryCommitStore({ checkpointCommits: [] });

    const result = await organizeCheckpointCommits(
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
      `countCheckpointCommits:${CHECKPOINT_COMMIT_MARKER}`,
      "checkUncommittedChanges",
    ]);
  });

  void it("reorganises a single checkpoint commit into one logical group", async () => {
    const store = new InMemoryCommitStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
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

    const result = await organizeCheckpointCommits(
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

  void it("reorganises multiple checkpoint commits into multiple logical groups", async () => {
    const store = new InMemoryCommitStore({
      checkpointCommits: [
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 2`, files: ["src/db/query.ts"] },
        { message: `${CHECKPOINT_COMMIT_MARKER} turn 1`, files: ["src/auth/login.ts"] },
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

    const result = await organizeCheckpointCommits(
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
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/auth/login.ts"],
        },
      ],
    });

    const emptyComplete: CompleteFn = async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "" }],
      }) as never;

    const result = await organizeCheckpointCommits(
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
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
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

    await organizeCheckpointCommits(
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

  void it("includes stdout in error message when stderr is empty", async () => {
    const store = new InMemoryCommitStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts"],
        },
      ],
      // commit fails with code 1, empty stderr, but stdout has the actual message.
      commitResult: { code: 1, stdout: "nothing to commit, working tree clean", stderr: "", killed: false },
    });

    const input = `
=== COMMIT 1 ===
feat(a): change a
=== FILES ===
src/a.ts
=== END ===
`.trim();

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
    );

    // Both the group commit and the fallback commit fail, so reorganisation
    // itself fails — but the error message should contain stdout content
    // rather than "Unknown error".
    assert.strictEqual(result.organised, false);
    const errorEvent = result.events.find((e) => e.type === "error");
    assert.ok(errorEvent, "Expected an error event");
    assert.ok(
      errorEvent.message.includes("nothing to commit, working tree clean"),
      `Error message should include stdout content, got: ${errorEvent.message}`,
    );
    assert.ok(
      !errorEvent.message.includes("Unknown error"),
      "Error message should not contain 'Unknown error'",
    );
  });

  void it("skips empty commit groups during reorganisation", async () => {
    const store = new InMemoryCommitStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts", "src/b.ts"],
        },
      ],
      // "src/a.ts" is already committed — staging it produces no changes.
      alreadyCommitted: ["src/a.ts"],
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

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
    );

    assert.strictEqual(result.organised, true);

    // Info event about the skipped group.
    const infoEvent = result.events.find(
      (e) => e.type === "info" && e.message.startsWith("Skipped empty commit group"),
    );
    assert.ok(infoEvent, "Expected an info event about skipped empty commit group");

    // Only the second group was committed.
    assert.strictEqual(store.commits.length, 1);
    assert.ok(store.commits[0]?.startsWith("feat(b):"));

    // commitCount reflects actual commits (1), not groups.length (2).
    const organisedEvent = result.events.find((e) => e.type === "organised");
    assert.ok(organisedEvent, "Expected an organised event");
    assert.strictEqual(organisedEvent.commitCount, 1);

    // And we verified hasStagedChanges was called.
    assert.ok(store.operations.includes("hasStagedChanges"));
  });

  // ── Session-aware agent_end tests ────────────────────────

  void it("with targetSessionId: reorganises only matching consecutive checkpoints", async () => {
    const store = new InMemoryCommitStore({
      checkpointCommits: [
        // HEAD: turns are added in order, newest first.
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/db/query.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/auth/login.ts"],
          session: "session-a",
        },
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

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
      "session-a",
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
  });

  void it("with targetSessionId: stops at foreign session checkpoint", async () => {
    const store = new InMemoryCommitStore({
      checkpointCommits: [
        // HEAD: this session's checkpoint on top.
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 3`,
          files: ["src/own.ts"],
          session: "session-a",
        },
        // But the next one belongs to another session → stop.
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/foreign.ts"],
          session: "session-b",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/own-old.ts"],
          session: "session-a",
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat(own): own change
=== FILES ===
src/own.ts
=== END ===
`.trim();

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(input),
      "session-a",
    );

    // Only 1 commit reorganised (the top session-a commit).
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
  });

  void it("with targetSessionId: returns no-op when no matching checkpoints at HEAD", async () => {
    const store = new InMemoryCommitStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} foreign`,
          files: ["src/x.ts"],
          session: "session-b",
        },
      ],
    });

    const result = await organizeCheckpointCommits(
      makeCtx(stubModel),
      config(),
      makeEvent(),
      store,
      fakeCompleteReturning(""),
      "session-a",
    );

    assert.strictEqual(result.organised, false);
    // marker ends with `:`, sep is `:`, so double-colon is expected.
    assert.ok(
      store.operations.includes("countCheckpointCommits:wip(checkpoint)::session-a"),
    );
  });

  void it("backward-compat: no targetSessionId counts all consecutive checkpoints", async () => {
    const store = new InMemoryCommitStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/b.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts"],
          session: "session-b",
        },
      ],
    });

    // Without targetSessionId, both are counted regardless of trailer.
    const input = `
=== COMMIT 1 ===
feat(b): b
=== FILES ===
src/b.ts
=== END ===
`.trim();

    // Only 1 commit groups proposed for 2 consecutive checkpoints.
    const result = await organizeCheckpointCommits(
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
          e.commitCount === 1,
      ),
      true,
    );
  });
});

// ── reorganiseCheckpointsManual ───────────────────────────────────

void describe("reorganiseCheckpointsManual", () => {
  void it("returns no-op when not inside a git repo", async () => {
    const store = new InMemoryCommitStore({ insideRepo: false });

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
    );

    assert.strictEqual(result.organised, false);
    assert.deepStrictEqual(store.operations, ["isInsideGitRepo"]);
  });

  void it("returns no-op when there are no checkpoint commits", async () => {
    const store = new InMemoryCommitStore({ checkpointCommits: [] });

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
    );

    assert.strictEqual(result.organised, false);
    assert.ok(
      store.operations.includes("findReachableCheckpoints:wip(checkpoint):"),
    );
  });

  void it("no targetSessionId: reorganises all consecutive checkpoints", async () => {
    const store = new InMemoryCommitStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/b.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts"],
          session: "session-a",
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat(a+b): combined
=== FILES ===
src/a.ts
src/b.ts
=== END ===
`.trim();

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
      undefined,
      fakeCompleteReturning(input),
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(store.commits.length, 1);
    assert.ok(store.operations.includes("countCheckpointCommits:wip(checkpoint):"));
    assert.ok(
      result.events.some(
        (e) =>
          e.type === "organised" &&
          e.checkpointCount === 2 &&
          e.commitCount === 1,
      ),
    );
  });

  void it("no targetSessionId: reorganises scattered checkpoints behind regular commits", async () => {
    // HEAD is a regular commit; checkpoints are deeper in history.
    const store = new InMemoryCommitStore({
      checkpointCommits: [
        {
          message: "feat: regular commit on top",
          files: ["src/top.ts"],
          session: null,
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/b.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts"],
          session: "session-a",
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat(a+b): combined
=== FILES ===
src/a.ts
src/b.ts
=== END ===
`.trim();

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
      undefined,
      fakeCompleteReturning(input),
    );

    // BUG: currently returns organised=false because countCheckpointCommits returns 0
    // when HEAD is not a checkpoint. Should handle scattered checkpoints.
    assert.strictEqual(result.organised, true);
    assert.strictEqual(store.commits.length, 1);
    // Should use applyCommitDiffToIndex (scattered path), not resetSoft.
    assert.ok(store.operations.includes("applyCommitDiffToIndex:sha-2"));
    assert.ok(store.operations.includes("applyCommitDiffToIndex:sha-1"));
    assert.ok(!store.operations.some((op) => op.startsWith("resetSoft")));
  });

  void it("with targetSessionId contiguous: reset-soft path", async () => {
    const store = new InMemoryCommitStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 2`,
          files: ["src/b.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/a.ts"],
          session: "session-a",
        },
      ],
    });

    const inputContiguous = `
=== COMMIT 1 ===
feat: combined
=== FILES ===
src/a.ts
src/b.ts
=== END ===
`.trim();

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
      "session-a",
      fakeCompleteReturning(inputContiguous),
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(store.commits.length, 1);
    // Should use resetSoft (contiguous path).
    assert.ok(store.operations.includes("resetSoft:2"));
  });

  void it("with targetSessionId scattered: apply-commit-diff path", async () => {
    // Scattered: HEAD belongs to session-b, session-a checkpoints are below.
    const store = new InMemoryCommitStore({
      checkpointCommits: [
        // HEAD (index 0) belongs to the OTHER session.
        {
          message: `${CHECKPOINT_COMMIT_MARKER} other`,
          files: ["src/other.ts"],
          session: "session-b",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} own2`,
          files: ["src/own2.ts"],
          session: "session-a",
        },
        {
          message: `${CHECKPOINT_COMMIT_MARKER} own1`,
          files: ["src/own1.ts"],
          session: "session-a",
        },
      ],
    });

    const input = `
=== COMMIT 1 ===
feat: scattered
=== FILES ===
src/own1.ts
src/own2.ts
=== END ===
`.trim();

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
      "session-a",
      fakeCompleteReturning(input),
    );

    assert.strictEqual(result.organised, true);
    assert.strictEqual(store.commits.length, 1);
    // Scattered path: applyCommitDiffToIndex for each matching checkpoint (oldest first).
    // sha-1 = own1 (oldest), sha-2 = own2.
    assert.ok(store.operations.includes("applyCommitDiffToIndex:sha-2"));
    assert.ok(store.operations.includes("applyCommitDiffToIndex:sha-1"));
    // Should NOT use resetSoft (not contiguous).
    assert.ok(!store.operations.some((op) => op.startsWith("resetSoft")));
  });

  void it("with targetSessionId: returns no-op when no matching checkpoints exist", async () => {
    const store = new InMemoryCommitStore({
      checkpointCommits: [
        {
          message: `${CHECKPOINT_COMMIT_MARKER} turn 1`,
          files: ["src/x.ts"],
          session: "session-b",
        },
      ],
    });

    const result = await reorganiseCheckpointsManual(
      makeCtx(stubModel),
      config(),
      store,
      "session-a",
      fakeCompleteReturning(""),
    );

    assert.strictEqual(result.organised, false);
    assert.ok(
      result.events.some(
        (e) =>
          e.type === "info" &&
          e.message.includes("No checkpoint commits found for session session-a"),
      ),
    );
  });
});
