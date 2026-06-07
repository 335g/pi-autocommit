/**
 * /git-agg-commit command
 *
 * Automatically analyzes git diff, splits into logical hunks,
 * generates Conventional Commits messages, stages, and commits.
 *
 * With --review flag: opens an interactive overlay where the user can
 * inspect, edit, and exclude hunks before committing.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { analyzeDiff, processHunks } from "../core/diff-analyzer.js";
import {
  collectDiff,
  ensureReadyToCommit,
  resetStaging,
  stageFiles,
} from "../core/git.js";
import { createReviewComponent } from "../core/review.js";
import type { Hunk, ReviewResult } from "../types.js";
import { t } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import { footerManager } from "../utils/footer-manager.js";

function parseLangArg(args: string): string | undefined {
  const match = args.match(/--lang(?:uage)?[=\s]+(\S+)/);
  return match?.[1];
}

function parseReviewFlag(args: string): boolean {
  return /--review\b/.test(args);
}

/** Extract all file paths from a git diff string */
function extractDiffFiles(diff: string): string[] {
  const files: string[] = [];
  const regex = /^diff --git a\/(.+) b\/(.+)$/gm;
  let match = regex.exec(diff);
  while (match !== null) {
    files.push(match[2]);
    match = regex.exec(diff);
  }
  return files;
}

/** Find files in the diff that are not covered by any hunk */
function findUnstagedFiles(diff: string, hunks: Hunk[]): string[] {
  const diffFiles = new Set(extractDiffFiles(diff));
  for (const hunk of hunks) {
    for (const f of hunk.files) {
      diffFiles.delete(f);
    }
  }
  return [...diffFiles];
}

/**
 * Run the interactive hunk review overlay.
 * Returns the ReviewResult, or null if cancelled or no UI.
 */
async function runReview(
  ctx: ExtensionContext,
  hunks: Hunk[],
  diff: string,
  runLang: string,
): Promise<ReviewResult | null> {
  if (!ctx.hasUI) return null;

  await footerManager.setPhase("review", runLang);

  const unstagedFiles = findUnstagedFiles(diff, hunks);

  const result = await ctx.ui.custom<ReviewResult>(
    createReviewComponent(hunks, runLang, unstagedFiles),
    {
      overlay: true,
      overlayOptions: {
        maxHeight: "70%",
        width: "80%",
        anchor: "center",
      },
    },
  );

  if (result.cancelled) {
    ctx.ui.notify(t(runLang, "review.cancelled"), "info");
    return null;
  }

  return result;
}

/** Commit hunks sequentially with progress updates. */
async function commitHunks(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  hunks: Hunk[],
  runLang: string,
): Promise<{ committed: number; failed: number; skipped: number }> {
  let committedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    await footerManager.setCommitProgress(i + 1, hunks.length);

    // Ensure clean staging area before each hunk
    try {
      await resetStaging(pi, ctx.cwd);
    } catch {
      ctx.ui.notify(t(runLang, "aggCommit.stagingResetFailed"), "error");
      failedCount++;
      break;
    }

    try {
      await stageFiles(pi, hunk.files, ctx.cwd);
    } catch {
      failedCount++;
      continue;
    }

    const { stdout: stagedDiff, code: diffCode } = await pi.exec(
      "git",
      ["diff", "--cached", "--stat"],
      { cwd: ctx.cwd },
    );
    if (diffCode !== 0 || !stagedDiff.trim()) {
      skippedCount++;
      continue;
    }

    const { code: exitCode, stderr } = await pi.exec(
      "git",
      ["commit", "-m", hunk.message],
      { cwd: ctx.cwd },
    );
    if (exitCode !== 0) {
      const detail = stderr.trim() ? ` — ${stderr.trim()}` : "";
      ctx.ui.notify(
        t(runLang, "aggCommit.commitFailed", {
          message: hunk.message,
          exitCode: String(exitCode),
        }) + detail,
        "warning",
      );
      failedCount++;
      continue;
    }

    committedCount++;
  }

  return {
    committed: committedCount,
    failed: failedCount,
    skipped: skippedCount,
  };
}

