import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { isJapanese } from "./lang.js";
import { getAutoAggCommit, getSettings } from "./settings.js";

/**
 * Generate localized status text for each phase of the commit workflow.
 */
export function phaseStatusText(
  lang: string,
  key: "prepare" | "collectDiff" | "analyze" | "generateMessage" | "commit",
  autoCommit = false,
): string {
  const ja = isJapanese(lang);
  const prefix = autoCommit ? "[pi-git: auto-commit]" : "[pi-git]";
  switch (key) {
    case "prepare":
      return ja ? `${prefix} 準備中...` : `${prefix} Preparing...`;
    case "collectDiff":
      return ja ? `${prefix} diff収集中...` : `${prefix} Collecting diff...`;
    case "analyze":
      return ja ? `${prefix} hunk解析中...` : `${prefix} Analyzing hunks...`;
    case "generateMessage":
      return ja
        ? `${prefix} コミットメッセージ生成中...`
        : `${prefix} Generating messages...`;
    case "commit":
      return ja ? `${prefix} コミット実行中...` : `${prefix} Committing...`;
  }
}

const AUTO_AGG_COMMIT_STATUS_KEY = "pi-git-agg-commit";

/**
 * Update the footer status indicator for auto-agg-commit.
 * Shows on/off combined with clean/changed state when inside a git repo,
 * or on/off only when outside a git repo.
 */
export async function updateAutoAggCommitStatus(
  pi: ExtensionAPI,
  ui: ExtensionUIContext,
  enabled: boolean,
  cwd?: string,
): Promise<void> {
  const onOff = enabled ? "on" : "off";

  // Check if inside a git repository
  const { code } = await pi.exec("git", ["rev-parse", "--git-dir"], { cwd });
  if (code !== 0) {
    ui.setStatus(AUTO_AGG_COMMIT_STATUS_KEY, `auto-commit: ${onOff}`);
    return;
  }

  // Evaluate clean/changed state
  const { stdout } = await pi.exec("git", ["status", "--porcelain"], { cwd });
  const state = stdout.trim().length > 0 ? "changed" : "clean";
  ui.setStatus(
    AUTO_AGG_COMMIT_STATUS_KEY,
    `auto-commit: ${onOff} (${state})`,
  );
}

/** Clear the auto-agg-commit status from footer (e.g., before running agg-commit). */
export function clearAutoAggCommitStatus(ui: ExtensionUIContext): void {
  ui.setStatus(AUTO_AGG_COMMIT_STATUS_KEY, undefined);
}

/** Restore the auto-agg-commit status based on current settings. */
export async function restoreAutoAggCommitStatus(
  pi: ExtensionAPI,
  ui: ExtensionUIContext,
  cwd?: string,
): Promise<void> {
  await updateAutoAggCommitStatus(pi, ui, getAutoAggCommit(cwd), cwd);
}
