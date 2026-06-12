/**
 * Auto-commit logic for agent_end event handler
 *
 * Automatically commits changes after assistant response when enabled.
 */

import { readFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentEndEvent } from "../types.js";
import { t } from "../utils/lang.js";
import {
  getAutoAggCommit,
  getAutoAggCommitSkipConfirmFiles,
  getAutoAggCommitSkipConfirmLines,
  getLanguage,
} from "../utils/settings.js";
import { footerManager } from "../utils/footer-manager.js";
import { generateAutoCommitMessage } from "./auto-commit-message.js";
import { createConfirmComponent } from "./auto-commit-confirm.js";
import {
  hasChanges,
  isGitRepository,
  resetStaging,
  stageFiles,
} from "./git.js";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

interface ChangedLinesResult {
  totalLines: number;
  untrackedFiles: string[];
  hasBinary: boolean;
}

/**
 * Handle auto-commit after agent response
 */
export async function handleAutoCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: AgentEndEvent,
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  if (footerManager.isRunning()) {
    return;
  }

  const autoCommitEnabled = getAutoAggCommit(ctx.cwd);

  // Always update footer with clean/changed status (even when disabled)
  await footerManager.refresh();

  // If auto-commit is disabled, we're done
  if (!autoCommitEnabled) {
    return;
  }

  if (!(await isGitRepository(pi))) {
    return;
  }

  if (!(await hasChanges(pi))) {
    return;
  }

  const lang = getLanguage(ctx.cwd);

  // ── Gather change info (before setRunning, so confirmation can appear first) ──

  const { stdout: statusOutput } = await pi.exec(
    "git",
    ["status", "--short"],
    { cwd: ctx.cwd },
  );

  const changedFiles = statusOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  if (changedFiles.length === 0) {
    return;
  }

  // Capture git diff for AI context (staged + unstaged changes vs HEAD)
  const { stdout: diffOutput, code: diffCode } = await pi.exec(
    "git",
    ["diff", "HEAD", "--", ...changedFiles],
    { cwd: ctx.cwd },
  );
  const diff = diffCode === 0 ? diffOutput : "";

  // ── Count changed lines (for confirmation dialog) ──
  const countResult = await countChangedLines(
    pi,
    ctx.cwd,
    statusOutput,
    changedFiles,
  );

  // ── Skip confirmation for very small, non-binary changes ──
  const skipFiles = getAutoAggCommitSkipConfirmFiles(ctx.cwd);
  const skipLines = getAutoAggCommitSkipConfirmLines(ctx.cwd);
  const smallChange =
    !countResult.hasBinary &&
    ((skipFiles > 0 && changedFiles.length <= skipFiles) ||
      (skipLines > 0 && countResult.totalLines <= skipLines));

  // ── Confirmation dialog (skipped for small changes; default = skip) ──
  if (smallChange) {
    ctx.ui.notify(
      t(lang, "autoCommit.skippedSmallChange", {
        files: String(changedFiles.length),
        lines: String(countResult.totalLines),
      }),
      "info",
    );
  } else {
    const confirmed = await showConfirmDialog(ctx, {
      changedFiles,
      untrackedFiles: countResult.untrackedFiles,
      totalLines: countResult.totalLines,
      hasBinary: countResult.hasBinary,
      lang,
    });
    if (!confirmed) {
      ctx.ui.notify(t(lang, "autoCommit.confirmSkipped"), "info");
      return;
    }
  }

  // ── Proceed with auto-commit ──

  try {
    await footerManager.setRunning("auto-commit", "generateMessage");

    const messages = event.messages || [];
    const commitMessage = await generateAutoCommitMessage(
      pi,
      ctx,
      messages,
      changedFiles,
      diff,
    );

    await footerManager.setPhase("commit");

    await stageFiles(pi, changedFiles, ctx.cwd);
    const { code: exitCode, stderr } = await pi.exec(
      "git",
      ["commit", "-m", commitMessage],
      { cwd: ctx.cwd },
    );

    if (exitCode !== 0) {
      await resetStaging(pi, ctx.cwd);
      ctx.ui.notify(
        t(lang,
          "autoCommit.commitFailed",
          { error: stderr },
        ),
        "warning",
      );
    } else {
      ctx.ui.notify(
        t(lang,
          "autoCommit.commitCreated",
          { message: commitMessage },
        ),
        "info",
      );
    }
  } finally {
    await footerManager.clearRunning();
  }
}

// ───────────────────────────────────────────────
// Helper: count changed lines from git diff
// ───────────────────────────────────────────────

/**
 * Count total changed lines across all changed files.
 *
 * Uses `git diff --numstat HEAD` for tracked files.
 * For untracked (new) files, counts lines directly.
 */
async function countChangedLines(
  pi: ExtensionAPI,
  cwd: string,
  statusOutput: string,
  changedFiles: string[],
): Promise<ChangedLinesResult> {
  let totalLines = 0;
  let hasBinary = false;

  // 1. Tracked changes via --numstat
  // Falls back gracefully if HEAD doesn't exist (first commit).
  const { stdout: numstatOut } = await pi.exec(
    "git",
    ["diff", "--numstat", "HEAD", "--", ...changedFiles],
    { cwd },
  );

  if (numstatOut.trim()) {
    for (const line of numstatOut.trim().split("\n")) {
      if (!line) continue;
      const [added, deleted] = line.split("\t");
      if (added === "-" || deleted === "-") {
        // Binary file
        hasBinary = true;
        continue;
      }
      totalLines +=
        (added ? parseInt(added, 10) || 0 : 0) +
        (deleted ? parseInt(deleted, 10) || 0 : 0);
    }
  }

  // 2. Untracked files — count lines directly
  const untrackedFiles = statusOutput
    .split("\n")
    .filter((l) => l.startsWith("?"))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

  if (untrackedFiles.length > 0) {
    // Try wc -l first, fall back to fs.readFileSync
    const { stdout: wcOut, code: wcCode } = await pi.exec(
      "wc",
      ["-l", "--", ...untrackedFiles],
      { cwd },
    );
    if (wcCode === 0 && wcOut.trim()) {
      // wc -l output: " 123 file.ts" or "0 file.ts"
      for (const line of wcOut.trim().split("\n")) {
        const match = line.match(/^\s*(\d+)/);
        if (match) {
          totalLines += parseInt(match[1], 10) || 0;
        }
      }
    } else {
      // wc unavailable — use fs.readFileSync fallback
      for (const file of untrackedFiles) {
        try {
          const content = readFileSync(file, "utf-8");
          totalLines +=
            content.split("\n").length -
            (content.endsWith("\n") ? 1 : 0);
        } catch {
          // Binary or unreadable — mark as binary
          hasBinary = true;
        }
      }
    }
  }

  return { totalLines, untrackedFiles, hasBinary };
}

// ───────────────────────────────────────────────
// Helper: show confirmation dialog
// ───────────────────────────────────────────────

async function showConfirmDialog(
  ctx: ExtensionContext,
  params: {
    changedFiles: string[];
    untrackedFiles: string[];
    totalLines: number;
    hasBinary: boolean;
    lang: string;
  },
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const handle = ctx.ui.custom<boolean>(
      createConfirmComponent({
        changedFiles: params.changedFiles,
        untrackedFiles: params.untrackedFiles,
        totalLines: params.totalLines,
        hasBinary: params.hasBinary,
        lang: params.lang,
      }),
      { overlay: true },
    );

    // ctx.ui.custom returns a Promise that resolves with the result.
    // Forward it to our outer Promise.
    handle.then((result) => resolve(result ?? false));
  });
}
