/**
 * Persistent settings storage for pi-git extension.
 *
 * Settings are stored in:
 * - Global: ~/.config/pi-git/settings.json
 * - Local:  <git-root>/.pi-git/settings.json (takes precedence)
 */

import {
	readFileSync,
	writeFileSync,
	mkdirSync,
	existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

export interface PiGitSettings {
	/** Display and commit message language (e.g., "en", "ja") */
	lang?: string;
	/** Whether to automatically run git-agg-commit after assistant response */
	auto_agg_commit?: boolean;
}

export type SettingOrigin = "default" | "global" | "local";

export const DEFAULT_SETTINGS: PiGitSettings = {
	lang: "en",
	auto_agg_commit: false,
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
	return { ...cache.get(key)! };
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

// ───────────────────────────────────────────────
// Save helpers
// ───────────────────────────────────────────────

export function saveGlobalSettings(settings: Partial<PiGitSettings>): void {
	mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
	const current = loadJson(GLOBAL_SETTINGS_FILE) ?? {};
	const updated = { ...current, ...settings };
	writeFileSync(
		GLOBAL_SETTINGS_FILE,
		JSON.stringify(updated, null, 2) + "\n",
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
	writeFileSync(
		localPath,
		JSON.stringify(updated, null, 2) + "\n",
		"utf-8",
	);
	cache.clear();
}

/** Backward-compatible alias: writes to global settings. */
export function saveSettings(settings: Partial<PiGitSettings>): void {
	saveGlobalSettings(settings);
}

/** Backward-compatible alias. */
export function setLanguage(lang: string): void {
	saveGlobalSettings({ lang });
}

/** Backward-compatible alias. */
export function setAutoAggCommit(enabled: boolean): void {
	saveGlobalSettings({ auto_agg_commit: enabled });
}
