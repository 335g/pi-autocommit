/**
 * /git-agg-commit command
 *
 * Automatically analyzes git diff, splits into logical hunks,
 * generates Conventional Commits messages, stages, and commits.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isGitRepository,
	hasChanges,
	stageFiles,
	resetStaging,
} from "../core/git.js";
import { analyzeDiff } from "../core/diff-analyzer.js";
import { sanitizeHunk } from "../core/commit-message.js";
import { getLanguage, getAutoAggCommit } from "../utils/settings.js";

export let isAggCommitRunning = false;

const STATUS_ID = "pi-git-agg-commit";

function parseLangArg(args: string): string | undefined {
	const match = args.match(/--lang(?:uage)?[=\s]+(\S+)/);
	return match?.[1];
}

function isJapanese(lang: string): boolean {
	return lang === "ja" || lang === "ja-JP" || lang === "japanese";
}

function statusText(
	lang: string,
	key: "prepare" | "collectDiff" | "analyze" | "generateMessage" | "commit",
	autoCommit: boolean,
): string {
	const ja = isJapanese(lang);
	const prefix = autoCommit ? "[pi-git: auto-commit]" : "[pi-git]";
	switch (key) {
		case "prepare":
			return ja ? `${prefix} 準備中...` : `${prefix} Preparing...`;
		case "collectDiff":
			return ja ? `${prefix} diff収集中...` : `${prefix} Collecting diff...`;
		case "analyze":
			return ja ? `${prefix} hunk解析中...` : `${prefix} Analyzing hunks...`;
		case "generateMessage":
			return ja ? `${prefix} コミットメッセージ生成中...` : `${prefix} Generating messages...`;
		case "commit":
			return ja ? `${prefix} コミット実行中...` : `${prefix} Committing...`;
	}
}

export async function handleAggCommit(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: string,
): Promise<void> {
	// Parse language argument (temporary override, does not save)
	const langArg = parseLangArg(args);
	let lang = getLanguage(ctx.cwd);
	if (langArg) {
		lang = langArg;
		ctx.ui.notify(`Language set to: ${langArg} (this run only)`, "info");
	}

	// 1. Skip in non-interactive mode
	if (!ctx.hasUI) {
		return;
	}

	// Prevent concurrent executions to avoid staging area conflicts
	if (isAggCommitRunning) {
		ctx.ui.notify(
			isJapanese(lang) ? "git-agg-commit 実行中です。完了してから再度実行してください。" : "git-agg-commit is already running. Please wait for it to complete.",
			"warning",
		);
		return;
	}

	isAggCommitRunning = true;
	const autoCommit = getAutoAggCommit();

	try {
	ctx.ui.setStatus(STATUS_ID, statusText(lang, "prepare", autoCommit));

	// 2. Check git repository
	if (!(await isGitRepository(pi, ctx.cwd))) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify("Not a git repository", "warning");
		return;
	}

	// 3. Check for changes
	if (!(await hasChanges(pi, ctx.cwd))) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify("No changes to commit", "info");
		return;
	}

	// 4. Snapshot changes via stash to freeze the diff
	ctx.ui.setStatus(STATUS_ID, statusText(lang, "collectDiff", autoCommit));
	const { code: stashCode } = await pi.exec("git", ["stash", "push", "-u", "-m", "pi-git-agg-commit"], { cwd: ctx.cwd });
	if (stashCode !== 0) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify("Failed to stash changes", "warning");
		return;
	}

	let diff = "";
	try {
		// Get tracked files diff
		const { stdout: stashDiff } = await pi.exec("git", ["stash", "show", "-p", "stash@{0}"], { cwd: ctx.cwd });
		diff = stashDiff;

		// Get untracked files diff from stash (stash@{0}^3 contains untracked files when -u was used)
		const { stdout: untrackedDiff, code: untrackedCode } = await pi.exec("git", ["diff", "HEAD", "stash@{0}^3"], { cwd: ctx.cwd });
		if (untrackedCode === 0 && untrackedDiff.trim()) {
			diff += (diff ? "\n" : "") + untrackedDiff;
		}
	} finally {
		// Always pop the stash to restore working tree
		await pi.exec("git", ["stash", "pop"], { cwd: ctx.cwd });
	}

	if (!diff.trim()) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify("No changes to commit", "info");
		return;
	}

	// 5. Analyze diff into logical hunks
	ctx.ui.setStatus(STATUS_ID, statusText(lang, "analyze", autoCommit));
	let hunks = await analyzeDiff(pi, ctx, diff);
	if (hunks.length === 0) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify("No hunks found to commit", "info");
		return;
	}

	// 6. Sanitize commit messages
	ctx.ui.setStatus(STATUS_ID, statusText(lang, "generateMessage", autoCommit));
	hunks = hunks.map(sanitizeHunk);

	// Deduplicate files across hunks: each file belongs only to its first hunk
	const seenFiles = new Set<string>();
	hunks = hunks
		.map((hunk) => ({
			...hunk,
			files: hunk.files.filter((f) => {
				if (seenFiles.has(f)) return false;
				seenFiles.add(f);
				return true;
			}),
		}))
		.filter((hunk) => hunk.files.length > 0);

	// 7. Stage and commit each hunk
	ctx.ui.setStatus(STATUS_ID, statusText(lang, "commit", autoCommit));
	let committedCount = 0;
	let failedCount = 0;
	let skippedCount = 0;

	for (const hunk of hunks) {
		// Stage files for this hunk
		try {
			await stageFiles(pi, hunk.files, ctx.cwd);
		} catch {
			failedCount++;
			continue;
		}

		// Check if there are any staged changes before committing
		const { stdout: stagedDiff, code: diffCode } = await pi.exec("git", ["diff", "--cached", "--stat"], { cwd: ctx.cwd });
		if (diffCode !== 0 || !stagedDiff.trim()) {
			// This file was already committed by a previous hunk
			skippedCount++;
			continue;
		}

		// Commit
		const { code: exitCode, stderr } = await pi.exec("git", ["commit", "-m", hunk.message], { cwd: ctx.cwd });
		if (exitCode !== 0) {
			// Pre-commit hook failed or other error - reset staging
			try {
				await resetStaging(pi, ctx.cwd);
			} catch {
				// Ignore reset errors
			}
			const detail = stderr.trim() ? ` — ${stderr.trim()}` : "";
			ctx.ui.notify(
				`Commit failed for "${hunk.message}" (exit code ${exitCode}).${detail} Staging has been reset.`,
				"warning",
			);
			failedCount++;
			continue;
		}

		committedCount++;
	}

		// 8. Notify completion
		ctx.ui.setStatus(STATUS_ID, "");
		const parts: string[] = [];
		if (committedCount > 0) parts.push(`Created ${committedCount} commit${committedCount > 1 ? "s" : ""}`);
		if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
		if (failedCount > 0) parts.push(`${failedCount} failed`);

		if (parts.length === 0) {
			ctx.ui.notify("All commits failed", "error");
		} else if (failedCount > 0) {
			ctx.ui.notify(parts.join(", "), "warning");
		} else {
			ctx.ui.notify(parts.join(", "), "info");
		}
	} finally {
		isAggCommitRunning = false;
	}
}
