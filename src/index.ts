import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { GitOperations } from "./git-operations.js";
import { generateCommitMessageWithLLM } from "./llm-commit.js";

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
				return;
			}

			// ── 3. Load config ──────────────────────────────────────────
			const config = loadConfig(ctx.cwd);

			// ── 4. Stage all files ──────────────────────────────────────
			await git.stageAll();

			// ── 5. Check if user provided an inline commit message ──────
			// If inlineMessage has text, use it directly without AI generation.
			if (inlineMessage) {
				// Skip AI generation — commit directly with the provided message
				try {
					if (dryRun) {
						ctx.ui.notify(
							`[DRY RUN] Would commit with the following message:\n\n${inlineMessage}`,
							"info",
						);
						return;
					}
					ctx.ui.notify(`Committing with provided message...`, "info");
					const result = await git.commit(inlineMessage);
					if (result.code === 0) {
						ctx.ui.notify(
							`Committed successfully:\n${result.stdout.trim() || inlineMessage.split("\n")[0]}`,
							"info",
						);
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

			// ── 6. Analyze changes ──────────────────────────────────────
			const nameStatus = await git.getStagedNameStatus();
			const stat = await git.getStagedStat();
			const diff = await git.getStagedDiff();

			// ── 7. Notify dry-run mode ─────────────────────────────────
			if (dryRun) {
				ctx.ui.notify("[DRY RUN] Commit will be simulated — no changes will be committed.", "info");
			}

			// ── 8. Generate commit message via LLM ─────────────────────
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

			// ── 9. User confirmation loop ───────────────────────────────
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
				return;
			}

			// ── 10. Execute commit ──────────────────────────────────────
			if (dryRun) {
				ctx.ui.notify(
					`[DRY RUN] Skipped. Would commit with:\n\n${fullMessage}`,
					"info",
				);
				return;
			}

			try {
				const result = await git.commit(fullMessage);
				if (result.code === 0) {
					ctx.ui.notify(
						`Committed successfully:\n${result.stdout.trim() || fullMessage.split("\n")[0]}`,
						"info",
					);
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

	// ── Auto-commit on agent_end (commit_every_turn) ─────────────────
	pi.on("agent_end", async (_event, ctx) => {
		const config = loadConfig(ctx.cwd);
		if (!config.commitEveryTurn) return;

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
		}
	});
}
