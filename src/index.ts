import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { shouldCreateWipCommit } from "./commit-decider.js";
import type { PipelineEvent } from "./commit-events.js";
import { organizeWipCommits } from "./commit-organizer.js";
import { loadConfig } from "./config.js";
import { GitOperations } from "./git-operations.js";
import { runCheckpointCommit } from "./pipeline.js";
import { StatusIndicator } from "./status-indicator.js";

/**
 * Dispatch pipeline events to the UI.
 *
 * Shared by checkpoint commits (`turn_end`) and the reorganiser (`agent_end`).
 */
async function handlePipelineEvents(
  ctx: ExtensionContext,
  statusIndicator: StatusIndicator,
  events: PipelineEvent[],
): Promise<void> {
  for (const event of events) {
    switch (event.type) {
      case "info":
        ctx.ui.notify(event.message, "info");
        break;
      case "error":
        ctx.ui.notify(event.message, "error");
        break;
      case "committed":
        ctx.ui.notify(event.message, "info");
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
}

/**
 * pi-autocommit extension
 *
 * Automatically commits changes inside pi using a checkpoint-then-reorganise
 * strategy so the user does not have to write commit messages.
 *
 * - `turn_end`: create a lightweight checkpoint commit when a turn mutated
 *   files.
 * - `agent_end`: soft-reset the checkpoint commits and reorganise them into
 *   logical Conventional Commits via the LLM.
 *
 * A footer indicator shows whether the working tree has uncommitted changes,
 * so the user can spot unintended files before a checkpoint captures them.
 */
export default function (pi: ExtensionAPI) {
  // ───────────────────────────────────────────────────────
  // Show uncommitted changes indicator in footer
  // ───────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const statusIndicator = new StatusIndicator(new GitOperations(pi), ctx);
    await statusIndicator.updateFooter();
  });

  // ───────────────────────────────────────────────────────
  // Auto-commit on turn_end (checkpoint commits)
  // ───────────────────────────────────────────────────────

  pi.on("turn_end", async (event, ctx) => {
    const statusIndicator = new StatusIndicator(new GitOperations(pi), ctx);
    const config = loadConfig(ctx.cwd);

    if (!config.enable) {
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
      const result = await runCheckpointCommit(
        pi,
        `wip(checkpoint): auto-commit at turn ${event.turnIndex + 1}`,
      );

      await handlePipelineEvents(ctx, statusIndicator, result.events);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-autocommit: checkpoint error — ${message}`, "error");
      await statusIndicator.updateFooter();
    }
  });

  // ───────────────────────────────────────────────────────
  // Auto-commit on agent_end (reorganise checkpoints)
  // ───────────────────────────────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    const statusIndicator = new StatusIndicator(new GitOperations(pi), ctx);
    const config = loadConfig(ctx.cwd);

    if (!config.enable) {
      await statusIndicator.updateFooter();
      return;
    }

    try {
      const result = await organizeWipCommits(pi, ctx, config, event);

      await handlePipelineEvents(ctx, statusIndicator, result.events);
      await statusIndicator.updateFooter();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-autocommit: error — ${message}`, "error");
      await statusIndicator.updateFooter();
    }
  });
}
