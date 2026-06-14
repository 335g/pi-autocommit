/**
 * Batch commit flow for accumulate mode.
 *
 * Called from /git-agg-commit when auto_agg_commit_mode is "accumulate".
 * Collects diff, injects TurnLog into AI prompt, splits into hunks, and commits.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { t } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import { footerManager } from "../utils/footer-manager.js";
import {
  analyzeDiff,
  analyzeDiffIntent,
  parseDiffHunks,
  validateHunkCoverage,
  processHunks,
} from "./diff-analyzer.js";
import { collectDiff, hasChanges, resetStaging } from "./git.js";
import { commitHunks, commitCommitGroups } from "./commit-hunks.js";
import { runHunkReview } from "./review.js";
import { turnLog } from "./turn-log.js";
import type { CommitGroup, DiffHunk, Hunk } from "../types.js";

/**
 * Execute a batch commit using the accumulated TurnLog for context.
 *
 * @param pi - Extension API
 * @param ctx - Command context
 * @param langOverride - Optional language override (from --lang flag)
 * @param isReview - If true, show the interactive hunk review dialog
 */
export async function batchCommit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  langOverride?: string,
  isReview = false,
): Promise<{
  committed: number;
  failed: number;
  skipped: number;
  aborted: number;
  message: string;
}> {
  const lang = langOverride ?? getLanguage(ctx.cwd);

  // 1. Pre-flight checks
  await footerManager.setPhase("collectDiff", lang);

  if (!(await hasChanges(pi))) {
    return {
      committed: 0,
      failed: 0,
      skipped: 0,
      aborted: 0,
      message: t(lang, "aggCommit.noChanges"),
    };
  }

  const diff = await collectDiff(pi, ctx.cwd);
  if (diff === null) {
    return {
      committed: 0,
      failed: 0,
      skipped: 0,
      aborted: 0,
      message: t(lang, "aggCommit.stashFailed"),
    };
  }
  if (!diff.trim()) {
    return {
      committed: 0,
      failed: 0,
      skipped: 0,
      aborted: 0,
      message: t(lang, "aggCommit.noChanges"),
    };
  }

  // 2. Analyze diff — try intent-based first, fall back to diff-based
  await footerManager.setPhase("analyze", lang);

  const turnLogText = turnLog.formatForPrompt();

  let result: {
    committed: number;
    failed: number;
    skipped: number;
    aborted: number;
    message: string;
  } | null = null;

  // Try intent-based analysis when TurnLog is available
  if (turnLogText) {
    const intentResult = await analyzeDiffIntent(
      pi,
      ctx,
      diff,
      turnLogText,
      lang,
    );

    if (intentResult) {
      const diffHunks = parseDiffHunks(diff);
      const validated = validateHunkCoverage(
        intentResult.groups,
        diffHunks.length,
      );

      if (intentResult.overallConfidence === "low") {
        // Large divergence — fall back to diff-based analysis
        ctx.ui.notify(
          t(lang, "diffAnalyzer.intentLowConfidence"),
          "info",
        );
      } else if (intentResult.overallConfidence === "medium") {
        ctx.ui.notify(
          t(lang, "diffAnalyzer.intentMediumConfidence"),
          "warning",
        );
        // medium — still use intent-based but warn
        result = await commitIntentGroups(
          pi,
          ctx,
          validated,
          diffHunks,
          diff,
          lang,
          isReview,
        );
      } else {
        // high — use intent-based
        result = await commitIntentGroups(
          pi,
          ctx,
          validated,
          diffHunks,
          diff,
          lang,
          isReview,
        );
      }
    } else {
      // Intent analysis returned null — fall back to diff-based
    }
  }

  // Fall back to existing diff-based analysis when:
  // - TurnLog is empty, OR
  // - intent-based analysis returned null, OR
  // - overallConfidence was "low"
  if (!result) {
    result = await commitDiffBasedHunks(
      pi,
      ctx,
      diff,
      lang,
      turnLogText || undefined,
      isReview,
    );
  }

  return result;
}

/**
 * Convenience wrapper: run batch commit with cleanup.
 * Clears TurnLog after commit attempt and resets staging area.
 */
