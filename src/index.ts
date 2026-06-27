import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { GitOperations } from "./git-operations.js";
import { generateCommitMessageWithLLM } from "./llm-commit.js";
import { selectFiles, type FileDetail } from "./file-selector.js";
import { parseNameStatus } from "./commit-message.js";
import { runCritReview, type CritReviewResult } from "./reviewer.js";

/**
 * pi-git extension — `/commit` command
 *
 * Stages all current files and commits with the given message.
 * If a message is provided inline (e.g. `/commit fix typo`), it is used
 * directly without AI generation. Otherwise, generates a Conventional
 * Commits message from the staged changes and asks for confirmation
 * before executing the commit.
 *
 * Mirrors the workflow defined in `myskill/SKILL.md`.
 */
export default function (pi: ExtensionAPI) {
	/**
	 * Update the footer status to show whether there are uncommitted changes.
	 * Shows "[has changes]" in the footer when changes exist, clears it otherwise.
	 */
	async function updateFooterStatus(ctx: ExtensionContext) {
		const git = new GitOperations(pi);
		try {
			if (!(await git.isInsideGitRepo())) {
				ctx.ui.setStatus("pi-git-uncommitted", undefined);
				return;
			}
			const hasChanges = await git.checkUncommittedChanges();
			if (hasChanges) {
				ctx.ui.setStatus("pi-git-uncommitted", "[has changes]");
			} else {
				ctx.ui.setStatus("pi-git-uncommitted", undefined);
			}
		} catch {
			ctx.ui.setStatus("pi-git-uncommitted", undefined);
		}
	}

	pi.registerCommand("commit", {
		description: "Stage all changes and generate a Conventional Commits message",
		handler: async (args, ctx) => {
			const git = new GitOperations(pi);

			// ── 0. Parse --dry-run flag ─────────────────────────────────
			const rawArgs = args?.trim() ?? "";
			const dryRun = /(?:^|\s)--dry-run(?:$|\s)/.test(rawArgs);
			const inlineMessage = dryRun
				? rawArgs.replace(/\s*--dry-run\s*/, "").trim()
				: rawArgs;

			// ── 0. Verify git repository ────────────────────────────────
			if (!(await git.isInsideGitRepo())) {
				ctx.ui.notify("Not a git repository", "error");
				return;
			}

			// ── 1. Check for merge conflict ─────────────────────────────
			if (await git.hasMergeConflict()) {
				ctx.ui.notify(
					"Merge conflict in progress. Please resolve conflicts first.",
					"error",
				);
				return;
			}

			// ── 2. Check for changes ────────────────────────────────────
			const status = await git.checkStatus();
			if (!status.hasChanges) {
				ctx.ui.notify("No changes to commit", "info");
				await updateFooterStatus(ctx);
				return;
			}

			// ── 3. Load config ──────────────────────────────────────────
			const config = loadConfig(ctx.cwd);

			// ── 4. Stage all files ──────────────────────────────────────
			await git.stageAll();

			// ── 5. File selection ───────────────────────────────────────
			// Show the staged file list and let the user pick which files
			// to include in this commit. Only shown for interactive commits,
			// not for auto-commit (commit_every_turn).
			const nameStatusBeforeSelect = await git.getStagedNameStatus();

			// Pre-fetch per-file diffs and stats for QuickLook-style preview.
			// Only needed in TUI mode; skip for non-TUI.
			const fileDetails = new Map<string, FileDetail>();
			if (ctx.mode === "tui") {
				const parsed = parseNameStatus(nameStatusBeforeSelect);
				await Promise.all(
					parsed.map(async (entry) => {
						const [diffResult, numstatResult] = await Promise.all([
							git.getFileStagedDiff(entry.path),
							git.getFileStagedNumstat(entry.path),
						]);
						fileDetails.set(entry.path, {
							diff: diffResult,
							additions: numstatResult.additions,
							deletions: numstatResult.deletions,
						});
					}),
				);
			}

			const selectedFiles = await selectFiles(ctx, nameStatusBeforeSelect, {
				fileDetails: fileDetails.size > 0 ? fileDetails : undefined,
				confirmLabel: "commit",
			});

			if (selectedFiles === null) {
				// User cancelled – unstage everything and stop
				await git.unstageAll();
				ctx.ui.notify("Commit cancelled (no files selected).", "info");
				await updateFooterStatus(ctx);
				return;
			}

			// Unstage files that were NOT selected by the user
			const allParsed = parseNameStatus(nameStatusBeforeSelect);
			for (const entry of allParsed) {
				if (!selectedFiles.includes(entry.path)) {
					await git.unstageFile(entry.path);
				}
			}

			// ── 6. Check if user provided an inline commit message ──────
			// If inlineMessage has text, use it directly without AI generation.
			if (inlineMessage) {
				// Skip AI generation — commit directly with the provided message
				try {
					if (dryRun) {
						ctx.ui.notify(
							`[DRY RUN] Would commit with the following message:\n\n${inlineMessage}`,
							"info",
						);
						await updateFooterStatus(ctx);
						return;
					}
					ctx.ui.notify(`Committing with provided message...`, "info");
					const result = await git.commit(inlineMessage);
					if (result.code === 0) {
						ctx.ui.notify(
							`Committed successfully:\n${result.stdout.trim() || inlineMessage.split("\n")[0]}`,
							"info",
						);
						await updateFooterStatus(ctx);
					} else {
						ctx.ui.notify(
							`Commit failed (code ${result.code}):\n${result.stderr.trim() || "Unknown error"}`,
							"error",
						);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Commit error: ${message}`, "error");
				}
				return;
			}

			// ── 7. Analyze changes ──────────────────────────────────────
			const nameStatus = await git.getStagedNameStatus();
			const stat = await git.getStagedStat();
			const diff = await git.getStagedDiff();

			// ── 8. Notify dry-run mode ─────────────────────────────────
			if (dryRun) {
				ctx.ui.notify("[DRY RUN] Commit will be simulated — no changes will be committed.", "info");
			}

			// ── 9. Generate commit message via LLM ─────────────────────
			// Uses pi's model (same as the current session), with heuristic
			// fallback when the LLM is unavailable.
			ctx.ui.notify("Generating commit message via LLM...", "info");
			let fullMessage = await generateCommitMessageWithLLM(
				pi,
				ctx,
				nameStatus,
				stat,
				diff,
				config,
			);

			// ── 10. User confirmation loop ──────────────────────────────
			let confirmed = false;
			let cancelled = false;

			while (!confirmed && !cancelled) {
				// Present the message (SKILL.md step 5: show the full generated message)
				if (ctx.hasUI) {
					// Display the commit message in a widget above the editor
					const widgetLines = [
						"",
						...fullMessage.split("\n"),
						"",
					];
					ctx.ui.setWidget("pi-git-commit", widgetLines);

					const choice = await ctx.ui.select(
						"Commit with the following message?",
						[
							"Y - Execute commit",
							"N - Cancel and retry",
							"Edit - Modify the message",
						],
					);

					// Clear the widget after selection
					ctx.ui.setWidget("pi-git-commit", []);

					switch (choice) {
						case "Y - Execute commit":
							confirmed = true;
							break;

						case "N - Cancel and retry":
							cancelled = true;
							break;

						case "Edit - Modify the message": {
							const edited = await ctx.ui.input(
								"Edit the commit message (full message):",
								fullMessage,
							);
							if (edited != null && edited !== fullMessage) {
								fullMessage = edited.trim();
							}
							// If user cancels the editor or leaves it unchanged,
							// re-show the prompt
							break;
						}

						default:
							// User cancelled the select dialog — treat as N
							cancelled = true;
							break;
					}
				} else {
					// Non-TUI / RPC mode: show the message and prompt
					ctx.ui.notify(
						`Proposed commit message:\n\n${fullMessage}\n\nReply with "y" to commit, or provide changes.`,
						"info",
					);
					// In non-TUI mode, we cannot do interactive confirmation,
					// so we commit directly.
					confirmed = true;
				}
			}

			// Clear widget on exit (in case cancelled didn't run the clear)
			if (ctx.hasUI) {
				ctx.ui.setWidget("pi-git-commit", []);
			}

			if (cancelled) {
				ctx.ui.notify("Commit cancelled.", "info");
				await updateFooterStatus(ctx);
				return;
			}

			// ── 11. Execute commit ──────────────────────────────────────
			if (dryRun) {
				ctx.ui.notify(
					`[DRY RUN] Skipped. Would commit with:\n\n${fullMessage}`,
					"info",
				);
				await updateFooterStatus(ctx);
				return;
			}

			try {
				const result = await git.commit(fullMessage);
				if (result.code === 0) {
					ctx.ui.notify(
						`Committed successfully:\n${result.stdout.trim() || fullMessage.split("\n")[0]}`,
						"info",
					);
					await updateFooterStatus(ctx);
				} else {
					ctx.ui.notify(
						`Commit failed (code ${result.code}):\n${result.stderr.trim() || "Unknown error"}`,
						"error",
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Commit error: ${message}`, "error");
			}
		},
	});

	// ───────────────────────────────────────────────────────────────────
	// /review command
	// ───────────────────────────────────────────────────────────────────

	pi.registerCommand("review", {
		description:
			"Stage, review with crit, generate commit message, and commit",
		handler: async (args, ctx) => {
			const git = new GitOperations(pi);

			// ── 0. Parse --dry-run flag ─────────────────────────────────
			const rawArgs = args?.trim() ?? "";
			const dryRun = /(?:^|\s)--dry-run(?:$|\s)/.test(rawArgs);

			// ── 0. Verify git repository ────────────────────────────────
			if (!(await git.isInsideGitRepo())) {
				ctx.ui.notify("Not a git repository", "error");
				return;
			}

			// ── 1. Check for merge conflict ─────────────────────────────
			if (await git.hasMergeConflict()) {
				ctx.ui.notify(
					"Merge conflict in progress. Please resolve conflicts first.",
					"error",
				);
				return;
			}

			// ── 2. Check for changes ────────────────────────────────────
			const status = await git.checkStatus();
			if (!status.hasChanges) {
				ctx.ui.notify("No changes to commit", "info");
				await updateFooterStatus(ctx);
				return;
			}

			// ── 3. Load config ──────────────────────────────────────────
			const config = loadConfig(ctx.cwd);

			// ── 4. Stage all files ──────────────────────────────────────
			await git.stageAll();

			// ── 5. File selection ───────────────────────────────────────
			const nameStatusBeforeSelect = await git.getStagedNameStatus();

			const fileDetails = new Map<string, FileDetail>();
			if (ctx.mode === "tui") {
				const parsed = parseNameStatus(nameStatusBeforeSelect);
				await Promise.all(
					parsed.map(async (entry) => {
						const [diffResult, numstatResult] = await Promise.all([
							git.getFileStagedDiff(entry.path),
							git.getFileStagedNumstat(entry.path),
						]);
						fileDetails.set(entry.path, {
							diff: diffResult,
							additions: numstatResult.additions,
							deletions: numstatResult.deletions,
						});
					}),
				);
			}

			const selectedFiles = await selectFiles(ctx, nameStatusBeforeSelect, {
				fileDetails: fileDetails.size > 0 ? fileDetails : undefined,
				confirmLabel: "review",
			});

			if (selectedFiles === null) {
				await git.unstageAll();
				ctx.ui.notify("Review cancelled.", "info");
				await updateFooterStatus(ctx);
				return;
			}

			// Unstage files that were NOT selected by the user
			const allParsed = parseNameStatus(nameStatusBeforeSelect);
			for (const entry of allParsed) {
				if (!selectedFiles.includes(entry.path)) {
					await git.unstageFile(entry.path);
				}
			}

			// ── 6. Build diff for selected files only ───────────────────
			const selectedFileEntries = selectedFiles
				.map((path) => {
					const detail = fileDetails.get(path);
					if (!detail) return null;
					return {
						path,
						additions: detail.additions,
						deletions: detail.deletions,
						diff: detail.diff,
					};
				})
				.filter(
					(e): e is NonNullable<typeof e> => e !== null,
				);

			const combinedDiff = selectedFileEntries
				.map((e) => e.diff)
				.filter((d) => d.length > 0)
				.join("\n");

			// ── 7. Run crit review ──────────────────────────────────────
			ctx.ui.notify(
				"Opening crit review in your browser. Review the diff and click Finish Review when done.",
				"info",
			);

			let reviewResult: CritReviewResult;
			try {
				reviewResult = await runCritReview(
					pi,
					combinedDiff,
					selectedFileEntries,
				);
			} catch (err) {
				const message =
					err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Review failed: ${message}`, "error");
				await git.unstageAll();
				await updateFooterStatus(ctx);
				return;
			}

			// ── 8. Handle review outcome ────────────────────────────────
			const unresolvedComments = reviewResult.comments.filter(
				(c) => !c.resolved,
			);
			let reviewContext: string | undefined;

			if (unresolvedComments.length > 0) {
				const commentLines = unresolvedComments.map((c) => {
					const location = c.file
						? `${c.file}${c.quote ? `: "${c.quote}"` : ""}`
						: "";
					return location ? `${location}: ${c.body}` : c.body;
				});
				const commentSummary =
					`Unresolved review comments:\n${commentLines.join("\n")}`;

				ctx.ui.notify(commentSummary, "warning");

				// Ask user whether to continue
				if (ctx.hasUI) {
					const choice = await ctx.ui.select(
						"Review has unresolved comments. Continue with commit?",
						[
							"Yes — include comments in commit message context",
							"No — cancel and fix issues first",
						],
					);
					if (
						choice !==
						"Yes — include comments in commit message context"
					) {
						ctx.ui.notify(
							"Review cancelled. Fix the issues and run /review again.",
							"info",
						);
						await git.unstageAll();
						await updateFooterStatus(ctx);
						return;
					}
				} else {
					ctx.ui.notify(
						"Review has unresolved comments. Proceeding with commit anyway.",
						"warning",
					);
				}

				reviewContext = commentLines.join("\n");
			}

			if (reviewResult.prompt) {
				ctx.ui.notify(
					`Reviewer prompt: ${reviewResult.prompt}`,
					"info",
				);
			}

			// ── 9. Notify dry-run mode ─────────────────────────────────
			if (dryRun) {
				ctx.ui.notify(
					"[DRY RUN] Changes were reviewed but will not be committed.",
					"info",
				);
			}

			// ── 10. Generate commit message ─────────────────────────────
			ctx.ui.notify(
				"Generating commit message via LLM...",
				"info",
			);
			const stagedNameStatus = await git.getStagedNameStatus();
			const stagedStat = await git.getStagedStat();
			const stagedDiff = await git.getStagedDiff();
			let fullMessage = await generateCommitMessageWithLLM(
				pi,
				ctx,
				stagedNameStatus,
				stagedStat,
				stagedDiff,
				config,
				reviewContext,
			);

			// ── 11. User confirmation loop ──────────────────────────────
			let confirmed = false;
			let cancelled = false;

			while (!confirmed && !cancelled) {
				if (ctx.hasUI) {
					const widgetLines = ["", ...fullMessage.split("\n"), ""];
					ctx.ui.setWidget("pi-git-review-msg", widgetLines);

					const choice = await ctx.ui.select(
						"Commit with the following message?",
						[
							"Y - Execute commit",
							"N - Cancel",
							"Edit - Modify the message",
						],
					);

					ctx.ui.setWidget("pi-git-review-msg", []);

					switch (choice) {
						case "Y - Execute commit":
							confirmed = true;
							break;

						case "N - Cancel":
							cancelled = true;
							break;

						case "Edit - Modify the message": {
							const edited = await ctx.ui.input(
								"Edit the commit message:",
								fullMessage,
							);
							if (edited != null && edited !== fullMessage) {
								fullMessage = edited.trim();
							}
							break;
						}

						default:
							cancelled = true;
							break;
					}
				} else {
					ctx.ui.notify(
						`Proposed commit message:\n\n${fullMessage}\n\nReply with "y" to commit.`,
						"info",
					);
					confirmed = true;
				}
			}

			if (ctx.hasUI) {
				ctx.ui.setWidget("pi-git-review-msg", []);
			}

			if (cancelled) {
				ctx.ui.notify("Commit cancelled.", "info");
				await updateFooterStatus(ctx);
				return;
			}

			// ── 12. Execute commit ─────────────────────────────────────
			if (dryRun) {
				ctx.ui.notify(
					`[DRY RUN] Skipped. Would commit with:\n\n${fullMessage}`,
					"info",
				);
				await updateFooterStatus(ctx);
				return;
			}

			try {
				const result = await git.commit(fullMessage);
				if (result.code === 0) {
					ctx.ui.notify(
						`Committed successfully:\n${result.stdout.trim() || fullMessage.split("\n")[0]}`,
						"info",
					);
					await updateFooterStatus(ctx);
				} else {
					ctx.ui.notify(
						`Commit failed (code ${result.code}):\n${result.stderr.trim() || "Unknown error"}`,
						"error",
					);
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Commit error: ${message}`, "error");
			}
		},
	});

	// ── Show uncommitted changes indicator in footer ────────────────
	pi.on("session_start", async (_event, ctx) => {
		await updateFooterStatus(ctx);
	});

	// ── Auto-commit on agent_end (commit_every_turn) ─────────────────
	pi.on("agent_end", async (_event, ctx) => {
		const config = loadConfig(ctx.cwd);

		// Update footer regardless of commit_every_turn setting
		if (!config.commitEveryTurn) {
			await updateFooterStatus(ctx);
			return;
		}

		const git = new GitOperations(pi);

		try {
			// Check git repo
			if (!(await git.isInsideGitRepo())) {
				ctx.ui.notify("commit_every_turn: not a git repository", "warning");
				return;
			}

			// Check for merge conflict
			if (await git.hasMergeConflict()) {
				ctx.ui.notify(
					"commit_every_turn: merge conflict in progress, skipping",
					"warning",
				);
				return;
			}

			// Check for changes
			const status = await git.checkStatus();
			if (!status.hasChanges) return;

			// Stage all
			await git.stageAll();

			// Analyze changes
			const nameStatus = await git.getStagedNameStatus();
			const stat = await git.getStagedStat();
			const diff = await git.getStagedDiff();

			// Generate commit message via LLM
			ctx.ui.notify("commit_every_turn: generating commit message...", "info");
			const fullMessage = await generateCommitMessageWithLLM(
				pi,
				ctx,
				nameStatus,
				stat,
				diff,
				config,
			);

			// Execute commit
			const result = await git.commit(fullMessage);
			if (result.code === 0) {
				ctx.ui.notify(
					`commit_every_turn: committed - ${fullMessage.split("\n")[0]}`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`commit_every_turn: commit failed (code ${result.code}):\n${result.stderr.trim() || "Unknown error"}`,
					"error",
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`commit_every_turn: error — ${message}`, "error");
		} finally {
			await updateFooterStatus(ctx);
		}
	});
}
