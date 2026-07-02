import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";

/**
 * Result of checking the repository state.
 */
export interface GitStatus {
  hasChanges: boolean;
  raw: string;
}

/**
 * Wrapper around git operations used by the extension.
 *
 * All commands are run via `pi.exec()` so they inherit pi's environment
 * (PATH, SSH keys, git config, etc.).
 */
export class GitOperations {
  constructor(private readonly pi: ExtensionAPI) {}

  /**
   * Check whether the current directory is inside a git working tree.
   * Returns `true` on success, `false` if not a git repo.
   */
  async isInsideGitRepo(): Promise<boolean> {
    const { code } = await this.pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
    return code === 0;
  }

  /**
   * Run `git status --short` and return whether there are uncommitted changes.
   */
  async checkStatus(): Promise<GitStatus> {
    const { stdout } = await this.pi.exec("git", ["status", "--short"]);
    const trimmed = stdout.trim();
    return { hasChanges: trimmed.length > 0, raw: trimmed };
  }

  /**
   * Stage all changes via `git add -A`.
   */
  async stageAll(): Promise<void> {
    const result = await this.pi.exec("git", ["add", "-A"]);
    if (result.code !== 0) {
      throw new Error(
        `git add -A failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }
  }

  /**
   * Get the stat summary of staged changes (`git diff --cached --stat`).
   */
  async getStagedStat(): Promise<string> {
    const { stdout } = await this.pi.exec("git", ["diff", "--cached", "--stat"]);
    return stdout.trim();
  }

  /**
   * Get the full diff of staged changes (`git diff --cached`).
   */
  async getStagedDiff(): Promise<string> {
    const { stdout } = await this.pi.exec("git", ["diff", "--cached"]);
    return stdout.trim();
  }

  /**
   * Get the name-status of staged changes (`git diff --cached --name-status`).
   */
  async getStagedNameStatus(): Promise<string> {
    const { stdout } = await this.pi.exec("git", ["diff", "--cached", "--name-status"]);
    return stdout.trim();
  }

  /**
   * Check whether a merge conflict is in progress.
   * Returns `true` if the index is locked (conflict markers present, etc.)
   */
  async hasMergeConflict(): Promise<boolean> {
    // If a merge is in progress, `git diff --cached` may fail or
    // `git ls-files --unmerged` returns non-empty output.
    const { stdout } = await this.pi.exec("git", ["ls-files", "--unmerged"]);
    return stdout.trim().length > 0;
  }

  /**
   * Execute the commit with the given message.
   * Returns the raw stdout output of `git commit`.
   */
  async commit(message: string): Promise<ExecResult> {
    return await this.pi.exec("git", ["commit", "-m", message]);
  }

  /**
   * Unstage a specific file (`git restore --staged -- <file>`).
   *
   * Throws when the git command fails (non-zero exit), ensuring callers
   * (e.g. the commit pipeline) can detect the failure and abort/clean up
   * instead of silently committing unselected files.
   */
  async unstageFile(file: string): Promise<void> {
    const result = await this.pi.exec("git", ["restore", "--staged", "--", file]);
    if (result.code !== 0) {
      throw new Error(
        `git restore --staged -- ${file} failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }
  }

  /**
   * Unstage all changes (`git reset HEAD --`).
   */
  async unstageAll(): Promise<void> {
    const result = await this.pi.exec("git", ["reset", "HEAD", "--"]);
    if (result.code !== 0) {
      throw new Error(
        `git reset HEAD -- failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }
  }

  /**
   * Get the staged diff for a single file (`git diff --cached -- <file>`).
   */
  async getFileStagedDiff(filePath: string): Promise<string> {
    const { stdout } = await this.pi.exec("git", [
      "diff",
      "--cached",
      "--",
      filePath,
    ]);
    return stdout;
  }

  /**
   * Get the staged numstat for a single file (`git diff --cached --numstat -- <file>`).
   * Returns the number of added and deleted lines.
   */
  async getFileStagedNumstat(
    filePath: string,
  ): Promise<{ additions: number; deletions: number }> {
    const { stdout } = await this.pi.exec("git", [
      "diff",
      "--cached",
      "--numstat",
      "--",
      filePath,
    ]);
    const match = stdout.trim().match(/^(\d+)\s+(\d+)/);
    if (match) {
      return {
        additions: Number.parseInt(match[1], 10),
        deletions: Number.parseInt(match[2], 10),
      };
    }
    return { additions: 0, deletions: 0 };
  }

  /**
   * Run `git status` (full output, human-readable) and return the result.
   */
  async getFullStatus(): Promise<string> {
    const { stdout } = await this.pi.exec("git", ["status"]);
    return stdout;
  }

  /**
   * Check whether there are any uncommitted changes (staged, unstaged, or untracked).
   * Uses `git status --porcelain` for machine-parseable output.
   * Returns true if there are any changes relative to HEAD.
   */
  async checkUncommittedChanges(): Promise<boolean> {
    const { stdout } = await this.pi.exec("git", ["status", "--porcelain"]);
    return stdout.trim().length > 0;
  }
}
