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

export async function getCurrentBranch(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<string> {
  const { stdout, code } = await pi.exec("git", ["branch", "--show-current"], {
    cwd,
  });
  if (code !== 0) {
    throw new GitError(
      "Failed to get current branch",
      "git branch --show-current",
      code,
    );
  }
  return stdout.trim();
}

export async function getBranches(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<{ name: string; isRemote: boolean }[]> {
  const { stdout, code } = await pi.exec(
    "git",
    ["branch", "-a", "--format=%(refname:short)"],
    { cwd },
  );
  if (code !== 0) {
    throw new GitError("Failed to get branches", "git branch -a", code);
  }
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((name) => ({
      name: name.trim(),
      isRemote: name.startsWith("origin/"),
    }));
}

export async function switchBranch(
  pi: ExtensionAPI,
  branch: string,
  cwd?: string,
): Promise<{ success: boolean; message: string }> {
  const { stdout, stderr, code } = await pi.exec("git", ["switch", branch], {
    cwd,
  });
  if (code !== 0) {
    return { success: false, message: stderr || stdout };
  }
  return { success: true, message: stdout };
}

export async function createAndSwitchBranch(
  pi: ExtensionAPI,
  branch: string,
  cwd?: string,
): Promise<{ success: boolean; message: string }> {
  const { stdout, stderr, code } = await pi.exec(
    "git",
    ["switch", "-c", branch],
    { cwd },
  );
  if (code !== 0) {
    return { success: false, message: stderr || stdout };
  }
  return { success: true, message: stdout };
}

export async function deleteBranch(
  pi: ExtensionAPI,
  branch: string,
  cwd?: string,
): Promise<{ success: boolean; message: string }> {
  const { stdout, stderr, code } = await pi.exec(
    "git",
    ["branch", "-d", branch],
    { cwd },
  );
  if (code !== 0) {
    return { success: false, message: stderr || stdout };
  }
  return { success: true, message: stdout };
}

/**
 * Check that the working directory is a git repository with pending changes.
 * Returns null if ready, or a failure reason string.
 */
export async function ensureReadyToCommit(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<"not_git_repo" | "no_changes" | null> {
  if (!(await isGitRepository(pi, cwd))) {
    return "not_git_repo";
  }
  if (!(await hasChanges(pi, cwd))) {
    return "no_changes";
  }
  return null;
}

/**
 * Get git log with specified options
 */
export async function getLog(
  pi: ExtensionAPI,
  options: {
    maxCount?: number | "all";
    all?: boolean;
    graph?: boolean;
  },
  cwd?: string,
): Promise<string> {
  const args = ["log", "--oneline"];

  if (options.maxCount !== "all" && options.maxCount !== undefined) {
    args.push(`-n`, String(options.maxCount));
  }

  if (options.all) {
    args.push("--all");
  }

  if (options.graph) {
    args.push("--graph");
  }

  const { stdout, code } = await pi.exec("git", args, { cwd });
  if (code !== 0) {
    throw new GitError("Failed to get git log", `git ${args.join(" ")}`, code);
  }
  return stdout;
}

/**
 * Collect the full working tree diff by stashing changes (including untracked
 * files), capturing the stash diff, and popping the stash to restore the
 * working tree. This "freezes" the diff so concurrent edits do not affect
 * analysis.
 *
 * @returns The diff string, or `null` if the stash operation failed.
 *          An empty string means there are no effective changes.
 */
export async function collectDiff(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<string | null> {
  const { code: stashCode } = await pi.exec(
    "git",
    ["stash", "push", "-u", "-m", "pi-git"],
    { cwd },
  );
  if (stashCode !== 0) {
    return null;
  }

  let diff = "";
  try {
    const { stdout: stashDiff } = await pi.exec(
      "git",
      ["stash", "show", "-p", "stash@{0}"],
      { cwd },
    );
    diff = stashDiff;

    // stash@{0}^3 contains untracked files when -u was used
    const { stdout: untrackedDiff, code: untrackedCode } = await pi.exec(
      "git",
      ["diff", "HEAD", "stash@{0}^3"],
      { cwd },
    );
    if (untrackedCode === 0 && untrackedDiff.trim()) {
      diff += (diff ? "\n" : "") + untrackedDiff;
    }
  } finally {
    await pi.exec("git", ["stash", "pop"], { cwd });
  }

  return diff;
}
