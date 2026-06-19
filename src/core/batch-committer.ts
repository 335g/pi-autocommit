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
import { turnLog, TurnLog } from "./turn-log.js";
import type { TurnEntry } from "./turn-log.js";
import { resolveModel, isCheapModel } from "./resolve-model.js";
import { sanitizeCommitMessage, generateFallbackMessage } from "./commit-message.js";
import { diagIncr } from "../utils/diagnostics.js";
import type { CommitGroup, DiffHunk, Hunk } from "../types.js";

// ───────────────────────────────────────────────
// Secondary confidence verification
// ───────────────────────────────────────────────

/**
 * Cross-check AI-reported confidence against actual group composition.
 * Called AFTER validateHunkCoverage (so catch-all low-confidence groups
 * from unassigned hunks are included in the calculation).
 *
 * If >50% of hunks are in low-confidence groups but overallConfidence
 * says otherwise, the model is likely overconfident — downgrade.
 */
function verifyConfidence(
  result: { overallConfidence: "high" | "medium" | "low"; groups: CommitGroup[] },
  totalHunks: number,
): { overallConfidence: "high" | "medium" | "low"; groups: CommitGroup[] } {
  if (totalHunks === 0) return result;

  const lowHunkCount = result.groups
    .filter((g) => g.confidence === "low")
    .reduce((sum, g) => sum + g.hunks.length, 0);

  const lowFraction = lowHunkCount / totalHunks;

  if (lowFraction > 0.5 && result.overallConfidence !== "low") {
    diagIncr("confidenceDowngrade_overconfidentModel");
    return { ...result, overallConfidence: "low" };
  }

  if (lowFraction > 0.3 && result.overallConfidence === "high") {
    diagIncr("confidenceDowngrade_highToMedium");
    return { ...result, overallConfidence: "medium" };
  }

  return result;
}

// ───────────────────────────────────────────────
// TurnLog heuristic fallback (deterministic grouping)
// ───────────────────────────────────────────────

/** Minimum co-occurrence count for files to be considered "related" */
const MIN_COOCCURRENCE = 2;

/**
 * Build commit groups deterministically from TurnLog file co-occurrence data.
 * Used when AI-based intent analysis fails.
 */
function buildGroupsFromTurnLog(
  diffHunks: DiffHunk[],
  turnLogInstance: TurnLog,
): CommitGroup[] {
  const entries = turnLogInstance.getEntries();

  // 1. Build file → most-recent-turn-index mapping
  const fileToTurn = new Map<string, number>();
  for (const entry of [...entries].reverse()) {
    for (const file of entry.filesChanged) {
      if (!fileToTurn.has(file)) fileToTurn.set(file, entry.index);
    }
  }

  // 2. Group diff hunks by their turn assignment
  const turnGroups = new Map<number, DiffHunk[]>();
  const unassigned: DiffHunk[] = [];

  for (const hunk of diffHunks) {
    const turn = fileToTurn.get(hunk.file);
    if (turn !== undefined) {
      if (!turnGroups.has(turn)) turnGroups.set(turn, []);
      turnGroups.get(turn)!.push(hunk);
    } else {
      unassigned.push(hunk);
    }
  }

  // 3. For turns with many hunks, sub-group by file co-occurrence
  const cooccurrence = turnLogInstance.getFileCooccurrence();
  const groups: CommitGroup[] = [];

  for (const [, hunks] of turnGroups) {
    if (hunks.length <= 3) {
      groups.push(makeHeuristicGroup(hunks, "medium"));
    } else {
      const clusters = clusterByCooccurrence(hunks, cooccurrence);
      for (const cluster of clusters) {
        groups.push(makeHeuristicGroup(cluster, "low"));
      }
    }
  }

  // 4. Unassigned hunks → catch-all
  if (unassigned.length > 0) {
    groups.push({
      hunks: unassigned.map((h) => ({ globalIndex: h.globalIndex, file: h.file })),
      message: generateFallbackMessage(unassigned.map((h) => h.file)),
      confidence: "low",
      note: "TurnLogに記録のない変更（人手編集の可能性）",
    });
  }

  return groups;
}

/**
 * Cluster hunks by file co-occurrence using greedy connected components.
 * Files that co-occur in ≥MIN_COOCCURRENCE turns are connected.
 */
function clusterByCooccurrence(
  hunks: DiffHunk[],
  cooccurrence: Map<string, number>,
): DiffHunk[][] {
  const uniqueFiles = [...new Set(hunks.map((h) => h.file))];
  if (uniqueFiles.length <= 1) return [hunks];

  // Build adjacency: file → related files (co-occurrence ≥ MIN_COOCCURRENCE)
  const adjacency = new Map<string, Set<string>>();
  for (const file of uniqueFiles) {
    adjacency.set(file, new Set());
  }

  const fileSet = new Set(uniqueFiles);
  for (const [pairKey, count] of cooccurrence) {
    if (count < MIN_COOCCURRENCE) continue;
    const [a, b] = pairKey.split("::");
    if (a && b && fileSet.has(a) && fileSet.has(b)) {
      adjacency.get(a)!.add(b);
      adjacency.get(b)!.add(a);
    }
  }

  // Greedy connected components (BFS from each unvisited node)
  const visited = new Set<string>();
  const componentFiles: string[][] = [];

  for (const file of uniqueFiles) {
    if (visited.has(file)) continue;
    const component: string[] = [];
    const queue = [file];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of adjacency.get(current) || []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    componentFiles.push(component);
  }

  // Map components back to hunks
  return componentFiles.map((files) => {
    const fSet = new Set(files);
    return hunks.filter((h) => fSet.has(h.file));
  });
}

