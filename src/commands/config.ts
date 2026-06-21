/**
 * /git-config command
 *
 * Get, set, and list pi-git configuration values.
 * Supports both global (~/.config/pi-git/settings.json)
 * and local (<repo>/pi-git.toml) scopes.
 */

import { existsSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { t } from "../utils/lang.js";
import {
  DEFAULT_SETTINGS,
  GLOBAL_SETTINGS_FILE,
  deleteGlobalSettings,
  getLanguage,
  getLocalSettingsPath,
  getSettings,
  getSettingWithOrigin,
  initLocalSettings,
  saveGlobalSettings,
  saveLocalSettings,
  VALID_KEYS_META,
} from "../utils/settings.js";

type ValidKey = "lang" | "analysis_model" | "batch_warn_turns";

function isValidKey(key: string): key is ValidKey {
  return VALID_KEYS_META.some((meta) => meta.key === key);
}

function validateValue(key: ValidKey, value: string): string | boolean | number {
  switch (key) {
    case "lang":
      if (value !== "en" && value !== "ja") {
        throw new Error(`Invalid lang: ${value}. Must be "en" or "ja".`);
      }
      return value;
    case "analysis_model":
      return value;
    case "batch_warn_turns":
      const num = Number(value);
      if (!Number.isInteger(num) || num < 0) {
        throw new Error(
          `Invalid batch_warn_turns: ${value}. Must be a non-negative integer.`,
        );
      }
      return num;
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

  const lang = getLanguage(ctx.cwd);

  const tokens = args.trim().split(/\s+/).filter(Boolean);

  // Parse flags
  let showGlobal = false;
  let list = false;
  let showOrigin = false;
  let keys = false;
  let models = false;
  let init = false;
  let force = false;
  let help = false;
  let deleteGlobalFlag = false;
  const positional: string[] = [];

  for (const token of tokens) {
    if (token === "--global") showGlobal = true;
    else if (token === "--list") list = true;
    else if (token === "--show-origin") showOrigin = true;
    else if (token === "--keys") keys = true;
    else if (token === "--models") models = true;
    else if (token === "--init") init = true;
    else if (token === "--force") force = true;
    else if (token === "--help") help = true;
    else if (token === "--delete-global") deleteGlobalFlag = true;
    else positional.push(token);
  }

  if (help) {
    ctx.ui.notify(t(lang, "config.help"), "info");
    return;
  }

  if (init) {
    const localPath = getLocalSettingsPath(ctx.cwd);
    if (!localPath) {
      ctx.ui.notify(t(lang, "config.initNotInRepo"), "warning");
      return;
    }

    // existsSync must be evaluated before initLocalSettings —
    // after write it's always true.
    const existed = existsSync(localPath);
    if (existed && !force) {
      ctx.ui.notify(t(lang, "config.initAlreadyExists"), "warning");
      return;
    }

    try {
      // Pass the already-resolved path to avoid a redundant git rev-parse.
      initLocalSettings(localPath);
      ctx.ui.notify(
        t(lang, existed ? "config.initOverwritten" : "config.initCreated"),
        "info",
      );
    } catch (err) {
      ctx.ui.notify(
        t(lang, "config.saveFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
        "error",
      );
    }
    return;
  }

  if (keys) {
    const lines = VALID_KEYS_META.map((meta) => {
      const desc = t(lang, meta.messageKey);
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
      ctx.ui.notify(t(lang, "config.noModels"), "warning");
      return;
    }

    const currentModel = getSettings(ctx.cwd).analysis_model;
    const lines = availableModels.map((model) => {
      const modelId = `${model.provider}/${model.id}`;
      const isCurrent = modelId === currentModel;
      const marker = isCurrent ? " (current)" : "";
      return `${modelId}${marker}`;
    });

    const header = t(lang, "config.modelsHeader");
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
      ctx.ui.notify(t(lang, "config.noSettings"), "info");
    } else {
      ctx.ui.notify(entries.join("\n"), "info");
    }
    return;
  }

  if (deleteGlobalFlag) {
    const { deleted, error } = deleteGlobalSettings();
    if (deleted) {
      ctx.ui.notify(t(lang, "config.deleteGlobalSuccess"), "info");
    } else if (!error) {
      ctx.ui.notify(t(lang, "config.deleteGlobalNotFound"), "info");
    } else {
      ctx.ui.notify(t(lang, "config.deleteGlobalFailed", { error }), "error");
    }
    return;
  }

  if (positional.length === 0) {
    ctx.ui.notify(t(lang, "config.usageHint"), "warning");
    return;
  }

  const key = positional[0];

  if (!isValidKey(key)) {
    ctx.ui.notify(t(lang, "config.unknownKey", { key }), "warning");
    return;
  }

  if (positional.length === 1) {
    // Get single value
    const { value, origin } = getSettingWithOrigin(key, ctx.cwd);
    if (value === undefined) {
      ctx.ui.notify(t(lang, "config.notSet", { key }), "info");
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
  let parsed: string | boolean | number;
  try {
    parsed = validateValue(key, rawValue);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`[pi-git] ${errMsg}`, "warning");
    return;
  }

  try {
    if (showGlobal) {
      saveGlobalSettings({ [key]: parsed });
      ctx.ui.notify(
        t(lang, "config.savedToGlobal", { key, value: String(parsed) }),
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
            t(lang, "config.savedToLocalInit", { key, value: String(parsed) }),
            "info",
          );
        } else {
          saveLocalSettings({ [key]: parsed }, ctx.cwd);
          ctx.ui.notify(
            t(lang, "config.savedToLocal", { key, value: String(parsed) }),
            "info",
          );
        }
      } else {
        // Fallback to global when not in a repo
        saveGlobalSettings({ [key]: parsed });
        ctx.ui.notify(
          t(lang, "config.savedToGlobalFallback", {
            key,
            value: String(parsed),
          }),
          "info",
        );
      }
    }
  } catch (err) {
    ctx.ui.notify(
      t(lang, "config.saveFailed", {
        error: err instanceof Error ? err.message : String(err),
      }),
      "error",
    );
  }
}
