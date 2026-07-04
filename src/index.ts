import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveCommitEveryTurnConfig } from "./config.js";
import { showStatusViewer } from "./status-viewer.js";
import { runCommitPipeline } from "./pipeline.js";
import { parseCommitArgs } from "./args.js";
import { confirmCommitMessage } from "./confirmation.js";
import { GitOperations } from "./git-operations.js";
import { shouldCreateWipCommit } from "./commit-decider.js";
import { organizeWipCommits } from "./commit-organizer.js";
import {
  checkCritAvailable,
  runReviewFlow,
  ReviewSendToAgentError,
  ReviewCancelledError,
} from "./reviewer.js";
import { StatusIndicator } from "./status-indicator.js";

/**
 * pi-git extension — `/git-commit`, `/git-review`, and `/git-status` commands
 *
 * `/git-commit` stages all current files, generates a Conventional Commits
 * message, and commits.
 * `/git-review` does the same with a crit review step before committing.
 * `/git-status` shows the working tree status in a scrollable TUI viewer.
 *
 * The heavy lifting is delegated to `runCommitPipeline` in `pipeline.ts`;
 * this module (the presenter) only registers commands and maps
 * pipeline events to UI calls.
 */
export default function (pi: ExtensionAPI) {
  // ───────────────────────────────────────────────────────
  // /git-commit command
  // ───────────────────────────────────────────────────────

  pi.registerCommand("git-commit", {
    description: "Stage all changes and generate a Conventional Commits message",
    handler: async (args, ctx) => {
      const statusIndicator = new StatusIndicator(new GitOperations(pi), ctx);
      const { dryRun, inlineMessage } = parseCommitArgs(args?.trim() ?? "");
      const config = loadConfig(ctx.cwd);

      try {
        const result = await runCommitPipeline(pi, ctx, config, {
          inlineMessage,
          dryRun,
          confirmLabel: "commit",
          hooks: {
            onMessageGenerated: async (msg) =>
              inlineMessage
                ? { action: "commit" }
                : confirmCommitMessage(ctx, msg, "pi-git-commit", dryRun),
          },
          callbacks: {
            onProgress: (event) => {
              if (event.type === "generating") {
                ctx.ui.notify(
                  "Generating commit message via LLM...",
                  "info",
                );
              }
            },
          },
        });

        for (const event of result.events) {
          switch (event.type) {
            case "info":
              ctx.ui.notify(event.message, "info");
              break;
            case "error":
              ctx.ui.notify(event.message, "error");
              break;
            case "dry-run":
              ctx.ui.notify(event.message, "info");
              break;
            case "committed":
              ctx.ui.notify(event.message, "info");
              break;
            case "cancelled":
              ctx.ui.notify(event.reason, "info");
              break;
            case "stage-changed":
              await statusIndicator.updateFooter();
              break;
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`git-commit error: ${message}`, "error");
        await statusIndicator.updateFooter();
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
      const statusIndicator = new StatusIndicator(new GitOperations(pi), ctx);
      const { dryRun } = parseCommitArgs(args?.trim() ?? "");
      const config = loadConfig(ctx.cwd);

      try {
        const result = await runCommitPipeline(pi, ctx, config, {
          dryRun,
          confirmLabel: "review",
          hooks: {
            onBeforeGenerate: async (pipelineCtx, opts) => {
              const reviewResult = await runReviewFlow(pi, ctx, {
                selectedFiles: pipelineCtx.selectedFiles,
                fileDetails: pipelineCtx.fileDetails,
                stagedDiff: pipelineCtx.stagedDiff,
              });

              if (reviewResult.reviewContext) {
                opts.llmExtraContext = reviewResult.reviewContext;
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
          callbacks: {
            onProgress: (event) => {
              if (event.type === "generating") {
                ctx.ui.notify(
                  "Generating commit message via LLM...",
                  "info",
                );
              }
            },
          },
        });

        for (const event of result.events) {
          switch (event.type) {
            case "info":
              ctx.ui.notify(event.message, "info");
              break;
            case "error":
              ctx.ui.notify(event.message, "error");
              break;
            case "dry-run":
              ctx.ui.notify(event.message, "info");
              break;
            case "committed":
              ctx.ui.notify(event.message, "info");
              break;
            case "cancelled":
              ctx.ui.notify(event.reason, "info");
              break;
            case "stage-changed":
              await statusIndicator.updateFooter();
              break;
          }
        }
      } catch (error) {
        if (error instanceof ReviewSendToAgentError) {
          const reviewComments = error.reviewComments;
          // Changes are already unstaged by the pipeline error handler.
          // Send the review comments to the main agent so it can fix the code.
          pi.sendUserMessage(
            [{
              type: "text",
              text:
                "The following review comments were made during code review. " +
                "Please address each one by editing the affected files. " +
                "All changes have been unstaged. After fixing, run `/git-commit` or `/git-review` again.\n\n" +
                "--- Review Comments ---\n" +
                reviewComments,
            }],
            { deliverAs: "steer" },
          );
          ctx.ui.notify(
            "Review comments sent to the LLM for fixing. Changes have been unstaged.",
            "info",
          );
          await statusIndicator.updateFooter();
          return;
        }

        if (error instanceof ReviewCancelledError) {
          ctx.ui.notify(error.message, "info");
          await statusIndicator.updateFooter();
          return;
        }

        const message =
          error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`git-review error: ${message}`, "error");
        await statusIndicator.updateFooter();
      }
    },
  });

  // ───────────────────────────────────────────────────────
  // Show uncommitted changes indicator in footer
  // ───────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const statusIndicator = new StatusIndicator(new GitOperations(pi), ctx);
    await statusIndicator.updateFooter();
  });

  // ───────────────────────────────────────────────────────
  // Auto-commit on turn_end (commitEveryTurn.trigger === "turn_end")
  // ───────────────────────────────────────────────────────

  pi.on("turn_end", async (event, ctx) => {
    const statusIndicator = new StatusIndicator(new GitOperations(pi), ctx);
    const config = loadConfig(ctx.cwd);
    const commitConfig = resolveCommitEveryTurnConfig(config.commitEveryTurn);

    if (!commitConfig.enabled || commitConfig.trigger !== "turn_end") {
      return;
    }

    if (!shouldCreateWipCommit(event.toolResults)) {
      return;
    }

    const git = new GitOperations(pi);
    if (!(await git.isInsideGitRepo())) {
      return;
    }

    if (!(await git.checkUncommittedChanges())) {
      return;
    }

    try {
      const result = await runCommitPipeline(pi, ctx, config, {
        skipFileSelection: true,
        inlineMessage: `wip(checkpoint): auto-commit at turn ${event.turnIndex + 1}`,
      });

      for (const event of result.events) {
        switch (event.type) {
          case "info":
            ctx.ui.notify(event.message, "info");
            break;
          case "error":
            ctx.ui.notify(event.message, "error");
            break;
          case "dry-run":
            ctx.ui.notify(event.message, "info");
            break;
          case "committed":
            ctx.ui.notify(event.message, "info");
            break;
          case "cancelled":
            ctx.ui.notify(event.reason, "info");
            break;
          case "stage-changed":
            await statusIndicator.updateFooter();
            break;
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `commitEveryTurn: checkpoint error — ${message}`,
        "error",
      );
      await statusIndicator.updateFooter();
    }
  });

  // ───────────────────────────────────────────────────────
  // Auto-commit on agent_end (commitEveryTurn)
  // ───────────────────────────────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    const statusIndicator = new StatusIndicator(new GitOperations(pi), ctx);
    const config = loadConfig(ctx.cwd);
    const commitConfig = resolveCommitEveryTurnConfig(config.commitEveryTurn);

    if (!commitConfig.enabled) {
      await statusIndicator.updateFooter();
      return;
    }

    try {
      if (commitConfig.trigger === "turn_end") {
        const result = await organizeWipCommits(pi, ctx, config, event);

        for (const event of result.events) {
          switch (event.type) {
            case "info":
              ctx.ui.notify(event.message, "info");
              break;
            case "error":
              ctx.ui.notify(event.message, "error");
              break;
            case "organised":
              ctx.ui.notify(
                `Organised ${event.checkpointCount} checkpoint(s) into ${event.commitCount} commit(s).`,
                "info",
              );
              break;
            case "fallback":
              ctx.ui.notify(event.message, "warning");
              break;
            case "stage-changed":
              await statusIndicator.updateFooter();
              break;
          }
        }
        await statusIndicator.updateFooter();
      } else {
        const result = await runCommitPipeline(pi, ctx, config, {
          skipFileSelection: true,
          // No hooks → onMessageGenerated undefined → commit without confirmation
        });

        for (const event of result.events) {
          switch (event.type) {
            case "info":
              ctx.ui.notify(event.message, "info");
              break;
            case "error":
              ctx.ui.notify(event.message, "error");
              break;
            case "dry-run":
              ctx.ui.notify(event.message, "info");
              break;
            case "committed":
              ctx.ui.notify(event.message, "info");
              break;
            case "cancelled":
              ctx.ui.notify(event.reason, "info");
              break;
            case "stage-changed":
              await statusIndicator.updateFooter();
              break;
          }
        }
        await statusIndicator.updateFooter();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `commitEveryTurn: error — ${message}`,
        "error",
      );
      await statusIndicator.updateFooter();
    }
  });
}
