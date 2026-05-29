/**
 * /git-diff command
 *
 * Interactive diff review with sequential hunk approval.
 * Allows reviewing AI-generated hunks, viewing diffs, editing messages,
 * and committing approved hunks one at a time.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  analyzeDiff,
  parseDiffStats,
  processHunks,
  splitDiffByFile,
} from "../core/diff-analyzer.js";
import {
  collectDiff,
  ensureReadyToCommit,
  resetStaging,
  stageFiles,
} from "../core/git.js";
import { isJapanese } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import { phaseStatusText } from "../utils/status.js";
import { isAggCommitRunning } from "./agg-commit.js";
import {
  HunkReviewComponent,
  type HunkReviewAction,
} from "../tui/hunk-review.js";
import type { FileStats, Hunk } from "../types.js";

const STATUS_ID = "pi-git-diff";

/**
 * Review a single hunk using the TUI component
 */
async function reviewHunk(
  ctx: ExtensionCommandContext,
  hunk: Hunk,
  hunkIndex: number,
  totalHunks: number,
  fileStats: Map<string, FileStats>,
  fileDiffs: Map<string, string[]>,
): Promise<HunkReviewAction> {
  if (!ctx.hasUI) {
    return { type: "quit" };
  }

  return await ctx.ui.custom<HunkReviewAction>((tui, theme, _keybindings, done) => {
    const component = new HunkReviewComponent(
      hunk,
      hunkIndex,
      totalHunks,
      fileStats,
      fileDiffs,
      tui,
      theme,
      done,
    );
    return component;
  });
}