/** Create a CommitGroup from heuristic-clustered hunks (no AI call) */
function makeHeuristicGroup(
  hunks: DiffHunk[],
  confidence: "medium" | "low",
): CommitGroup {
  const files = [...new Set(hunks.map((h) => h.file))];
  const message = generateFallbackMessage(files);
  return {
    hunks: hunks.map((h) => ({ globalIndex: h.globalIndex, file: h.file })),
    message: sanitizeCommitMessage(message, files),
    confidence,
    note:
      confidence === "low"
        ? "TurnLogヒューリスティックによるグループ化（AI未使用）"
        : undefined,
  };
}

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

  // Track whether stored prompts were available for this batch commit
  const entries = turnLog.getEntries();
  let hasStoredSystemPrompt = false;
  let hasStoredUserPrompt = false;
  for (const entry of entries) {
    if (entry.systemPrompt) hasStoredSystemPrompt = true;
    if (entry.rawUserPrompt) hasStoredUserPrompt = true;
  }
  if (hasStoredSystemPrompt) diagIncr("intentPath_storedSystemPromptUsed");
  if (hasStoredUserPrompt) diagIncr("intentPath_storedUserPromptUsed");
  if (!hasStoredSystemPrompt && !hasStoredUserPrompt) {
    diagIncr("intentPath_storedPromptsMissing");
  }

  let result: {
    committed: number;
    failed: number;
    skipped: number;
    aborted: number;
    message: string;
  } | null = null;

  // Try intent-based analysis when TurnLog is available
  if (turnLogText) {
    const model = resolveModel(ctx);

    // Cheap model shortcut: skip AI grouping, go straight to TurnLog heuristic
    if (isCheapModel(model?.id)) {
      diagIncr("cheapModel_skippedAI");
      const cheapDiffHunks = parseDiffHunks(diff);
      const cheapGroups = buildGroupsFromTurnLog(cheapDiffHunks, turnLog);
      if (cheapGroups.length > 0) {
        const validated = validateHunkCoverage(
          cheapGroups,
          cheapDiffHunks.length,
        );
        diagIncr("intentPath_fallback");
        result = await commitIntentGroups(
          pi, ctx, validated, cheapDiffHunks, diff, lang, isReview,
        );
      }
    } else {
      // Full AI pipeline for capable models
      const intentResult = await analyzeDiffIntent(
        pi,
        ctx,
        diff,
        turnLogText,
        lang,
      );

      if (intentResult) {
        const diffHunks = parseDiffHunks(diff);

        // Step 1: validate hunk coverage (adds catch-all groups for unassigned hunks)
        const validated = validateHunkCoverage(
          intentResult.groups,
          diffHunks.length,
        );

        // Step 2: verify self-reported confidence (uses catch-all groups from step 1)
        const verified = verifyConfidence(
          { ...intentResult, groups: validated },
          diffHunks.length,
        );

        if (verified.overallConfidence === "low") {
          // Fall through to TurnLog heuristic below
          ctx.ui.notify(
            t(lang, "diffAnalyzer.intentLowConfidence"),
            "info",
          );
        } else if (verified.overallConfidence === "medium") {
          ctx.ui.notify(
            t(lang, "diffAnalyzer.intentMediumConfidence"),
            "warning",
          );
          diagIncr("intentPath_success");
          result = await commitIntentGroups(
            pi,
            ctx,
            verified.groups,
            diffHunks,
            diff,
            lang,
            isReview,
          );
        } else {
          // high
          diagIncr("intentPath_success");
          result = await commitIntentGroups(
            pi,
            ctx,
            verified.groups,
            diffHunks,
            diff,
            lang,
            isReview,
          );
        }
      }
    }

    // TurnLog heuristic fallback: when AI grouping failed or produced low confidence
    if (!result) {
      const heuristicDiffHunks = parseDiffHunks(diff);
      const heuristicGroups = buildGroupsFromTurnLog(
        heuristicDiffHunks,
        turnLog,
      );
      if (heuristicGroups.length > 0) {
        const validated = validateHunkCoverage(
          heuristicGroups,
          heuristicDiffHunks.length,
        );
        diagIncr("intentPath_fallback");
        result = await commitIntentGroups(
          pi, ctx, validated, heuristicDiffHunks, diff, lang, isReview,
        );
      }
    }
  }

  // Fall back to existing diff-based analysis when:
  // - TurnLog is empty, OR
  // - intent-based analysis returned null AND heuristic produced nothing, OR
  // - overallConfidence was "low" AND heuristic produced nothing
  if (!result) {
    diagIncr("intentPath_diffBased");
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
