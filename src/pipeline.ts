import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PipelineEvent, PipelineResult } from "./commit-events.js";
import { GitOperations } from "./git-operations.js";

// ── Checkpoint commit ──────────────────────────────────────

/**
 * Create a lightweight checkpoint commit at `turn_end`.
 *
 * Steps:
 *   1. Verify git repository
 *   2. Check for merge conflicts
 *   3. Check for uncommitted changes
 *   4. Stage all files (`git add -A`)
 *   5. Execute `git commit -m <message>`
 *
 * The checkpoint message (e.g. `wip(checkpoint): auto-commit at turn N`)
 * is supplied by the caller. When `sessionId` is provided, a
 * `Checkpoint-Session: <sessionId>` Git trailer is appended to the commit
 * body so the reorganiser can scope its reset to the owning session.
 *
 * Checkpoint commits are later reorganised into logical Conventional
 * Commits at `agent_end` by the organiser.
 *
 * Error boundary: on any error, `unstageAll` runs before re-throwing.
 * Footer-status updates are the caller's responsibility.
 */
export async function runCheckpointCommit(
  pi: ExtensionAPI,
  message: string,
  sessionId?: string,
): Promise<PipelineResult> {
  const git = new GitOperations(pi);
  const events: PipelineEvent[] = [];
  let committed = false;

  try {
    // ── 1. Verify git repository ────────────────────────
    if (!(await git.isInsideGitRepo())) {
      events.push({ type: "error", message: "Not a git repository" });
      return { events, committed: false };
    }

    // ── 2. Check for merge conflict ─────────────────────
    if (await git.hasMergeConflict()) {
      events.push({
        type: "error",
        message: "Merge conflict in progress. Skipping checkpoint commit.",
      });
      return { events, committed: false };
    }

    // ── 3. Check for changes ────────────────────────────
    const status = await git.checkStatus();
    if (!status.hasChanges) {
      events.push({ type: "info", message: "No changes to checkpoint" });
      events.push({ type: "stage-changed", hasChanges: false });
      return { events, committed: false };
    }

    // ── 4. Stage all files ──────────────────────────────
    await git.stageAll();

    // ── 5. Execute commit ───────────────────────────────
    // Append Checkpoint-Session trailer when a session id is available.
    const commitMessage = sessionId
      ? `${message}\n\nCheckpoint-Session: ${sessionId}`
      : message;
    const result = await git.commit(commitMessage);
    if (result.code !== 0) {
      throw new Error(
        `Commit failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }

    committed = true;
    events.push({
      type: "committed",
      message: result.stdout.trim() || message.split("\n")[0],
    });
    events.push({ type: "stage-changed", hasChanges: false });
    return { events, committed };
  } catch (error) {
    // Error boundary: cleanup before re-throwing.
    try {
      await git.unstageAll();
    } catch {
      // Best-effort cleanup
    }
    throw error;
  }
}
