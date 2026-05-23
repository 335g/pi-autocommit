import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const AUTO_AGG_COMMIT_STATUS_KEY = "!pi-git-auto-agg-commit";

/**
 * Update the footer status indicator for auto-agg-commit.
 * The indicator is now merged into the main agg-commit status text,
 * so this only clears any legacy status.
 */
export function updateAutoAggCommitStatus(ui: ExtensionUIContext, _enabled: boolean): void {
	ui.setStatus(AUTO_AGG_COMMIT_STATUS_KEY, undefined);
}
