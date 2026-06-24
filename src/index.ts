import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { GitOperations } from "./git-operations.js";
import { generateCommitMessageWithLLM } from "./llm-commit.js";

/**
 * pi-git extension — `/commit` command
 *
 * Stages all current files and generates a Conventional Commits message
 * from the staged changes, then asks the user for confirmation before
 * executing the commit.
 *
 * Mirrors the workflow defined in `myskill/SKILL.md`.
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Stage all changes and generate a Conventional Commits message",
		handler: async (_args, ctx) => {
			const git = new GitOperations(pi);

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

			// ── 5. Analyze changes ──────────────────────────────────────
			const nameStatus = await git.getStagedNameStatus();
			const stat = await git.getStagedStat();
			const diff = await git.getStagedDiff();

			// ── 6. Generate commit message via LLM ──────────────────────
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

			// ── 7. User confirmation loop ───────────────────────────────
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

			// ── 8. Execute commit ───────────────────────────────────────
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
}
