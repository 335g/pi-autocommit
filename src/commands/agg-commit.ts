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
import { t } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import { footerManager } from "../utils/footer-manager.js";

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

  if (/--help/.test(args)) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        t(lang,
          "aggCommit.help",
        ),
        "info",
      );
    }
    return;
  }

  // Parse language argument (temporary override, does not save)
  const langArg = parseLangArg(args);
  const runLang = langArg ?? lang;
  if (langArg) {
    ctx.ui.notify(`Language set to: ${langArg} (this run only)`, "info");
  }

  if (!ctx.hasUI) {
    return;
  }

  if (footerManager.isRunning()) {
    ctx.ui.notify(
      t(runLang,
        "aggCommit.alreadyRunning",
      ),
      "warning",
    );
    return;
  }

  await footerManager.setRunning("agg-commit", "prepare", runLang);

  try {
    const preCheck = await ensureReadyToCommit(pi, ctx.cwd);
    if (preCheck) {
      await footerManager.clearRunning();
      ctx.ui.notify(
        preCheck === "not_git_repo"
          ? "Not a git repository"
          : "No changes to commit",
        preCheck === "not_git_repo" ? "warning" : "info",
      );
      return;
    }

    // Snapshot changes via stash to freeze the diff
    await footerManager.setPhase("collectDiff", runLang);
    const diff = await collectDiff(pi, ctx.cwd);
    if (diff === null) {
      await footerManager.clearRunning();
      ctx.ui.notify("Failed to stash changes", "warning");
      return;
    }
    if (!diff.trim()) {
      await footerManager.clearRunning();
      ctx.ui.notify("No changes to commit", "info");
      return;
    }

    // Analyze diff into logical hunks
    await footerManager.setPhase("analyze", runLang);
    let hunks = await analyzeDiff(pi, ctx, diff, runLang);
    if (hunks.length === 0) {
      await footerManager.clearRunning();
      ctx.ui.notify("No hunks found to commit", "info");
      return;
    }

    // Sanitize, deduplicate, and filter hunks
    await footerManager.setPhase("generateMessage", runLang);
    hunks = processHunks(hunks);

    // Stage and commit each hunk
    await footerManager.setPhase("commit", runLang);
    let committedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i];
      await footerManager.setCommitProgress(i + 1, hunks.length);

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
    await footerManager.clearRunning();
  }
}
