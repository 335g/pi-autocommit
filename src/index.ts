import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import { loadConfig } from "./config.js";
import { runCommitPipeline } from "./pipeline.js";
import { parseCommitArgs } from "./args.js";
import { confirmCommitMessage } from "./confirmation.js";
import { GitOperations } from "./git-operations.js";
import { checkCritAvailable, runCritReview } from "./reviewer.js";

/**
 * pi-git extension — `/git-commit`, `/git-review`, and `/git-status` commands
 *
 * `/git-commit` stages all current files, generates a Conventional Commits
 * message, and commits.
 * `/git-review` does the same with a crit review step before committing.
 * `/git-status` shows the working tree status in a scrollable TUI viewer.
 *
 * The heavy lifting is delegated to `runCommitPipeline` in `pipeline.ts`;
 * this module only registers commands and events.
 */
export default function (pi: ExtensionAPI) {
	/**
	 * Update the footer status to show whether there are uncommitted changes.
	 * Shows "[has changes]" when changes exist, clears it otherwise.
	 */
	async function updateFooterStatus(ctx: ExtensionContext) {
		const git = new GitOperations(pi);
		try {
			if (!(await git.isInsideGitRepo())) {
				ctx.ui.setStatus("pi-git-uncommitted", undefined);
				return;
			}
			const hasChanges = await git.checkUncommittedChanges();
			ctx.ui.setStatus(
				"pi-git-uncommitted",
				hasChanges ? "[has changes]" : undefined,
			);
		} catch {
			ctx.ui.setStatus("pi-git-uncommitted", undefined);
		}
	}

	// ───────────────────────────────────────────────────────
	// /git-commit command
	// ───────────────────────────────────────────────────────

	pi.registerCommand("git-commit", {
		description: "Stage all changes and generate a Conventional Commits message",
		handler: async (args, ctx) => {
			const { dryRun, inlineMessage } = parseCommitArgs(args?.trim() ?? "");
			const config = loadConfig(ctx.cwd);

			try {
				await runCommitPipeline(pi, ctx, config, {
					inlineMessage,
					dryRun,
					confirmLabel: "commit",
					hooks: {
						onMessageGenerated: async (msg) =>
							inlineMessage
								? { action: "commit" }
								: confirmCommitMessage(ctx, msg, "pi-git-commit", dryRun),
					},
				});
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`git-commit error: ${message}`, "error");
			}
		},
	});

	// ───────────────────────────────────────────────────────
	// /git-status command
	// ───────────────────────────────────────────────────────

	pi.registerCommand("git-status", {
		description: "Show git status (working tree and staged changes)",
		handler: async (args, ctx) => {
			const git = new GitOperations(pi);
			try {
				if (!(await git.isInsideGitRepo())) {
					ctx.ui.notify("Not a git repository", "error");
					return;
				}
				const status = await git.getFullStatus();

				if (ctx.mode === "tui") {
					await showStatusViewer(ctx, status);
				} else {
					ctx.ui.notify(status || "No changes", "info");
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`git-status error: ${message}`, "error");
			}
		},
	});

	// ───────────────────────────────────────────────────────
	// /git-review command
	// ───────────────────────────────────────────────────────

	pi.registerCommand("git-review", {
		description:
			"Stage, review with crit, generate commit message, and commit",
		handler: async (args, ctx) => {
			const { dryRun } = parseCommitArgs(args?.trim() ?? "");
			const config = loadConfig(ctx.cwd);

			try {
				await checkCritAvailable(pi);

				await runCommitPipeline(pi, ctx, config, {
					dryRun,
					confirmLabel: "review",
					hooks: {
						onBeforeGenerate: async (pipelineCtx, opts) => {
							// Build per-file entries for the crit review document
							const fileEntries = pipelineCtx.selectedFiles
								.map((path) => {
									const detail = pipelineCtx.fileDetails?.get(path);
									return detail
										? {
												path,
												additions: detail.additions,
												deletions: detail.deletions,
											}
										: null;
								})
								.filter(
									(e): e is NonNullable<typeof e> => e !== null,
								);

							// Run crit review
							ctx.ui.notify(
								"Opening crit review in your browser. Review the diff and click Finish Review when done.",
								"info",
							);
							const result = await runCritReview(
								pipelineCtx.pi,
								pipelineCtx.stagedDiff,
								fileEntries,
							);

							// Handle unresolved comments
							const unresolvedComments = result.comments.filter(
								(c) => !c.resolved,
							);
							let reviewContext: string | undefined;

							if (unresolvedComments.length > 0) {
								const commentSummary = unresolvedComments
									.map((c) => {
										const location = c.file
											? `${c.file}${c.quote ? `: "${c.quote}"` : ""}`
											: "";
										return location
											? `${location}: ${c.body}`
											: c.body;
									})
									.join("\n");

								ctx.ui.notify(
									`Unresolved review comments:\n${commentSummary}`,
									"warning",
								);

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
										throw new Error(
											"Review cancelled by user — fix issues first.",
										);
									}
								}

								reviewContext = commentSummary;
							}

							// Pass review context to LLM generation
							if (reviewContext) {
								opts.llmExtraContext = reviewContext;
							}
						},
						onMessageGenerated: async (msg) =>
							confirmCommitMessage(
								ctx,
								msg,
								"pi-git-review-msg",
								dryRun,
							),
					},
				});
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				if (message.includes("cancelled")) {
					ctx.ui.notify(message, "info");
				} else {
					ctx.ui.notify(`git-review error: ${message}`, "error");
				}
			}
		},
	});

	// ───────────────────────────────────────────────────────
	// Show uncommitted changes indicator in footer
	// ───────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		await updateFooterStatus(ctx);
	});

	// ───────────────────────────────────────────────────────
	// Auto-commit on agent_end (commit_every_turn)
	// ───────────────────────────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		const config = loadConfig(ctx.cwd);

		if (!config.commitEveryTurn) {
			await updateFooterStatus(ctx);
			return;
		}

		try {
			await runCommitPipeline(pi, ctx, config, {
				skipFileSelection: true,
				// No hooks → onMessageGenerated undefined → commit without confirmation
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`commit_every_turn: error — ${message}`,
				"error",
			);
		}
	});
}

