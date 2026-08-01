import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { GitOperations, type GitStatus } from "./git-operations.js";

/**
 * Narrow seam used by the checkpoint pipeline to interact with the underlying
 * git state.
 *
 * The interface exposes only the operations the turn_end checkpoint path
 * actually needs: repository checks, conflict detection, status reads, staging,
 * commit execution, and cleanup. This keeps the checkpoint module deep while
 * making the seam real with two adapters: a production wrapper around
 * {@link GitOperations} and an in-memory fake for tests.
 */
export interface CheckpointStore {
  /** Check whether the current directory is inside a git working tree. */
  isInsideGitRepo(): Promise<boolean>;

  /** Check whether a merge conflict is in progress. */
  hasMergeConflict(): Promise<boolean>;

  /** Run `git status --short` and return whether there are uncommitted changes. */
  checkStatus(): Promise<GitStatus>;

  /** Stage all changes (`git add -A`). */
  stageAll(): Promise<void>;

  /** Execute `git commit -m <message>`. */
  commit(message: string): Promise<ExecResult>;

  /** Unstage all changes (`git reset HEAD --`). */
  unstageAll(): Promise<void>;
}

/**
 * Production adapter: satisfies {@link CheckpointStore} by delegating to
 * {@link GitOperations}.
 */
export class GitCheckpointStore implements CheckpointStore {
  constructor(private readonly git: GitOperations) {}

  async isInsideGitRepo(): Promise<boolean> {
    return this.git.isInsideGitRepo();
  }

  async hasMergeConflict(): Promise<boolean> {
    return this.git.hasMergeConflict();
  }

  async checkStatus(): Promise<GitStatus> {
    return this.git.checkStatus();
  }

  async stageAll(): Promise<void> {
    return this.git.stageAll();
  }

  async commit(message: string): Promise<ExecResult> {
    return this.git.commit(message);
  }

  async unstageAll(): Promise<void> {
    return this.git.unstageAll();
  }
}
