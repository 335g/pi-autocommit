/**
 * Git command wrappers using pi.exec
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

class GitError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly code: number,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export async function isGitRepository(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<boolean> {
  const { code } = await pi.exec("git", ["rev-parse", "--git-dir"], { cwd });
  return code === 0;
}

export async function getStatus(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<string> {
  const { stdout, code } = await pi.exec("git", ["status", "--porcelain"], {
    cwd,
  });
  if (code !== 0) {
    throw new GitError(
      "Failed to get git status",
      "git status --porcelain",
      code,
    );
  }
  return stdout;
}

/** Unmerged path status codes in git status --porcelain XY format */
const UNMERGED_CODES = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"];

/** Check for unmerged paths (merge conflicts) */
export async function hasUnmergedPaths(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<boolean> {
  const status = await getStatus(pi, cwd);
  return status.split("\n").some((line) => {
    const xy = line.substring(0, 2);
    return UNMERGED_CODES.includes(xy);
  });
}

export async function hasChanges(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<boolean> {
  const status = await getStatus(pi, cwd);
  return status.trim().length > 0;
}

export async function stageFiles(
  pi: ExtensionAPI,
  files: string[],
  cwd?: string,
): Promise<void> {
  if (files.length === 0) return;
  const { code } = await pi.exec("git", ["add", "--", ...files], { cwd });
  if (code !== 0) {
    throw new GitError(
      `Failed to stage files: ${files.join(", ")}`,
      "git add",
      code,
    );
  }
}

export async function resetStaging(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<void> {
  const { code } = await pi.exec("git", ["reset"], { cwd });
  if (code !== 0) {
    throw new GitError("Failed to reset staging area", "git reset", code);
  }
}

/**
 * Check that the working directory is a git repository with pending changes.
 * Returns null if ready, or a failure reason string.
 */
export async function ensureReadyToCommit(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<"not_git_repo" | "merge_conflict" | "no_changes" | null> {
  if (!(await isGitRepository(pi, cwd))) {
    return "not_git_repo";
  }
  if (await hasUnmergedPaths(pi, cwd)) {
    return "merge_conflict";
  }
  if (!(await hasChanges(pi, cwd))) {
    return "no_changes";
  }
  return null;
}

/**
 * Collect the full working tree diff by stashing changes (including untracked
 * files), capturing the diff via the stash SHA, and popping the stash to
 * restore the working tree.
 *
 * The stash SHA is captured immediately after push and used for all diff
 * operations, eliminating any reflog-positional race conditions.
 *
 * @returns The diff string, or `null` if a git error occurred.
 *          An empty string means there are no effective changes.
 */
export async function collectDiff(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<string | null> {
  // Unique message per run — enables orphan stash identification and recovery.
  const stashMessage = `pi-git-${Date.now()}`;

  // Step 1 — push stash to snapshot the working tree (including untracked files).
  const { code: pushCode } = await pi.exec(
    "git",
    ["stash", "push", "-u", "-m", stashMessage],
    { cwd },
  );
  if (pushCode !== 0) return null;

  // Step 2 — verify our stash was actually created.
  // `git stash push` exits 0 even on "No local changes to save".
  // Checking the stash list message is unambiguous.
  const { stdout: topLine, code: listCode } = await pi.exec(
    "git",
    ["stash", "list", "-1"],
    { cwd },
  );
  if (listCode !== 0 || !topLine.includes(stashMessage)) {
    // Our stash was NOT created — "No local changes to save".
    return "";
  }

  // Step 3 — IMMEDIATELY capture the stash SHA.
  // Race window: between push and this rev-parse is a single `await` (~10 ms).
  // After this point, all operations use the SHA — reflog position is irrelevant.
  const { stdout: shaOut, code: shaCode } = await pi.exec(
    "git",
    ["rev-parse", "stash@{0}"],
    { cwd },
  );
  if (shaCode !== 0) return null;
  const stashSha = shaOut.trim();

  let diff = "";
  let popFailed = false;
  try {
    // Step 4 — capture tracked-file diff using the SHA (not stash@{0}).
    // stashSha^1 = HEAD at stash creation time.
    const { stdout: trackedDiff, code: trackedCode } = await pi.exec(
      "git",
      ["diff", `${stashSha}^1`, stashSha],
      { cwd },
    );
    if (trackedCode !== 0) return null;
    diff = trackedDiff;

    // Step 5 — capture untracked-file diff.
    // stashSha^3 exists only when -u was used AND untracked files were present.
    const { stdout: untrackedDiff, code: untrackedCode } = await pi.exec(
      "git",
      ["diff", "HEAD", `${stashSha}^3`],
      { cwd },
    );
    if (untrackedCode === 0 && untrackedDiff.trim()) {
      diff += (diff ? "\n" : "") + untrackedDiff;
    }
  } finally {
    // Step 6 — restore the working tree.
    // Diff was already captured via SHA, so even if pop fails, the stash
    // remains as an orphan — orphan recovery handles it next session_start.
    // But we must NOT proceed to commit if the working tree is corrupted.
    const { code: popCode } = await pi.exec(
      "git",
      ["stash", "pop", "stash@{0}"],
      { cwd },
    );
    if (popCode !== 0) {
      // Pop failed (merge conflict, etc.).  The stash stays as an orphan.
      // Signal the caller to abort — the working tree may be corrupted.
      popFailed = true;
    }
  }

  if (popFailed) return null;
  return diff;
}
