import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { showStatusViewer } from "./status-viewer.js";
import { runCommitPipeline } from "./pipeline.js";
import { parseCommitArgs } from "./args.js";
import { confirmCommitMessage } from "./confirmation.js";
import { GitOperations } from "./git-operations.js";
import {
  checkCritAvailable,
  runReviewFlow,
  ReviewSendToAgentError,
  ReviewCancelledError,
} from "./reviewer.js";

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
              const result = await runReviewFlow(pi, ctx, {
                selectedFiles: pipelineCtx.selectedFiles,
                fileDetails: pipelineCtx.fileDetails,
                stagedDiff: pipelineCtx.stagedDiff,
              });

              if (result.reviewContext) {
                opts.llmExtraContext = result.reviewContext;
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
          return;
        }

        if (error instanceof ReviewCancelledError) {
          ctx.ui.notify(error.message, "info");
          return;
        }

        const message =
          error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`git-review error: ${message}`, "error");
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
  // Auto-commit on agent_end (commitEveryTurn)
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
        `commitEveryTurn: error — ${message}`,
        "error",
      );
    }
  });
}