export async function batchCommitWithCleanup(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  langOverride?: string,
  isReview = false,
): Promise<{
  committed: number;
  failed: number;
  skipped: number;
  aborted: number;
  message: string;
}> {
  try {
    const result = await batchCommit(pi, ctx, langOverride, isReview);

    // Clear TurnLog after commit attempt (unconditional — diff is primary)
    turnLog.clear();

    return result;
  } finally {
    // Final cleanup: ensure staging area is clean
    try {
      await resetStaging(pi, ctx.cwd);
    } catch {
      /* ignore */
    }
  }
}

// ───────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────

/**
 * Commit using intent-based hunk groups with partial-file staging.
 */
async function commitIntentGroups(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  groups: CommitGroup[],
  diffHunks: DiffHunk[],
  diff: string,
  lang: string,
  isReview: boolean,
): Promise<{
  committed: number;
  failed: number;
  skipped: number;
  aborted: number;
  message: string;
}> {
  if (groups.length === 0) {
    return {
      committed: 0,
      failed: 0,
      skipped: 0,
      aborted: 0,
      message: t(lang, "aggCommit.noHunksFound"),
    };
  }

  await footerManager.setPhase("generateMessage", lang);

  // Review (if requested)
  if (isReview) {
    // Convert CommitGroup[] to Hunk[] for the review UI (backward compat)
    const reviewHunks: Hunk[] = groups.map((g) => ({
      files: [...new Set(g.hunks.map((h) => h.file))],
      message: g.message,
    }));

    const reviewResult = await runHunkReview(ctx, reviewHunks, diff, lang);
    if (reviewResult === null) {
      return {
        committed: 0,
        failed: 0,
        skipped: 0,
        aborted: 0,
        message: t(lang, "review.cancelled"),
      };
    }

    const includedIndices = new Set<number>();
    reviewResult.hunks.forEach((h, i) => {
      if (h.included) includedIndices.add(i);
    });
    const includedGroups = groups.filter((_g, i) =>
      includedIndices.has(i),
    );

    if (includedGroups.length === 0) {
      return {
        committed: 0,
        failed: 0,
        skipped: 0,
        aborted: 0,
        message: t(lang, "review.noHunksSelected"),
      };
    }

    await footerManager.setPhase("commit", lang);
    const commitResult = await commitCommitGroups(
      pi,
      ctx,
      includedGroups,
      diffHunks,
      lang,
    );
    return { ...commitResult, message: "committed" };
  }

  await footerManager.setPhase("commit", lang);
  const result = await commitCommitGroups(pi, ctx, groups, diffHunks, lang);
  return { ...result, message: "committed" };
}

/**
 * Commit using existing diff-based file-level hunk analysis.
 * This is the fallback path when TurnLog is empty or intent analysis fails.
 */
async function commitDiffBasedHunks(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  diff: string,
  lang: string,
  turnLogText: string | undefined,
  isReview: boolean,
): Promise<{
  committed: number;
  failed: number;
  skipped: number;
  aborted: number;
  message: string;
}> {
  const hunks = await analyzeDiff(pi, ctx, diff, lang, turnLogText);

  if (hunks.length === 0) {
    return {
      committed: 0,
      failed: 0,
      skipped: 0,
      aborted: 0,
      message: t(lang, "aggCommit.noHunksFound"),
    };
  }

  await footerManager.setPhase("generateMessage", lang);
  const processed = processHunks(hunks);

  if (processed.length === 0) {
    return {
      committed: 0,
      failed: 0,
      skipped: 0,
      aborted: 0,
      message: t(lang, "aggCommit.noHunksFound"),
    };
  }

  if (isReview) {
    const reviewResult = await runHunkReview(ctx, processed, diff, lang);
    if (reviewResult === null) {
      return {
        committed: 0,
        failed: 0,
        skipped: 0,
        aborted: 0,
        message: t(lang, "review.cancelled"),
      };
    }
    const includedHunks = reviewResult.hunks
      .filter((h) => h.included)
      .map((h) => ({
        files: h.files,
        message: h.message,
      }));
    if (includedHunks.length === 0) {
      return {
        committed: 0,
        failed: 0,
        skipped: 0,
        aborted: 0,
        message: t(lang, "review.noHunksSelected"),
      };
    }
    await footerManager.setPhase("commit", lang);
    const result = await commitHunks(pi, ctx, includedHunks, lang);
    return { ...result, message: "committed" };
  }

  await footerManager.setPhase("commit", lang);
  const result = await commitHunks(pi, ctx, processed, lang);
  return { ...result, message: "committed" };
}
