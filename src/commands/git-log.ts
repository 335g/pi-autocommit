/**
 * /git-log command
 *
 * Display git log in oneline format.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getLog, isGitRepository } from "../core/git.js";
import { isJapanese } from "../utils/lang.js";
import { getSettings } from "../utils/settings.js";

const DEFAULT_MAX_COUNT = 20;

export async function handleGitLog(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const lang = getSettings(ctx.cwd).lang ?? "en";
  const ja = isJapanese(lang);

  const tokens = args.trim().split(/\s+/).filter(Boolean);

  // Parse flags
  let all = false;
  let graph = false;
  let help = false;
  let maxCount: number | "all" = DEFAULT_MAX_COUNT;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--all") {
      all = true;
    } else if (token === "--graph") {
      graph = true;
    } else if (token === "--help" || token === "-h") {
      help = true;
    } else if (token === "-n") {
      const next = tokens[i + 1];
      if (!next) {
        ctx.ui.notify(
          ja ? "-n には数値が必要です" : "-n requires a number",
          "warning",
        );
        return;
      }
      if (next === "all") {
        maxCount = "all";
      } else {
        const parsed = Number.parseInt(next, 10);
        if (Number.isNaN(parsed) || parsed <= 0) {
          ctx.ui.notify(
            ja
              ? `-n の値が不正です: ${next}`
              : `Invalid -n value: ${next}`,
            "warning",
          );
          return;
        }
        maxCount = parsed;
      }
      i++; // skip next token
    }
  }

  if (help) {
    const lines = ja
      ? [
          "/git-log [-n <count>] [--all] [--graph] [--help]",
          "",
          "git log を oneline 形式で表示します。",
          "",
          "フラグ:",
          "  -n <count>  表示するコミット数 (デフォルト: 20, 'all' で全件)",
          "  --all       全ブランチのログを表示",
          "  --graph     ASCII グラフを表示",
          "  --help, -h  このヘルプを表示",
        ]
      : [
          "/git-log [-n <count>] [--all] [--graph] [--help]",
          "",
          "Display git log in oneline format.",
          "",
          "Flags:",
          "  -n <count>  Number of commits to show (default: 20, 'all' for all)",
          "  --all       Show logs from all branches",
          "  --graph     Show ASCII graph",
          "  --help, -h  Show this help message",
        ];
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  if (!(await isGitRepository(pi, ctx.cwd))) {
    ctx.ui.notify(
      ja ? "Gitリポジトリではありません" : "Not a git repository",
      "warning",
    );
    return;
  }

  try {
    const log = await getLog(pi, { maxCount, all, graph }, ctx.cwd);
    if (!log.trim()) {
      ctx.ui.notify(
        ja ? "コミット履歴がありません" : "No commit history",
        "info",
      );
      return;
    }
    ctx.ui.notify(log.trimEnd(), "info");
  } catch (error) {
    ctx.ui.notify(
      ja
        ? `git log の取得に失敗しました: ${error instanceof Error ? error.message : String(error)}`
        : `Failed to get git log: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}
