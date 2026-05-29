/**
 * /git-agg-commit command
 *
 * Automatically analyzes git diff, splits into logical hunks,
 * generates Conventional Commits messages, stages, and commits.
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
import { isJapanese } from "../utils/lang.js";
import { getAutoAggCommit, getLanguage } from "../utils/settings.js";
import {
  clearAutoAggCommitStatus,
  phaseStatusText,
  restoreAutoAggCommitStatus,
} from "../utils/status.js";

export let isAggCommitRunning = false;

/** Set the agg-commit running flag from external modules */
export function setAggCommitRunning(value: boolean): void {
  isAggCommitRunning = value;
}

const STATUS_ID = "pi-git-agg-commit";

function parseLangArg(args: string): string | undefined {
  const match = args.match(/--lang(?:uage)?[=\s]+(\S+)/);
  return match?.[1];
}

export async function handleAggCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  const lang = getLanguage(ctx.cwd);
  const ja = isJapanese(lang);

  if (/--help/.test(args)) {
    const lines = ja
      ? [
          "/git-agg-commit [--lang=<lang>] [--help]",
          "",
          "オプション:",
          "  --lang=<lang>  一時的に言語を上書き（保存されません）",
          "  --help         このヘルプを表示",
        ]
      : [
          "/git-agg-commit [--lang=<lang>] [--help]",
          "",
          "Options:",
          "  --lang=<lang>  Temporarily override language (not saved)",
          "  --help         Show this help message",
        ];
    if (ctx.hasUI) {
      ctx.ui.notify(lines.join("\n"), "info");
    }
    return;
  }

  // Parse language argument (temporary override, does not save)
  const langArg = parseLangArg(args);
  let runLang = lang;
  if (langArg) {
    runLang = langArg;
    ctx.ui.notify(`Language set to: ${langArg} (this run only)`, "info");
  }

  if (!ctx.hasUI) {
    return;
  }

  if (isAggCommitRunning) {
    ctx.ui.notify(
      isJapanese(runLang)
        ? "git-agg-commit 実行中です。完了してから再度実行してください。"
        : "git-agg-commit is already running. Please wait for it to complete.",
      "warning",
    );
    return;
  }

  isAggCommitRunning = true;
  const autoCommit = getAutoAggCommit(ctx.cwd);

  // Hide the persistent auto-commit indicator while agg-commit runs
  // to avoid duplicate status display
  if (autoCommit) {
    clearAutoAggCommitStatus(ctx.ui);
  }

  try {
    ctx.ui.setStatus(STATUS_ID, phaseStatusText(runLang, "prepare", autoCommit));

    const preCheck = await ensureReadyToCommit(pi, ctx.cwd);
    if (preCheck) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify(
        preCheck === "not_git_repo"
          ? "Not a git repository"
          : "No changes to commit",
        preCheck === "not_git_repo" ? "warning" : "info",
      );
      return;
    }

    // Snapshot changes via stash to freeze the diff
    ctx.ui.setStatus(STATUS_ID, phaseStatusText(runLang, "collectDiff", autoCommit));
    const diff = await collectDiff(pi, ctx.cwd);
    if (diff === null) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify("Failed to stash changes", "warning");
      return;
    }
    if (!diff.trim()) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify("No changes to commit", "info");
      return;
    }

    // Analyze diff into logical hunks
    ctx.ui.setStatus(STATUS_ID, phaseStatusText(runLang, "analyze", autoCommit));
    let hunks = await analyzeDiff(pi, ctx, diff);
    if (hunks.length === 0) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify("No hunks found to commit", "info");
      return;
    }

    // Sanitize, deduplicate, and filter hunks
    ctx.ui.setStatus(
      STATUS_ID,
      phaseStatusText(runLang, "generateMessage", autoCommit),
    );
    hunks = processHunks(hunks);

    // Stage and commit each hunk
    ctx.ui.setStatus(STATUS_ID, phaseStatusText(runLang, "commit", autoCommit));
    let committedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const hunk of hunks) {
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
        try {
          await resetStaging(pi, ctx.cwd);
        } catch {
          // Ignore reset errors
        }
        const detail = stderr.trim() ? ` — ${stderr.trim()}` : "";
        ctx.ui.notify(
          `Commit failed for "${hunk.message}" (exit code ${exitCode}).${detail} Staging has been reset.`,
          "warning",
        );
        failedCount++;
        continue;
      }

      committedCount++;
    }

    // Notify completion
    if (!autoCommit) {
      ctx.ui.setStatus(STATUS_ID, "");
    }
    const parts: string[] = [];
    if (committedCount > 0)
      parts.push(
        `Created ${committedCount} commit${committedCount > 1 ? "s" : ""}`,
      );
    if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
    if (failedCount > 0) parts.push(`${failedCount} failed`);

    if (parts.length === 0) {
      ctx.ui.notify("All commits failed", "error");
    } else if (failedCount > 0) {
      ctx.ui.notify(parts.join(", "), "warning");
    } else {
      ctx.ui.notify(parts.join(", "), "info");
    }
  } finally {
    isAggCommitRunning = false;
    if (autoCommit) {
      restoreAutoAggCommitStatus(ctx.ui, ctx.cwd);
    }
  }
}