export async function handleGitDiff(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const lang = getLanguage(ctx.cwd);
  const ja = isJapanese(lang);

  if (/--help/.test(args)) {
    const lines = ja
      ? [
          "/git-diff [--help]",
          "",
          "AIが生成したhunkを対話的にレビューし、承認したものをコミットします。",
          "",
          "オプション:",
          "  --help  このヘルプを表示",
          "",
          "操作:",
          "  ↑↓        ファイル間を移動",
          "  Enter     選択したファイルのdiffを表示",
          "  a         hunkを承認してコミット",
          "  e         コミットメッセージを編集",
          "  s         hunkをスキップ",
          "  x         選択したファイルをhunkから除外",
          "  q         終了",
        ]
      : [
          "/git-diff [--help]",
          "",
          "Interactively review AI-generated hunks and commit approved ones.",
          "",
          "Options:",
          "  --help  Show this help message",
          "",
          "Controls:",
          "  ↑↓        Navigate between files",
          "  Enter     View diff for selected file",
          "  a         Approve and commit hunk",
          "  e         Edit commit message",
          "  s         Skip hunk",
          "  x         Exclude selected file from hunk",
          "  q         Quit",
        ];
    if (ctx.hasUI) {
      ctx.ui.notify(lines.join("\n"), "info");
    }
    return;
  }

  if (!ctx.hasUI) {
    return;
  }

  // Check if agg-commit is running
  if (isAggCommitRunning) {
    ctx.ui.notify(
      ja
        ? "git-agg-commit 実行中です。完了してから再度実行してください。"
        : "git-agg-commit is already running. Please wait for it to complete.",
      "warning",
    );
    return;
  }

  ctx.ui.setStatus(STATUS_ID, phaseStatusText(lang, "prepare"));

  try {
    const preCheck = await ensureReadyToCommit(pi, ctx.cwd);
    if (preCheck) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify(
        preCheck === "not_git_repo"
          ? ja ? "Gitリポジトリではありません" : "Not a git repository"
          : ja ? "コミットする変更がありません" : "No changes to commit",
        preCheck === "not_git_repo" ? "warning" : "info",
      );
      return;
    }

    // Collect diff via stash to freeze the working tree
    ctx.ui.setStatus(STATUS_ID, phaseStatusText(lang, "collectDiff"));
    const diff = await collectDiff(pi, ctx.cwd);
    if (diff === null) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify(
        ja ? "変更のstashに失敗しました" : "Failed to stash changes",
        "warning",
      );
      return;
    }
    if (!diff.trim()) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify(
        ja ? "コミットする変更がありません" : "No changes to commit",
        "info",
      );
      return;
    }

    // Parse diff by file
    const fileDiffs = splitDiffByFile(diff);
    const fileStats = parseDiffStats(diff);

    // Analyze diff into hunks
    ctx.ui.setStatus(STATUS_ID, phaseStatusText(lang, "analyze"));
    let hunks = await analyzeDiff(pi, ctx, diff);
    if (hunks.length === 0) {
      ctx.ui.setStatus(STATUS_ID, "");
      ctx.ui.notify(
        ja ? "コミット可能なhunkがありません" : "No hunks found to commit",
        "info",
      );
      return;
    }

    // Sanitize, deduplicate, and filter hunks
    hunks = processHunks(hunks);

    ctx.ui.setStatus(STATUS_ID, "");

    // Review each hunk sequentially
    const unassignedFiles: string[] = [];
    let committedCount = 0;
    let skippedCount = 0;

    let quitRequested = false;

    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i];
      let currentMessage = hunk.message;

      // Review loop (for message editing)
      while (true) {
        const action = await reviewHunk(
          ctx,
          { ...hunk, message: currentMessage },
          i,
          hunks.length,
          fileStats,
          fileDiffs,
        );

        if (action.type === "quit") {
          // Add current and remaining hunks' files to unassigned
          for (let j = i; j < hunks.length; j++) {
            unassignedFiles.push(...hunks[j].files);
          }
          quitRequested = true;
          break;
        }

        if (action.type === "edit_message") {
          // Edit message using pi's built-in input dialog (IME-supported)
          const newMessage = await ctx.ui.input(
            ja ? "コミットメッセージを編集:" : "Edit commit message:",
            action.currentMessage,
          );
          if (newMessage && newMessage.trim()) {
            currentMessage = newMessage.trim();
          }
          // Continue loop to re-show the hunk with updated message
          continue;
        }

        if (action.type === "skip") {
          // Add non-excluded files to unassigned
          const files = hunk.files.filter(
            (f) => !action.excludedFiles.includes(f),
          );
          unassignedFiles.push(...files, ...action.excludedFiles);
          skippedCount++;
          break;
        }

        if (action.type === "approve") {
          // Stage and commit non-excluded files
          const files = hunk.files.filter(
            (f) => !action.excludedFiles.includes(f),
          );

          if (files.length === 0) {
            ctx.ui.notify(
              ja
                ? "コミットするファイルがありません"
                : "No files to commit",
              "warning",
            );
            break;
          }

          try {
            await stageFiles(pi, files, ctx.cwd);
          } catch (error) {
            ctx.ui.notify(
              ja
                ? `ファイルのステージに失敗しました: ${error instanceof Error ? error.message : String(error)}`
                : `Failed to stage files: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
            break;
          }

          const { code: exitCode, stderr } = await pi.exec(
            "git",
            ["commit", "-m", action.message],
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
              ja
                ? `コミットに失敗しました: "${action.message}" (exit code ${exitCode})${detail}。ステージをリセットしました。`
                : `Commit failed for "${action.message}" (exit code ${exitCode}).${detail} Staging has been reset.`,
              "warning",
            );
            break;
          }

          committedCount++;

          // Add excluded files to unassigned
          unassignedFiles.push(...action.excludedFiles);
          break;
        }
      }

      if (quitRequested) break;
    }

    // Show summary
    const parts: string[] = [];
    if (committedCount > 0) {
      parts.push(
        ja
          ? `${committedCount}個のhunkをコミットしました`
          : `Committed ${committedCount} hunk${committedCount > 1 ? "s" : ""}`,
      );
    }
    if (skippedCount > 0) {
      parts.push(
        ja
          ? `${skippedCount}個のhunkをスキップしました`
          : `Skipped ${skippedCount} hunk${skippedCount > 1 ? "s" : ""}`,
      );
    }

    if (parts.length > 0) {
      ctx.ui.notify(parts.join(", "), "info");
    }

    // Show unassigned files
    if (unassignedFiles.length > 0) {
      const lines = ja
        ? [
            "",
            `⚠ ${unassignedFiles.length}個のファイルが未割り当てです:`,
            ...unassignedFiles.map((f) => `  ${f}`),
          ]
        : [
            "",
            `⚠ ${unassignedFiles.length} file${unassignedFiles.length > 1 ? "s" : ""} remain unassigned:`,
            ...unassignedFiles.map((f) => `  ${f}`),
          ];
      ctx.ui.notify(lines.join("\n"), "info");
    }
  } finally {
    ctx.ui.setStatus(STATUS_ID, "");
  }
}
