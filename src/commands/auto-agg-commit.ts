/**
 * /git-auto-agg-commit command
 *
 * Toggle auto-agg-commit feature: automatically run git-agg-commit
 * after the assistant finishes responding when there are changes.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettings, getAutoAggCommit, setAutoAggCommit } from "../utils/settings.js";
import { updateAutoAggCommitStatus } from "../utils/status.js";

function isJapanese(lang: string): boolean {
	return lang === "ja" || lang === "ja-JP" || lang === "japanese";
}

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

function getToggledMessage(enabled: boolean, lang: string): string {
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
	_pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
): Promise<void> {
	if (!ctx.hasUI) {
		return;
	}

	const trimmed = args.trim().toLowerCase();
	const current = getAutoAggCommit();
	const lang = getSettings(ctx.cwd).lang ?? "en";

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

	setAutoAggCommit(next);
	updateAutoAggCommitStatus(ctx.ui, next);
	ctx.ui.notify(getToggledMessage(next, lang), "info");
}
