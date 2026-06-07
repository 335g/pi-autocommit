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

  try {
    await footerManager.setRunning("agg-commit", "prepare", runLang);

    const preCheck = await ensureReadyToCommit(pi, ctx.cwd);
    if (preCheck) {
      const messages: Record<string, { text: string; level: "warning" | "info" | "error" }> = {
        not_git_repo: { text: "Not a git repository", level: "warning" },
        merge_conflict: { text: "Merge conflicts detected. Resolve conflicts before committing.", level: "error" },
        no_changes: { text: "No changes to commit", level: "info" },
      };
      const entry = messages[preCheck];
      ctx.ui.notify(entry.text, entry.level);
      return;
    }

    // Snapshot changes via stash (SHA-based diff capture — no reflog race)
    await footerManager.setPhase("collectDiff", runLang);
    const diff = await collectDiff(pi, ctx.cwd);
    if (diff === null) {
      ctx.ui.notify("Failed to stash changes", "warning");
      return;
    }
    if (!diff.trim()) {
      ctx.ui.notify("No changes to commit", "info");
      return;
    }

    // Analyze diff into logical hunks
    await footerManager.setPhase("analyze", runLang);
    let hunks = await analyzeDiff(pi, ctx, diff, runLang);
    if (hunks.length === 0) {
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

      // Ensure clean staging area before each hunk
      try {
        await resetStaging(pi, ctx.cwd);
      } catch {
        ctx.ui.notify("Failed to reset staging area, aborting batch", "error");
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
          `Commit failed for "${hunk.message}" (exit code ${exitCode}).${detail}`,
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
    // Final cleanup: ensure staging area is clean
    try { await resetStaging(pi, ctx.cwd); } catch { /* ignore */ }
    await footerManager.clearRunning();
  }
}
