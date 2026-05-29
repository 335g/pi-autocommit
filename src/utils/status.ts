import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
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
 * Shows a label when enabled, clears it when disabled.
 */
export function updateAutoAggCommitStatus(
  ui: ExtensionUIContext,
  enabled: boolean,
  cwd?: string,
): void {
  const lang = getSettings(cwd).lang ?? "en";
  if (enabled) {
    const text = isJapanese(lang)
      ? "[pi-git] auto-commit: 有効"
      : "[pi-git] auto-commit: ON";
    ui.setStatus(AUTO_AGG_COMMIT_STATUS_KEY, text);
  } else {
    ui.setStatus(AUTO_AGG_COMMIT_STATUS_KEY, undefined);
  }
}

/** Clear the auto-agg-commit status from footer (e.g., before running agg-commit). */
export function clearAutoAggCommitStatus(ui: ExtensionUIContext): void {
  ui.setStatus(AUTO_AGG_COMMIT_STATUS_KEY, undefined);
}

/** Restore the auto-agg-commit status based on current settings. */
export function restoreAutoAggCommitStatus(
  ui: ExtensionUIContext,
  cwd?: string,
): void {
  updateAutoAggCommitStatus(ui, getAutoAggCommit(cwd), cwd);
}
