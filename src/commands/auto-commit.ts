/**
 * /git-auto-commit command
 *
 * Automatically analyzes git diff, splits into logical hunks,
 * generates Conventional Commits messages, stages, and commits.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	isGitRepository,
	hasChanges,
	stageFiles,
	commit,
	resetStaging,
} from "../core/git.js";
import { analyzeDiff } from "../core/diff-analyzer.js";
import { sanitizeHunk } from "../core/commit-message.js";
import { setLanguage, getLanguage } from "../utils/settings.js";

export let isAutoCommitRunning = false;

const STATUS_ID = "pi-git-auto-commit";

function parseLangArg(args: string): string | undefined {
	const match = args.match(/--lang(?:uage)?[=\s]+(\S+)/);
	return match?.[1];
}

function isJapanese(lang: string): boolean {
	return lang === "ja" || lang === "ja-JP" || lang === "japanese";
}

function statusText(lang: string, key: "prepare" | "collectDiff" | "analyze" | "generateMessage" | "commit"): string {
	const ja = isJapanese(lang);
	switch (key) {
		case "prepare":
			return ja ? "[pi-git] 準備中..." : "[pi-git] Preparing...";
		case "collectDiff":
			return ja ? "[pi-git] diff収集中..." : "[pi-git] Collecting diff...";
		case "analyze":
			return ja ? "[pi-git] hunk解析中..." : "[pi-git] Analyzing hunks...";
		case "generateMessage":
			return ja ? "[pi-git] コミットメッセージ生成中..." : "[pi-git] Generating messages...";
		case "commit":
			return ja ? "[pi-git] コミット実行中..." : "[pi-git] Committing...";
	}
}

export async function handleAutoCommit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
): Promise<void> {
	// Parse language argument
	const langArg = parseLangArg(args);
	if (langArg) {
		setLanguage(langArg);
		ctx.ui.notify(`Language set to: ${langArg}`, "info");
	}

	const lang = getLanguage();

	// 1. Skip in non-interactive mode
	if (!ctx.hasUI) {
		return;
	}

	// Prevent concurrent executions to avoid staging area conflicts
	if (isAutoCommitRunning) {
		ctx.ui.notify(
			isJapanese(lang) ? "git-auto-commit 実行中です。完了してから再度実行してください。" : "git-auto-commit is already running. Please wait for it to complete.",
			"warning",
		);
		return;
	}

	isAutoCommitRunning = true;

	try {
	ctx.ui.setStatus(STATUS_ID, statusText(lang, "prepare"));

	// 2. Check git repository
	if (!(await isGitRepository(pi))) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify("Not a git repository", "warning");
		return;
	}

	// 3. Check for changes
	if (!(await hasChanges(pi))) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify("No changes to commit", "info");
		return;
	}

	// 4. Snapshot changes via stash to freeze the diff
	ctx.ui.setStatus(STATUS_ID, statusText(lang, "collectDiff"));
	const { code: stashCode } = await pi.exec("git", ["stash", "push", "-u", "-m", "pi-git-auto-commit"]);
	if (stashCode !== 0) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify("Failed to stash changes", "warning");
		return;
	}

	let diff = "";
	try {
		const { stdout: stashDiff } = await pi.exec("git", ["stash", "show", "-p", "stash@{0}"]);
		diff = stashDiff;
	} finally {
		// Always pop the stash to restore working tree
		await pi.exec("git", ["stash", "pop"]);
	}

	if (!diff.trim()) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify("No changes to commit", "info");
		return;
	}

	// 5. Analyze diff into logical hunks
	ctx.ui.setStatus(STATUS_ID, statusText(lang, "analyze"));
	let hunks = await analyzeDiff(pi, ctx, diff);
	if (hunks.length === 0) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify("No hunks found to commit", "info");
		return;
	}

	// 6. Sanitize commit messages
	ctx.ui.setStatus(STATUS_ID, statusText(lang, "generateMessage"));
	hunks = hunks.map(sanitizeHunk);

	// 7. Stage and commit each hunk
	ctx.ui.setStatus(STATUS_ID, statusText(lang, "commit"));
	let committedCount = 0;
	let failedCount = 0;

	for (const hunk of hunks) {
		// Stage files for this hunk
		try {
			await stageFiles(pi, hunk.files);
		} catch {
			failedCount++;
			continue;
		}

		// Commit
		const exitCode = await commit(pi, hunk.message);
		if (exitCode !== 0) {
			// Pre-commit hook failed or other error - reset staging
			try {
				await resetStaging(pi);
			} catch {
				// Ignore reset errors
			}
			ctx.ui.notify(
				`Commit failed for "${hunk.message}" (exit code ${exitCode}). Staging has been reset.`,
				"warning",
			);
			failedCount++;
			continue;
		}

		committedCount++;
	}

		// 8. Notify completion
		ctx.ui.setStatus(STATUS_ID, "");
		if (committedCount > 0 && failedCount === 0) {
			ctx.ui.notify(
				`Created ${committedCount} commit${committedCount > 1 ? "s" : ""}`,
				"info",
			);
		} else if (committedCount > 0 && failedCount > 0) {
			ctx.ui.notify(
				`Created ${committedCount} commit${committedCount > 1 ? "s" : ""}, ${failedCount} failed`,
				"warning",
			);
		} else {
			ctx.ui.notify("All commits failed", "error");
		}
	} finally {
		isAutoCommitRunning = false;
	}
}