export async function handleAggCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  const lang = getLanguage(ctx.cwd);

  if (/--help/.test(args)) {
    if (ctx.hasUI) {
      ctx.ui.notify(t(lang, "aggCommit.help"), "info");
    }
    return;
  }

  // Parse language argument (temporary override, does not save)
  const langArg = parseLangArg(args);
  const runLang = langArg ?? lang;
  const isReview = parseReviewFlag(args);
  if (langArg) {
    ctx.ui.notify(
      t(runLang, "aggCommit.langOverride", { lang: langArg }),
      "info",
    );
  }

  if (!ctx.hasUI) {
    return;
  }

  if (footerManager.isRunning()) {
    ctx.ui.notify(t(runLang, "aggCommit.alreadyRunning"), "warning");
    return;
  }

  try {
    await footerManager.setRunning("agg-commit", "prepare", runLang);

    const preCheck = await ensureReadyToCommit(pi, ctx.cwd);
    if (preCheck) {
      const key =
        preCheck === "not_git_repo"
          ? "aggCommit.notGitRepo"
          : preCheck === "merge_conflict"
            ? "aggCommit.mergeConflict"
            : "aggCommit.noChanges";
      const level =
        preCheck === "merge_conflict"
          ? "error"
          : preCheck === "not_git_repo"
            ? "warning"
            : "info";
      ctx.ui.notify(t(runLang, key), level);
      return;
    }

    // Snapshot changes via stash (SHA-based diff capture — no reflog race)
    await footerManager.setPhase("collectDiff", runLang);
    const diff = await collectDiff(pi, ctx.cwd);
    if (diff === null) {
      ctx.ui.notify(t(runLang, "aggCommit.stashFailed"), "warning");
      return;
    }
    if (!diff.trim()) {
      ctx.ui.notify(t(runLang, "aggCommit.noChanges"), "info");
      return;
    }

    // Analyze diff into logical hunks
    await footerManager.setPhase("analyze", runLang);
    let hunks = await analyzeDiff(pi, ctx, diff, runLang);
    if (hunks.length === 0) {
      ctx.ui.notify(t(runLang, "aggCommit.noHunksFound"), "info");
      return;
    }

    // Sanitize, deduplicate, and filter hunks
    await footerManager.setPhase("generateMessage", runLang);
    hunks = processHunks(hunks);

    // ── Review mode: interactive hunk review ──────────────────
    if (isReview) {
      const reviewResult = await runReview(ctx, hunks, diff, runLang);
      if (reviewResult === null) {
        return; // cancelled — no commits
      }
      // Only commit included hunks
      hunks = reviewResult.hunks.filter((h) => h.included);
      if (hunks.length === 0) {
        ctx.ui.notify(t(runLang, "review.noHunksSelected"), "info");
        return;
      }
    }

    // Stage and commit each hunk
    await footerManager.setPhase("commit", runLang);
    const { committed, failed, skipped } = await commitHunks(
      pi,
      ctx,
      hunks,
      runLang,
    );

    const parts: string[] = [];
    if (committed > 0) {
      parts.push(
        t(runLang, "aggCommit.summaryCommitted", {
          count: String(committed),
        }),
      );
    }
    if (skipped > 0) {
      parts.push(
        t(runLang, "aggCommit.summarySkipped", {
          count: String(skipped),
        }),
      );
    }
    if (failed > 0) {
      parts.push(
        t(runLang, "aggCommit.summaryFailed", {
          count: String(failed),
        }),
      );
    }

    if (parts.length === 0) {
      ctx.ui.notify(t(runLang, "aggCommit.summaryAllFailed"), "error");
    } else if (failed > 0) {
      ctx.ui.notify(parts.join(", "), "warning");
    } else {
      ctx.ui.notify(parts.join(", "), "info");
    }
  } finally {
    // Final cleanup: ensure staging area is clean
    try {
      await resetStaging(pi, ctx.cwd);
    } catch {
      /* ignore */
    }
    await footerManager.clearRunning();
  }
}
