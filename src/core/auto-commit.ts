/**
 * Auto-commit logic for agent_end event handler
 *
 * Automatically commits changes after assistant response when enabled.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentEndEvent } from "../types.js";
import {
  isAggCommitRunning,
  setAggCommitRunning,
} from "../commands/agg-commit.js";
import { isJapanese } from "../utils/lang.js";
import { getAutoAggCommit, getLanguage } from "../utils/settings.js";
import { updateAutoAggCommitStatus } from "../utils/status.js";
import { generateAutoCommitMessage } from "./auto-commit-message.js";
import {
  hasChanges,
  isGitRepository,
  resetStaging,
  stageFiles,
} from "./git.js";

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

  if (isAggCommitRunning) {
    return;
  }

  const autoCommitEnabled = getAutoAggCommit(ctx.cwd);

  // Always update footer with clean/changed status (even when disabled)
  await updateAutoAggCommitStatus(pi, ctx.ui, autoCommitEnabled, ctx.cwd);

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

  const STATUS_ID = "pi-git-agg-commit";
  const lang = getLanguage(ctx.cwd);
  const ja = isJapanese(lang);

  setAggCommitRunning(true);
  ctx.ui.setStatus(
    STATUS_ID,
    ja
      ? "[pi-git: auto-commit] コミットメッセージ生成中..."
      : "[pi-git: auto-commit] Generating commit message...",
  );

  try {
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
      ctx.ui.setStatus(STATUS_ID, "");
      return;
    }

    const messages = event.messages || [];
    const commitMessage = await generateAutoCommitMessage(
      pi,
      ctx,
      messages,
      changedFiles,
    );

    ctx.ui.setStatus(
      STATUS_ID,
      ja
        ? "[pi-git: auto-commit] コミット実行中..."
        : "[pi-git: auto-commit] Committing...",
    );

    await stageFiles(pi, changedFiles, ctx.cwd);
    const { code: exitCode, stderr } = await pi.exec(
      "git",
      ["commit", "-m", commitMessage],
      { cwd: ctx.cwd },
    );

    if (exitCode !== 0) {
      await resetStaging(pi, ctx.cwd);
      ctx.ui.notify(
        ja ? `コミットに失敗しました: ${stderr}` : `Commit failed: ${stderr}`,
        "warning",
      );
    } else {
      ctx.ui.notify(
        ja
          ? `コミットを作成しました: ${commitMessage}`
          : `Created commit: ${commitMessage}`,
        "info",
      );
    }
  } finally {
    // Update footer to reflect post-commit state
    await updateAutoAggCommitStatus(pi, ctx.ui, autoCommitEnabled, ctx.cwd);
    setAggCommitRunning(false);
  }
}
