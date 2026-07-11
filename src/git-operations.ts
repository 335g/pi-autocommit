import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
    const { code } = await this.pi.exec("git", [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
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
    const { stdout } = await this.pi.exec("git", [
      "diff",
      "--cached",
      "--stat",
    ]);
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
    const { stdout } = await this.pi.exec("git", [
      "diff",
      "--cached",
      "--name-status",
    ]);
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
    const result = await this.pi.exec("git", [
      "restore",
      "--staged",
      "--",
      file,
    ]);
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

  /**
   * Count how many consecutive checkpoint commits exist at HEAD.
   *
   * Walks backwards from HEAD and stops at the first commit whose subject
   * does not start with the given marker (or, when `sessionId` is provided,
   * whose `Checkpoint-Session` trailer does not match).
   *
   * @param marker Subject prefix to match (e.g. `"wip(checkpoint):"`).
   * @param sessionId When provided, only count commits whose
   *   `Checkpoint-Session` trailer equals this value. When omitted, count
   *   every consecutive subject-matching commit (backward-compatible
   *   behaviour).
   */
  async countCheckpointCommits(marker: string, sessionId?: string): Promise<number> {
    if (sessionId === undefined) {
      // Original behaviour: subject-prefix match only.
      const { stdout, code } = await this.pi.exec("git", [
        "log",
        "--pretty=format:%s",
        "--no-decorate",
      ]);
      if (code !== 0) {
        return 0;
      }

      const subjects = stdout.split("\n");
      let count = 0;
      for (const subject of subjects) {
        if (subject.startsWith(marker)) {
          count++;
        } else {
          break;
        }
      }
      return count;
    }

    // Session-aware: match subject AND trailer.
    const { stdout, code } = await this.pi.exec("git", [
      "log",
      "--pretty=format:%H%x00%s%x00%(trailers:key=Checkpoint-Session,valueonly)",
      "--no-decorate",
    ]);
    if (code !== 0) {
      return 0;
    }

    const lines = stdout.trim().split("\n");
    let count = 0;
    for (const line of lines) {
      if (!line) continue;
      const [, subject, trailerSession] = line.split("\0");
      if (subject?.startsWith(marker)) {
        if (trailerSession?.trim() === sessionId) {
          count++;
        } else {
          break; // Non-matching session stops the scan.
        }
      } else {
        break; // Non-checkpoint subject stops the scan.
      }
    }
    return count;
  }

  /**
   * Soft reset the last N commits, keeping their changes staged.
   * Equivalent to `git reset --soft HEAD~N`.
   */
  async resetSoft(commitCount: number): Promise<void> {
    if (commitCount <= 0) {
      return;
    }
    const result = await this.pi.exec("git", [
      "reset",
      "--soft",
      `HEAD~${commitCount}`,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `git reset --soft HEAD~${commitCount} failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }
  }

  /**
   * Stage only the given files (`git add -- <file>...`).
   */
  async stageFiles(files: string[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    const result = await this.pi.exec("git", ["add", "--", ...files]);
    if (result.code !== 0) {
      throw new Error(
        `git add failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }
  }

  /**
   * Walk backwards from HEAD and return every reachable commit whose subject
   * starts with `marker`, along with its SHA and `Checkpoint-Session` trailer
   * value (or `null` when absent).
   *
   * Uses `%(trailers:key=...,valueonly)` so the trailer value is the empty
   * string (not `"NONE"`) when the key is missing — which becomes `null`
   * after `.trim() || null`.
   */
  async findReachableCheckpoints(
    marker: string,
  ): Promise<Array<{ sha: string; subject: string; session: string | null }>> {
    const { stdout, code } = await this.pi.exec("git", [
      "log",
      "--pretty=format:%H%x00%s%x00%(trailers:key=Checkpoint-Session,valueonly)",
      "--no-decorate",
    ]);
    if (code !== 0) return [];

    const result: Array<{
      sha: string;
      subject: string;
      session: string | null;
    }> = [];
    const lines = stdout.trim().split("\n");
    for (const line of lines) {
      if (!line) continue;
      const [sha, subject, sessionRaw] = line.split("\0");
      if (subject?.startsWith(marker)) {
        result.push({ sha, subject, session: sessionRaw?.trim() || null });
      }
    }
    return result;
  }

  /**
   * Extract the diff of a single commit (relative to its first parent) and
   * apply it to the index via `git apply --cached`.
   *
   * Used for scattered checkpoint reassembly: when target-session checkpoints
   * are interleaved with foreign checkpoints, each target commit's diff is
   * staged independently without moving HEAD.
   *
   * Returns `{ success: true }` on success, or `{ success: false, error }
   * when the apply fails (e.g. conflict).
   */
  async applyCommitDiffToIndex(
    sha: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Get the first parent of the commit.
    const {
      stdout: parent,
      code: parentCode,
    } = await this.pi.exec("git", ["rev-parse", `${sha}^`]);
    if (parentCode !== 0 || !parent.trim()) {
      return { success: false, error: `No parent for commit ${sha}` };
    }

    const parentSha = parent.trim();

    // Pipe `git diff <parent> <sha>` into `git apply --cached`.
    const { code, stderr } = await this.pi.exec("sh", [
      "-c",
      `git diff ${parentSha} ${sha} | git apply --cached`,
    ]);
    if (code !== 0) {
      return {
        success: false,
        error: stderr.trim() || `git apply --cached failed for ${sha}`,
      };
    }
    return { success: true };
  }
}
