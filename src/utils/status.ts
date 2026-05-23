import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getSettings } from "./settings.js";

const AUTO_AGG_COMMIT_STATUS_KEY = "!pi-git-auto-agg-commit";

function isJapanese(lang: string): boolean {
	return lang === "ja" || lang === "ja-JP" || lang === "japanese";
}

/**
 * Update the footer status indicator for auto-agg-commit.
 * Shows a label when enabled, clears it when disabled.
 */
export function updateAutoAggCommitStatus(ui: ExtensionUIContext, enabled: boolean): void {
	const lang = getSettings().lang ?? "en";
	if (enabled) {
		const text = isJapanese(lang)
			? "[pi-git] auto-commit: 有効"
			: "[pi-git] auto-commit: ON";
		ui.setStatus(AUTO_AGG_COMMIT_STATUS_KEY, text);
	} else {
		ui.setStatus(AUTO_AGG_COMMIT_STATUS_KEY, undefined);
	}
}
