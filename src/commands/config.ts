/**
 * /git-config command
 *
 * Get, set, and list pi-git configuration values.
 * Supports both global (~/.config/pi-git/settings.json)
 * and local (<repo>/.pi-git/settings.json) scopes.
 */

import { existsSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { isJapanese } from "../utils/lang.js";
import {
  DEFAULT_SETTINGS,
  GLOBAL_SETTINGS_FILE,
  getLocalSettingsPath,
  getSettings,
  getSettingWithOrigin,
  saveGlobalSettings,
  saveLocalSettings,
  VALID_KEYS_META,
} from "../utils/settings.js";

type ValidKey = "lang" | "auto_agg_commit" | "analysis_model";

function isValidKey(key: string): key is ValidKey {
  return VALID_KEYS_META.some((meta) => meta.key === key);
}

function validateValue(key: ValidKey, value: string): string | boolean {
  switch (key) {
    case "lang":
      if (value !== "en" && value !== "ja") {
        throw new Error(`Invalid lang: ${value}. Must be "en" or "ja".`);
      }
      return value;
    case "auto_agg_commit":
      if (value !== "true" && value !== "false") {
        throw new Error(
          `Invalid auto_agg_commit: ${value}. Must be "true" or "false".`,
        );
      }
      return value === "true";
    case "analysis_model":
      // Model ID is a free-form string (e.g., "anthropic/claude-3-5-sonnet-20241022")
      return value;
    default:
      throw new Error(`Unknown key: ${key}`);
  }
}

export async function handleConfig(
  _pi: ExtensionAPI,
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
  let showGlobal = false;
  let list = false;
  let showOrigin = false;
  let keys = false;
  let models = false;
  let help = false;
  const positional: string[] = [];

  for (const token of tokens) {
    if (token === "--global") showGlobal = true;
    else if (token === "--list") list = true;
    else if (token === "--show-origin") showOrigin = true;
    else if (token === "--keys") keys = true;
    else if (token === "--models") models = true;
    else if (token === "--help") help = true;
    else positional.push(token);
  }

  if (help) {
    const lines = ja
      ? [
          "/git-config <key> [value] [--global] [--list] [--show-origin] [--keys] [--models] [--help]",
          "",
          "サブコマンド:",
          "  <key>           設定値を取得",
          "  <key> <value>   設定値を変更",
          "",
          "フラグ:",
          "  --global        グローバル設定に対して操作",
          "  --list           すべての設定値を一覧表示",
          "  --show-origin    値の取得元（default/global/local）を表示",
          "  --keys           有効なキー一覧と説明を表示",
          "  --models         analysis_model に設定可能なモデル一覧を表示",
          "  --help           このヘルプを表示",
        ]
      : [
          "/git-config <key> [value] [--global] [--list] [--show-origin] [--keys] [--models] [--help]",
          "",
          "Subcommands:",
          "  <key>           Get the value of a setting",
          "  <key> <value>   Set the value of a setting",
          "",
          "Flags:",
          "  --global        Operate on global settings",
          "  --list           List all configured values",
          "  --show-origin    Show value origin (default/global/local)",
          "  --keys           Show valid keys with descriptions",
          "  --models         Show available models for analysis_model",
          "  --help           Show this help message",
        ];
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  if (keys) {
    const lines = VALID_KEYS_META.map((meta) => {
      const desc = ja ? meta.description_ja : meta.description_en;
      let line = `${meta.key} (${meta.type}) — ${desc}`;
      if (meta.valid_values) {
        line += ` [${meta.valid_values}]`;
      }
      return line;
    });
    ctx.ui.notify(lines.join("\n"), "info");
    return;
  }

  if (models) {
    const availableModels = ctx.modelRegistry.getAvailable();
    if (availableModels.length === 0) {
      ctx.ui.notify(
        ja ? "利用可能なモデルが見つかりません" : "No available models found",
        "warning",
      );
      return;
    }

    const currentModel = getSettings(ctx.cwd).analysis_model;
    const lines = availableModels.map((model) => {
      const modelId = `${model.provider}/${model.id}`;
      const isCurrent = modelId === currentModel;
      const marker = isCurrent ? " (current)" : "";
      return `${modelId}${marker}`;
    });

    const header = ja
      ? "analysis_model に設定可能なモデル一覧:"
      : "Available models for analysis_model:";
    ctx.ui.notify(`${header}\n${lines.join("\n")}`, "info");
    return;
  }

  if (list) {
    const settings = getSettings(ctx.cwd);
    const entries: string[] = [];
    for (const meta of VALID_KEYS_META) {
      const key = meta.key as ValidKey;
      const value = settings[key];
      if (value === undefined) continue;
      if (showOrigin) {
        const { origin } = getSettingWithOrigin(key, ctx.cwd);
        entries.push(`${key}=${value} (${origin})`);
      } else {
        entries.push(`${key}=${value}`);
      }
    }
    if (entries.length === 0) {
      ctx.ui.notify(ja ? "設定はありません" : "No settings configured", "info");
    } else {
      ctx.ui.notify(entries.join("\n"), "info");
    }
    return;
  }

  if (positional.length === 0) {
    ctx.ui.notify(
      ja
        ? "使用方法: /git-config <key> [value] [--global] [--list] [--show-origin] [--keys]"
        : "Usage: /git-config <key> [value] [--global] [--list] [--show-origin] [--keys]",
      "warning",
    );
    return;
  }

  const key = positional[0];

  if (!isValidKey(key)) {
    ctx.ui.notify(
      ja
        ? `[pi-git] 不明な設定キー: ${key}`
        : `[pi-git] Unknown config key: ${key}`,
      "warning",
    );
    return;
  }

  if (positional.length === 1) {
    // Get single value
    const { value, origin } = getSettingWithOrigin(key, ctx.cwd);
    if (value === undefined) {
      ctx.ui.notify(
        ja
          ? `[pi-git] ${key} は設定されていません`
          : `[pi-git] ${key} is not set`,
        "info",
      );
    } else {
      ctx.ui.notify(
        showOrigin ? `${value} (${origin})` : String(value),
        "info",
      );
    }
    return;
  }

  // Set value
  const rawValue = positional[1];
  let parsed: string | boolean;
  try {
    parsed = validateValue(key, rawValue);
  } catch (err) {
    ctx.ui.notify(
      ja
        ? `[pi-git] ${err instanceof Error ? err.message : String(err)}`
        : `[pi-git] ${err instanceof Error ? err.message : String(err)}`,
      "warning",
    );
    return;
  }

  try {
    if (showGlobal) {
      saveGlobalSettings({ [key]: parsed });
      ctx.ui.notify(
        ja
          ? `[pi-git] ${key}=${parsed} をグローバル設定に保存しました`
          : `[pi-git] Saved ${key}=${parsed} to global config`,
        "info",
      );
    } else {
      // Default to local when inside a git repo
      const localPath = getLocalSettingsPath(ctx.cwd);
      if (localPath) {
        const globalExists = existsSync(GLOBAL_SETTINGS_FILE);
        const localExists = existsSync(localPath);
        if (!globalExists && !localExists) {
          // グローバルもローカルもない場合：デフォルト値で初期化
          saveLocalSettings({ ...DEFAULT_SETTINGS, [key]: parsed }, ctx.cwd);
          ctx.ui.notify(
            ja
              ? `[pi-git] ${key}=${parsed} をローカル設定に保存しました（デフォルト値で初期化）`
              : `[pi-git] Saved ${key}=${parsed} to local config (initialized with defaults)`,
            "info",
          );
        } else {
          saveLocalSettings({ [key]: parsed }, ctx.cwd);
          ctx.ui.notify(
            ja
              ? `[pi-git] ${key}=${parsed} をローカル設定に保存しました`
              : `[pi-git] Saved ${key}=${parsed} to local config`,
            "info",
          );
        }
      } else {
        // Fallback to global when not in a repo
        saveGlobalSettings({ [key]: parsed });
        ctx.ui.notify(
          ja
            ? `[pi-git] ${key}=${parsed} をグローバル設定に保存しました（Gitリポジトリ外のため）`
            : `[pi-git] Saved ${key}=${parsed} to global config (outside git repo)`,
          "info",
        );
      }
    }
  } catch (err) {
    ctx.ui.notify(
      ja
        ? `[pi-git] 保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`
        : `[pi-git] Failed to save: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}
