/**
 * /git-config command
 *
 * Get, set, and list pi-git configuration values.
 * Supports both global (~/.config/pi-git/settings.json)
 * and local (<repo>/.pi-git/settings.json) scopes.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	getSettings,
	getSettingWithOrigin,
	saveGlobalSettings,
	saveLocalSettings,
	getLocalSettingsPath,
} from "../utils/settings.js";

function isJapanese(lang: string): boolean {
	return lang === "ja" || lang === "ja-JP" || lang === "japanese";
}

const VALID_KEYS = ["lang", "autoAggCommit"] as const;
type ValidKey = (typeof VALID_KEYS)[number];

function isValidKey(key: string): key is ValidKey {
	return VALID_KEYS.includes(key as ValidKey);
}

function validateValue(key: ValidKey, value: string): string | boolean {
	switch (key) {
		case "lang":
			if (value !== "en" && value !== "ja") {
				throw new Error(
					`Invalid lang: ${value}. Must be "en" or "ja".`,
				);
			}
			return value;
		case "autoAggCommit":
			if (value !== "true" && value !== "false") {
				throw new Error(
					`Invalid autoAggCommit: ${value}. Must be "true" or "false".`,
				);
			}
			return value === "true";
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

	const tokens = args
		.trim()
		.split(/\s+/)
		.filter(Boolean);

	// Parse flags
	let showGlobal = false;
	let list = false;
	let showOrigin = false;
	const positional: string[] = [];

	for (const token of tokens) {
		if (token === "--global") showGlobal = true;
		else if (token === "--list") list = true;
		else if (token === "--show-origin") showOrigin = true;
		else positional.push(token);
	}

	if (list) {
		const settings = getSettings(ctx.cwd);
		const entries: string[] = [];
		for (const key of VALID_KEYS) {
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
			ctx.ui.notify(
				ja ? "設定はありません" : "No settings configured",
				"info",
			);
		} else {
			ctx.ui.notify(entries.join("\n"), "info");
		}
		return;
	}

	if (positional.length === 0) {
		ctx.ui.notify(
			ja
				? "使用方法: /git-config <key> [value] [--global] [--list] [--show-origin]"
				: "Usage: /git-config <key> [value] [--global] [--list] [--show-origin]",
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
				saveLocalSettings({ [key]: parsed }, ctx.cwd);
				ctx.ui.notify(
					ja
						? `[pi-git] ${key}=${parsed} をローカル設定に保存しました`
						: `[pi-git] Saved ${key}=${parsed} to local config`,
					"info",
				);
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
