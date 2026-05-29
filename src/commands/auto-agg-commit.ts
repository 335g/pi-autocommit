/**
 * /git-auto-agg-commit command
 *
 * Toggle auto-agg-commit feature: automatically run git-agg-commit
 * after the assistant finishes responding when there are changes.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { isJapanese } from "../utils/lang.js";
import {
  getAutoAggCommit,
  getLocalSettingsPath,
  getSettings,
  saveGlobalSettings,
  saveLocalSettings,
} from "../utils/settings.js";
import { footerManager } from "../utils/footer-manager.js";

function getStatusMessage(enabled: boolean, lang: string): string {
  const ja = isJapanese(lang);
  if (enabled) {
    return ja
      ? "[pi-git] 自動 git-agg-commit は有効です"
      : "[pi-git] Auto git-agg-commit is enabled";
  }
  return ja
    ? "[pi-git] 自動 git-agg-commit は無効です"
    : "[pi-git] Auto git-agg-commit is disabled";
}

function _getToggledMessage(enabled: boolean, lang: string): string {
  const ja = isJapanese(lang);
  if (enabled) {
    return ja
      ? "[pi-git] 自動 git-agg-commit を有効にしました"
      : "[pi-git] Auto git-agg-commit enabled";
  }
  return ja
    ? "[pi-git] 自動 git-agg-commit を無効にしました"
    : "[pi-git] Auto git-agg-commit disabled";
}

export async function handleAutoAggCommit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const trimmed = args.trim().toLowerCase();
  const current = getAutoAggCommit();
  const lang = getSettings(ctx.cwd).lang ?? "en";

  if (trimmed === "--help") {
    const ja = isJapanese(lang);
    const lines = ja
      ? [
          "/git-auto-agg-commit [on|off|toggle] [--help]",
          "",
          "サブコマンド:",
          "  on      自動 git-agg-commit を有効にする",
          "  off     自動 git-agg-commit を無効にする",
          "  toggle  自動 git-agg-commit の有効/無効を切り替える",
          "",
          "フラグ:",
          "  --help  このヘルプを表示",
          "",
          "引数を省略すると、現在の状態を表示します。",
        ]
      : [
          "/git-auto-agg-commit [on|off|toggle] [--help]",
          "",
          "Subcommands:",
          "  on      Enable auto git-agg-commit",
          "  off     Disable auto git-agg-commit",
          "  toggle  Toggle auto git-agg-commit",
          "",
          "Flags:",
          "  --help  Show this help message",
          "",
          "When called without arguments, shows the current status.",
        ];
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  let next: boolean;
  switch (trimmed) {
    case "on":
      next = true;
      break;
    case "off":
      next = false;
      break;
    case "toggle":
      next = !current;
      break;
    case "":
      ctx.ui.notify(getStatusMessage(current, lang), "info");
      return;
    default: {
      const ja = isJapanese(lang);
      ctx.ui.notify(
        ja
          ? "[pi-git] 引数が不正です。on, off, toggle のいずれかを指定してください"
          : '[pi-git] Invalid argument. Use "on", "off", or "toggle"',
        "warning",
      );
      return;
    }
  }

  const localPath = getLocalSettingsPath(ctx.cwd);
  if (localPath) {
    saveLocalSettings({ auto_agg_commit: next }, ctx.cwd);
  } else {
    saveGlobalSettings({ auto_agg_commit: next });
  }

  await footerManager.refresh();

  const ja = isJapanese(lang);
  if (localPath) {
    ctx.ui.notify(
      ja
        ? `[pi-git] 自動 git-agg-commit を${next ? "有効" : "無効"}にしました（ローカル設定）`
        : `[pi-git] Auto git-agg-commit ${next ? "enabled" : "disabled"} (local config)`,
      "info",
    );
  } else {
    ctx.ui.notify(
      ja
        ? `[pi-git] 自動 git-agg-commit を${next ? "有効" : "無効"}にしました（グローバル設定 — Gitリポジトリ外のため）`
        : `[pi-git] Auto git-agg-commit ${next ? "enabled" : "disabled"} (global config — outside git repo)`,
      "info",
    );
  }
}
