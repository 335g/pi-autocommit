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
import { setCommitMessageLanguage, getCommitMessageLanguage } from "../utils/settings.js";

const STATUS_ID = "pi-git-auto-commit";

function parseLangArg(args: string): string | undefined {
	const match = args.match(/--lang(?:uage)?[=\s]+(\S+)/);
	return match?.[1];
}

export async function handleAutoCommit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
): Promise<void> {
	// Parse language argument
	const langArg = parseLangArg(args);
	if (langArg) {
		setCommitMessageLanguage(langArg);
		ctx.ui.notify(`Commit message language set to: ${langArg}`, "info");
	}

	// 1. Skip in non-interactive mode
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.setStatus(STATUS_ID, "[pi-git] 準備中...");

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

	// 4. Get full diff including tracked changes and untracked files
	ctx.ui.setStatus(STATUS_ID, "[pi-git] diff収集中...");
	const { stdout: trackedDiff, code: trackedCode } = await pi.exec("git", ["diff", "HEAD"]);
	if (trackedCode !== 0) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify("Failed to get diff", "warning");
		return;
	}

	// Collect untracked files
	const { stdout: untrackedFiles } = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"]);
	const untrackedList = untrackedFiles.split("\n").filter((f) => f.trim());

	let untrackedDiff = "";
	for (const file of untrackedList) {
		const { stdout: content } = await pi.exec("cat", [file]);
		untrackedDiff += `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${content.split("\n").length} @@\n`;
		for (const line of content.split("\n")) {
			untrackedDiff += `+${line}\n`;
		}
	}

	const diff = trackedDiff + untrackedDiff;
	if (!diff.trim()) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify("No changes to commit", "info");
		return;
	}

	// 5. Analyze diff into logical hunks
	ctx.ui.setStatus(STATUS_ID, "[pi-git] hunk解析中...");
	let hunks = await analyzeDiff(pi, ctx, diff);
	if (hunks.length === 0) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify("No hunks found to commit", "info");
		return;
	}

	// 6. Sanitize commit messages
	ctx.ui.setStatus(STATUS_ID, "[pi-git] コミットメッセージ生成中...");
	hunks = hunks.map(sanitizeHunk);

	// 7. Stage and commit each hunk
	ctx.ui.setStatus(STATUS_ID, "[pi-git] コミット実行中...");
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
		const currentLang = getCommitMessageLanguage();
		ctx.ui.notify(
			`Created ${committedCount} commit${committedCount > 1 ? "s" : ""} (language: ${currentLang})`,
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
}