/**
 * Show `git status` output in a scrollable full-screen TUI viewer.
 *
 * Navigation:
 *   ↑↓        scroll one line
 *   pgup/pgdn scroll 20 lines
 *   esc/^c    close
 */
async function showStatusViewer(
	ctx: ExtensionContext,
	statusOutput: string,
): Promise<void> {
	const lines = statusOutput.trimEnd().split("\n");
	if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
		ctx.ui.notify("No changes — working tree clean.", "info");
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let scrollOffset = 0;
		const maxVisible = Math.min(lines.length, 40);

		return {
			invalidate() {
				// No caching needed.
			},

			handleInput(data: string) {
				if (
					matchesKey(data, Key.escape) ||
					matchesKey(data, Key.ctrl("c"))
				) {
					done(undefined);
					return;
				}

				if (matchesKey(data, Key.up)) {
					if (scrollOffset > 0) {
						scrollOffset--;
						tui.requestRender();
					}
				} else if (matchesKey(data, Key.down)) {
					if (scrollOffset < lines.length - 1) {
						scrollOffset++;
						tui.requestRender();
					}
				} else if (
					matchesKey(data, Key.pageUp) ||
					matchesKey(data, Key.ctrl("b"))
				) {
					scrollOffset = Math.max(0, scrollOffset - 20);
					tui.requestRender();
				} else if (
					matchesKey(data, Key.pageDown) ||
					matchesKey(data, Key.ctrl("f"))
				) {
					scrollOffset = Math.min(
						Math.max(0, lines.length - 1),
						scrollOffset + 20,
					);
					tui.requestRender();
				}
			},

			render(width: number): string[] {
				const result: string[] = [];

				// Title
				result.push(
					theme.fg("accent", theme.bold(" git status")),
				);
				result.push(
					theme.fg(
						"dim",
						" " + "─".repeat(Math.min(width - 1, 60)),
					),
				);
				result.push("");

				// Content
				const endLine = Math.min(
					scrollOffset + maxVisible,
					lines.length,
				);
				const visible = lines.slice(scrollOffset, endLine);

				for (const line of visible) {
					// Colour-coded lines
					let styled = line;
					if (
						line.startsWith("\tdeleted:")
					) {
						styled = theme.fg("error", line);
					} else if (
						line.startsWith("\tnew file:") ||
						line.startsWith("\tcopied:")
					) {
						styled = theme.fg("success", line);
					} else if (
						line.startsWith("\tmodified:") ||
						line.startsWith("\trenamed:")
					) {
						styled = theme.fg("warning", line);
					} else if (
						line.includes("Changes not staged for commit") ||
						line.includes("Changes to be committed") ||
						line.includes("Untracked files")
					) {
						styled = theme.fg("accent", line);
					}
					result.push(truncateToWidth(styled, width));
				}

				// Scroll indicator
				if (lines.length > maxVisible) {
					result.push("");
					const scrollPercent = Math.round(
						(scrollOffset /
							Math.max(1, lines.length - maxVisible)) *
							100,
					);
					const scrollInfo = theme.fg(
						"dim",
						`  ${scrollPercent}%  (${scrollOffset + 1}–${endLine}/${lines.length})`,
					);
					result.push(scrollInfo);
				}

				// Help bar
				result.push("");
				result.push(
					theme.fg(
						"dim",
						"  esc/^c close  ↑↓ scroll  pgup/pgdn ±20行",
					),
				);

				return result;
			},
		};
	});
}
