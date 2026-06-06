/**
 * Persistent settings storage for pi-git extension.
 *
 * Settings are stored in:
 * - Global: ~/.config/pi-git/settings.json
 * - Local:  <git-root>/.pi-git/settings.json (takes precedence)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { MessageKey } from "../i18n/messages.js";

export interface PiGitSettings {
  /** Display and commit message language (e.g., "en", "ja") */
  lang?: string;
  /** Whether to automatically run git-agg-commit after assistant response */
  auto_agg_commit?: boolean;
  /** Model to use for diff analysis (format: "provider/model-id") */
  analysis_model?: string;
}

export type SettingOrigin = "default" | "global" | "local";

/** Metadata for each valid configuration key */
export interface KeyMeta {
  key: string;
  /** Display type (e.g., "string", "boolean") */
  type: string;
  /** Message key for localized description */
  messageKey: MessageKey;
  /** Valid values hint (optional) */
  valid_values?: string;
}

/** Metadata for all valid configuration keys */
export const VALID_KEYS_META: KeyMeta[] = [
  {
    key: "lang",
    type: "string",
    messageKey: "config.keyDesc.lang",
    valid_values: '"en" or "ja"',
  },
  {
    key: "auto_agg_commit",
    type: "boolean",
    messageKey: "config.keyDesc.auto_agg_commit",
    valid_values: "true or false",
  },
  {
    key: "analysis_model",
    type: "string",
    messageKey: "config.keyDesc.analysis_model",
    valid_values: "e.g., anthropic/claude-3-5-sonnet-20241022",
  },
];

export const DEFAULT_SETTINGS: PiGitSettings = {
  lang: "en",
  auto_agg_commit: false,
  analysis_model: "",
};

export const GLOBAL_CONFIG_DIR = join(homedir(), ".config", "pi-git");
export const GLOBAL_SETTINGS_FILE = join(GLOBAL_CONFIG_DIR, "settings.json");
const LOCAL_SETTINGS_DIR = ".pi-git";
const LOCAL_SETTINGS_FILE = "settings.json";

// ───────────────────────────────────────────────
// File I/O helpers
// ───────────────────────────────────────────────

function loadJson(path: string): PiGitSettings | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as PiGitSettings;
  } catch {
    return null;
  }
}

export function getLocalSettingsPath(cwd?: string): string | null {
  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (!repoRoot) return null;
    return join(repoRoot, LOCAL_SETTINGS_DIR, LOCAL_SETTINGS_FILE);
  } catch {
    return null;
  }
}

function loadRaw(cwd?: string): {
  global: PiGitSettings;
  local: PiGitSettings | null;
} {
  const global = loadJson(GLOBAL_SETTINGS_FILE) ?? {};
  const localPath = getLocalSettingsPath(cwd);
  const local = localPath ? loadJson(localPath) : null;
  return { global, local };
}

function merge(
  global: PiGitSettings,
  local: PiGitSettings | null,
): PiGitSettings {
  return { ...DEFAULT_SETTINGS, ...global, ...(local ?? {}) };
}

// ───────────────────────────────────────────────
// In-memory cache
// ───────────────────────────────────────────────

const cache = new Map<string, PiGitSettings>();

export function getSettings(cwd?: string): PiGitSettings {
  const key = cwd ?? process.cwd();
  if (!cache.has(key)) {
    const { global, local } = loadRaw(cwd);
    cache.set(key, merge(global, local));
  }
  const cached = cache.get(key);
  return cached ? { ...cached } : { ...DEFAULT_SETTINGS };
}

export function clearSettingsCache(): void {
  cache.clear();
}

// ───────────────────────────────────────────────
// Origin helpers (for --show-origin)
// ───────────────────────────────────────────────

export function getSettingOrigin(
  key: keyof PiGitSettings,
  cwd?: string,
): SettingOrigin {
  const { global, local } = loadRaw(cwd);
  if (local && key in local) return "local";
  if (global && key in global) return "global";
  return "default";
}

export function getSettingWithOrigin<K extends keyof PiGitSettings>(
  key: K,
  cwd?: string,
): { value: PiGitSettings[K] | undefined; origin: SettingOrigin } {
  const settings = getSettings(cwd);
  return { value: settings[key], origin: getSettingOrigin(key, cwd) };
}

// ───────────────────────────────────────────────
// Convenience getters
// ───────────────────────────────────────────────

export function getLanguage(cwd?: string): string {
  return getSettings(cwd).lang || "en";
}

export function getAutoAggCommit(cwd?: string): boolean {
  return getSettings(cwd).auto_agg_commit ?? false;
}

export function getAnalysisModel(cwd?: string): string | undefined {
  const model = getSettings(cwd).analysis_model;
  return model?.trim() ? model.trim() : undefined;
}

// ───────────────────────────────────────────────
// Save helpers
// ───────────────────────────────────────────────

export function saveGlobalSettings(settings: Partial<PiGitSettings>): void {
  mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  const current = loadJson(GLOBAL_SETTINGS_FILE) ?? {};
  const updated = { ...current, ...settings };
  writeFileSync(
    GLOBAL_SETTINGS_FILE,
    `${JSON.stringify(updated, null, 2)}\n`,
    "utf-8",
  );
  cache.clear();
}

export function saveLocalSettings(
  settings: Partial<PiGitSettings>,
  cwd?: string,
): void {
  const localPath = getLocalSettingsPath(cwd);
  if (!localPath) {
    throw new Error("Not inside a git repository");
  }
  mkdirSync(dirname(localPath), { recursive: true });
  const current = loadJson(localPath) ?? {};
  const updated = { ...current, ...settings };
  writeFileSync(localPath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
  cache.clear();
}
