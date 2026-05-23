import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getSettings, getAutoAggCommit } from "./settings.js";

const AUTO_AGG_COMMIT_STATUS_KEY = "!pi-git-auto-agg-commit";

function isJapanese(lang: string): boolean {
	return lang === "ja" || lang === "ja-JP" || lang === "japanese";
}

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
