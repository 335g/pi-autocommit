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
		console.log(`[pi-git] Language setting saved: ${langArg}`);
	}

	// 1. Skip in non-interactive mode
	if (!ctx.hasUI) {
		console.log("[pi-git] Skipping: non-interactive mode");
		return;
	}

	console.log("[pi-git] Starting auto-commit...");

	// 2. Check git repository
	if (!(await isGitRepository(pi))) {
		console.warn("[pi-git] Not a git repository, aborting");
		ctx.ui.notify("Not a git repository", "warning");
		return;
	}
	console.log("[pi-git] Git repository confirmed");

	// 3. Check for changes
	if (!(await hasChanges(pi))) {
		console.log("[pi-git] No changes detected");
		ctx.ui.notify("No changes to commit", "info");
		return;
	}
	console.log("[pi-git] Changes detected in working tree");

	// 4. Get full diff including tracked changes and untracked files
	console.log("[pi-git] Collecting diff from tracked files...");
	const { stdout: trackedDiff, code: trackedCode } = await pi.exec("git", ["diff", "HEAD"]);
	if (trackedCode !== 0) {
		console.error("[pi-git] Failed to get tracked diff");
		ctx.ui.notify("Failed to get diff", "warning");
		return;
	}
	console.log(`[pi-git] Tracked diff: ${trackedDiff.split("\n").length} lines`);

	// Collect untracked files
	console.log("[pi-git] Scanning for untracked files...");
	const { stdout: untrackedFiles } = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"]);
	const untrackedList = untrackedFiles.split("\n").filter((f) => f.trim());
	console.log(`[pi-git] Found ${untrackedList.length} untracked file(s)`);

	let untrackedDiff = "";
	for (const file of untrackedList) {
		console.log(`[pi-git] Reading untracked file: ${file}`);
		const { stdout: content } = await pi.exec("cat", [file]);
		untrackedDiff += `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${content.split("\n").length} @@\n`;
		for (const line of content.split("\n")) {
			untrackedDiff += `+${line}\n`;
		}
	}

	const diff = trackedDiff + untrackedDiff;
	if (!diff.trim()) {
		console.log("[pi-git] Diff is empty after collection");
		ctx.ui.notify("No changes to commit", "info");
		return;
	}
	console.log(`[pi-git] Total diff size: ${diff.length} characters`);

	// 5. Analyze diff into logical hunks
	console.log("[pi-git] Analyzing diff with AI model...");
	let hunks = await analyzeDiff(pi, ctx, diff);
	console.log(`[pi-git] AI analysis returned ${hunks.length} hunk(s)`);

	if (hunks.length === 0) {
		console.warn("[pi-git] No hunks found, nothing to commit");
		ctx.ui.notify("No hunks found to commit", "info");
		return;
	}

	for (let i = 0; i < hunks.length; i++) {
		console.log(`[pi-git] Hunk ${i + 1}: ${hunks[i].files.join(", ")} -> "${hunks[i].message}"`);
	}

	// 6. Sanitize commit messages
	console.log("[pi-git] Sanitizing commit messages...");
	hunks = hunks.map(sanitizeHunk);
	for (let i = 0; i < hunks.length; i++) {
		console.log(`[pi-git] Sanitized hunk ${i + 1}: "${hunks[i].message}"`);
	}

	// 7. Stage and commit each hunk
	console.log("[pi-git] Starting staging and commit loop...");
	let committedCount = 0;
	let failedCount = 0;

	for (let i = 0; i < hunks.length; i++) {
		const hunk = hunks[i];
		console.log(`[pi-git] --- Processing hunk ${i + 1}/${hunks.length} ---`);

		// Stage files for this hunk
		try {
			console.log(`[pi-git] Staging ${hunk.files.length} file(s): ${hunk.files.join(", ")}`);
			await stageFiles(pi, hunk.files);
			console.log(`[pi-git] Staged successfully`);
		} catch (error) {
			console.warn(`[pi-git] Failed to stage files: ${hunk.files.join(", ")}`);
			ctx.ui.notify(
				`Failed to stage files: ${hunk.files.join(", ")}`,
				"warning",
			);
			failedCount++;
			continue;
		}

		// Commit
		console.log(`[pi-git] Committing with message: "${hunk.message}"`);
		const exitCode = await commit(pi, hunk.message);
		if (exitCode !== 0) {
			console.warn(`[pi-git] Commit failed (exit code: ${exitCode}), resetting staging...`);
			// Pre-commit hook failed or other error - reset staging
			try {
				await resetStaging(pi);
				console.log("[pi-git] Staging reset completed");
			} catch {
				console.warn("[pi-git] Staging reset failed (ignored)");
			}
			ctx.ui.notify(
				`Commit failed for "${hunk.message}" (exit code ${exitCode}). Staging has been reset.`,
				"warning",
			);
			failedCount++;
			continue;
		}

		console.log(`[pi-git] Commit successful: "${hunk.message}"`);
		committedCount++;
	}

	// 8. Notify completion
	console.log(`[pi-git] Finished: ${committedCount} committed, ${failedCount} failed`);
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
