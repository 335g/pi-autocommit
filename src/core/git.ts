/**
 * Git command wrappers using pi.exec
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DiffHunk, DiffHunkRef } from "../types.js";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
 * Stage specific @@-hunks within files without touching other hunks in the same file.
 *
 * Strategy:
 * - Files where ALL hunks are included → "git add" (fast path)
 * - Files where only SOME hunks are included → construct patch with only those hunks
 *   sorted in descending line-number order → "git apply --cached"
 *
 * Descending order avoids line-number staleness: committing a later hunk first
 * never affects the context lines of an earlier hunk in the same file.
 *
 * Atomic files (binary, rename, mode-only) are always staged as a whole file.
 */
export async function stageDiffHunks(
  pi: ExtensionAPI,
  diffHunks: DiffHunk[],
  hunkRefs: DiffHunkRef[],
  cwd?: string,
): Promise<void> {
  if (hunkRefs.length === 0) return;

  // Build a map: file → hunk.globalIndex set (what we want to stage)
  const fileToWanted = new Map<string, Set<number>>();
  for (const ref of hunkRefs) {
    const h = diffHunks.find((dh) => dh.globalIndex === ref.globalIndex);
    if (!h) continue;
    ref.file = h.file; // enrich the ref
    if (!fileToWanted.has(h.file)) fileToWanted.set(h.file, new Set());
    fileToWanted.get(h.file)!.add(h.globalIndex);
  }

  // Classify files: full-stage or partial-stage
  const fullFiles: string[] = [];
  const partialFiles = new Map<string, number[]>(); // file → hunkIndices (descending)

  for (const [file, wantedIndices] of fileToWanted) {
    const allFileHunks = diffHunks.filter((h) => h.file === file);

    // Atomic files always go full-stage
    if (allFileHunks.length === 0 || allFileHunks[0].isAtomic) {
      fullFiles.push(file);
      continue;
    }

    const allFileIndices = new Set(allFileHunks.map((h) => h.globalIndex));
    const isFullStage = [...allFileIndices].every((idx) => wantedIndices.has(idx));

    if (isFullStage) {
      fullFiles.push(file);
    } else {
      // Partial: collect in descending line order for stable patch application
      const wantedHunks = allFileHunks
        .filter((h) => wantedIndices.has(h.globalIndex))
        .sort((a, b) => b.hunkIndexInFile - a.hunkIndexInFile);
      partialFiles.set(file, wantedHunks.map((h) => h.globalIndex));
    }
  }

  // Fast path: stage full files
  if (fullFiles.length > 0) {
    await stageFiles(pi, fullFiles, cwd);
  }

  // Partial path: construct patches for each file
  if (partialFiles.size === 0) return;

  const tmpDir = mkdtempSync(join(tmpdir(), "pi-git-"));

  try {
    for (const [file, wantedGlobalIndices] of partialFiles) {
      const fileHunks = diffHunks.filter(
        (h) => h.file === file && wantedGlobalIndices.includes(h.globalIndex),
      );

      // Sort by descending hunkIndexInFile (committing later hunks first avoids line-number drift)
      fileHunks.sort((a, b) => b.hunkIndexInFile - a.hunkIndexInFile);

      // Build a minimal patch: file header + selected hunk contents
      const sourceHunks = diffHunks.filter((h) => h.file === file);
      const patchLines: string[] = [];

      // Reconstruct the file header from the first hunk's content
      for (const h of sourceHunks) {
        if (h.content.includes("diff --git")) {
          // Find the diff header lines in the original content
          const headerLines = h.content.split("\n").filter(
            (l) =>
              l.startsWith("diff --git") ||
              l.startsWith("--- ") ||
              l.startsWith("+++ ") ||
              l.startsWith("index "),
          );
          patchLines.push(...headerLines);
          break;
        }
      }

      for (const h of fileHunks) {
        patchLines.push(h.content);
      }

      const patchContent = patchLines.join("\n");
      if (!patchContent.trim()) continue;

      const patchPath = join(tmpDir, `${file.replace(/[/\s:]/g, "_")}.patch`);
      writeFileSync(patchPath, patchContent + "\n", "utf-8");

      const { code, stderr } = await pi.exec(
        "git",
        ["apply", "--cached", "--verbose", patchPath],
        { cwd },
      );
      if (code !== 0) {
        throw new GitError(
          `Failed to apply partial patch for ${file}: ${stderr.trim()}`,
          "git apply --cached",
          code,
        );
      }
    }
  } finally {
    // Cleanup temp files
    try {
      for (const [, wantedGlobalIndices] of partialFiles) {
        const fileHunks = diffHunks.filter(
          (h) => wantedGlobalIndices.includes(h.globalIndex),
        );
        for (const h of fileHunks) {
          const patchPath = join(
            tmpDir,
            `${h.file.replace(/[/\s:]/g, "_")}.patch`,
          );
          try {
            unlinkSync(patchPath);
          } catch {
            /* best-effort cleanup */
          }
        }
      }
      try {
        rmdirSync(tmpDir);
      } catch {
        /* may not be empty — fine */
      }
    } catch {
      /* best-effort cleanup */
    }
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
    try {
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
    } catch {
      // stash pop threw — treat as failure so caller aborts
      popFailed = true;
    }
  }

  if (popFailed) return null;
  return diff;
}
