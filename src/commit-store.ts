import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { GitOperations } from "./git-operations.js";

/**
 * Narrow seam used by the commit reorganiser to interact with the underlying
 * git state.
 *
 * The interface exposes only the operations the reorganiser policy actually
 * needs: repository checks, WIP commit inspection, soft reset, staged-material
 * reads, staging manipulation, and commit execution. This keeps the
 * reorganiser module deep (the policy is hidden) while making the seam real
 * with two adapters: a production wrapper around {@link GitOperations} and an
 * in-memory fake for tests.
 */
export interface CommitStore {
  /** Check whether the current directory is inside a git working tree. */
  isInsideGitRepo(): Promise<boolean>;

  /**
   * Count how many consecutive commits at HEAD match the given marker.
   * The reorganiser uses this to discover checkpoint commits created at
   * `turn_end`.
   */
  countWipCommits(marker: string): Promise<number>;

  /** Check whether there are any uncommitted changes in the working tree. */
  checkUncommittedChanges(): Promise<boolean>;

  /**
   * Soft reset the last N commits, keeping their changes staged.
   * Equivalent to `git reset --soft HEAD~N`.
   */
  resetSoft(commitCount: number): Promise<void>;

  /**
   * Read the staged materials needed for commit-message generation:
   * full diff, name-status, and stat summary.
   */
  getStagedMaterials(): Promise<{
    diff: string;
    nameStatus: string;
    stat: string;
  }>;

  /** Unstage all changes. */
  unstageAll(): Promise<void>;

  /** Stage only the given files. */
  stageFiles(files: string[]): Promise<void>;

  /** Stage all changes. */
  stageAll(): Promise<void>;

  /** Execute a commit with the given message. */
  commit(message: string): Promise<ExecResult>;
}

/**
 * Production adapter: satisfies {@link CommitStore} by delegating to
 * {@link GitOperations}.
 */
export class GitCommitStore implements CommitStore {
  constructor(private readonly git: GitOperations) {}

  async isInsideGitRepo(): Promise<boolean> {
    return this.git.isInsideGitRepo();
  }

  async countWipCommits(marker: string): Promise<number> {
    return this.git.countWipCommits(marker);
  }

  async checkUncommittedChanges(): Promise<boolean> {
    return this.git.checkUncommittedChanges();
  }

  async resetSoft(commitCount: number): Promise<void> {
    return this.git.resetSoft(commitCount);
  }

  async getStagedMaterials(): Promise<{
    diff: string;
    nameStatus: string;
    stat: string;
  }> {
    const [diff, nameStatus, stat] = await Promise.all([
      this.git.getStagedDiff(),
      this.git.getStagedNameStatus(),
      this.git.getStagedStat(),
    ]);
    return { diff, nameStatus, stat };
  }

  async unstageAll(): Promise<void> {
    return this.git.unstageAll();
  }

  async stageFiles(files: string[]): Promise<void> {
    return this.git.stageFiles(files);
  }

  async stageAll(): Promise<void> {
    return this.git.stageAll();
  }

  async commit(message: string): Promise<ExecResult> {
    return this.git.commit(message);
  }
}
