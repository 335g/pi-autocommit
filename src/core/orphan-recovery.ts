/**
 * Recover orphaned pi-git stashes left behind by previous interrupted runs.
 *
 * Both old static "pi-git" stashes and new timestamped "pi-git-{ts}" stashes
 * are detected and auto-popped at session start.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Matches stash list entries created by pi-git (old and new format).
 *
 * Example stash list line: "stash@{0}: On main: pi-git-1234567890"
 *                                                    ^^^^^^^^^^^^^^^^  message at end of line
 */
const STASH_MESSAGE_PATTERN = / pi-git(-\d+)?\s*$/;

export async function recoverOrphanedStashes(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (!ctx.hasUI) return;

  const { stdout, code } = await pi.exec(
    "git", ["stash", "list"], { cwd: ctx.cwd },
  );
  if (code !== 0) return; // not a git repo, or git error — silently skip

  const lines = stdout.split("\n").filter(Boolean);

  // Collect indices of pi-git stashes (0 = newest, N-1 = oldest).
  const orphanedIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (STASH_MESSAGE_PATTERN.test(lines[i])) {
      orphanedIndices.push(i);
    }
  }

  if (orphanedIndices.length === 0) return;

  // Pop from oldest to newest (largest index first) because popping
  // renumbers the remaining entries (stash@{1} → stash@{0}).
  orphanedIndices.sort((a, b) => b - a);

  let recovered = 0;
  let failed = 0;

  for (const idx of orphanedIndices) {
    const ref = `stash@{${idx}}`;
    const { code: popCode } = await pi.exec(
      "git", ["stash", "pop", ref], { cwd: ctx.cwd },
    );
    if (popCode === 0) {
      recovered++;
    } else {
      failed++;
      // Pop may fail due to merge conflicts — the stash stays in place.
      // User must recover manually. Continue trying the rest.
    }
  }

  if (recovered > 0 || failed > 0) {
    const parts: string[] = [];
    if (recovered > 0) {
      parts.push(
        `Recovered ${recovered} orphaned stash${recovered > 1 ? "es" : ""}`,
      );
    }
    if (failed > 0) {
      parts.push(
        `${failed} stash${failed > 1 ? "es" : ""} could not be auto-recovered — run 'git stash pop' manually`,
      );
    }
    ctx.ui.notify(
      `[pi-git] ${parts.join(".  ")}`,
      recovered > 0 ? "info" : "warning",
    );
  }
}
