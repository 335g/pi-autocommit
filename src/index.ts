import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
} from "@earendil-works/pi-tui";
import { shouldCreateCheckpointCommit } from "./commit-decider.js";
import type { PipelineEvent } from "./commit-events.js";
import {
  organizeCheckpointCommits,
  reorganiseCheckpointsManual,
  CHECKPOINT_COMMIT_MARKER,
} from "./commit-organizer.js";
import { loadConfig, saveEnable, saveModel } from "./config.js";
import { GitCommitStore } from "./commit-store.js";
import { GitOperations } from "./git-operations.js";
import { validateModelString } from "./llm-commit.js";
import { CLEAR_VALUE, showModelPopup } from "./model-popup.js";
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
  // Captured from session_start so getArgumentCompletions (which has no
  // ctx) can access the model registry.
  let cachedModelRegistry: ExtensionContext["modelRegistry"] | undefined;
  const git = new GitOperations(pi);

  // ───────────────────────────────────────────────────────
  // /autocommit-enable [true|false]
  // ───────────────────────────────────────────────────────

  pi.registerCommand("autocommit-enable", {
    description:
      "Toggle auto-commit enable (true|false). No arg shows current state.",
    handler: async (args, ctx) => {
      const config = loadConfig(ctx.cwd);
      const trimmed = args?.trim().toLowerCase();

      if (trimmed === "") {
        ctx.ui.notify(`pi-autocommit: enable = ${config.enable}`, "info");
        return;
      }

      if (trimmed !== "true" && trimmed !== "false") {
        ctx.ui.notify("Usage: /autocommit-enable <true|false>", "error");
        return;
      }

      const enable = trimmed === "true";
      saveEnable(ctx.cwd, enable);
      ctx.ui.notify(`pi-autocommit: enable = ${enable}`, "info");
    },
  });

  // ───────────────────────────────────────────────────────
  // /autocommit-model [provider/modelId | clear]
  // ───────────────────────────────────────────────────────

  /**
   * Persist the model chosen from the popup, sharing the notify logic
   * between the TUI overlay and the non-TUI fallback.
   */
  function applyModelChoice(
    ctx: ExtensionContext,
    choice: string | null,
  ): void {
    if (choice === null) {
      return; // cancelled
    }

    if (choice === CLEAR_VALUE) {
      saveModel(ctx.cwd, undefined);
      ctx.ui.notify("pi-autocommit: model = session model", "info");
      return;
    }

    saveModel(ctx.cwd, choice);
    ctx.ui.notify(`pi-autocommit: model = ${choice}`, "info");
  }

  pi.registerCommand("autocommit-model", {
    description:
      'Set the LLM model for commit message generation (provider/modelId). No arg shows a selector popup. Pass "clear" to fall back to the session model.',
    getArgumentCompletions: (
      argumentPrefix: string,
    ): AutocompleteItem[] | null => {
      if (!cachedModelRegistry) {
        return null;
      }

      const items: AutocompleteItem[] = [
        {
          value: "clear",
          label: "clear (use session model)",
          description:
            "Clear the model setting, fall back to the session model.",
        },
      ];

      for (const model of cachedModelRegistry.getAvailable()) {
        const value = `${model.provider}/${model.id}`;
        items.push({
          value,
          label: value,
          description: model.name,
        });
      }

      const prefix = argumentPrefix.toLowerCase();
      const filtered = items.filter(
        (item) =>
          item.value.toLowerCase().startsWith(prefix) ||
          item.label.toLowerCase().includes(prefix),
      );
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const config = loadConfig(ctx.cwd);
      const trimmed = args?.trim();

      // No argument — show the popup (requires UI).
      if (trimmed === "") {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            "pi-autocommit: UI not available. Use /autocommit-model <provider/modelId> or /autocommit-model clear.",
            "error",
          );
          return;
        }
        const choice = await showModelPopup(ctx, config.model);
        applyModelChoice(ctx, choice);
        return;
      }

      // "clear" — fall back to the session model.
      if (trimmed.toLowerCase() === "clear") {
        saveModel(ctx.cwd, undefined);
        ctx.ui.notify(`pi-autocommit: model = session model`, "info");
        return;
      }

      // Direct provider/modelId — validate before saving.
      const result = validateModelString(ctx, trimmed);
      if (result.ok) {
        saveModel(ctx.cwd, trimmed);
        ctx.ui.notify(`pi-autocommit: model = ${trimmed}`, "info");
        return;
      }

      // Validation failed — notify and fall back to the popup.
      ctx.ui.notify(`pi-autocommit: ${result.reason}`, "error");
      if (ctx.hasUI) {
        const choice = await showModelPopup(ctx, config.model);
        applyModelChoice(ctx, choice);
      }
    },
  });

  // ───────────────────────────────────────────────────────
  // /autocommit-organise [sessionId?]
  // ───────────────────────────────────────────────────────

  pi.registerCommand("autocommit-organise", {
    description:
      "Reorganise checkpoint commits. No arg: all checkpoints. " +
      "With a session filter, reorganise only that session's checkpoints " +
      "(including scattered ones).",
    handler: async (args, ctx) => {
      const statusIndicator = new StatusIndicator(
        git,
        ctx,
      );
      const config = loadConfig(ctx.cwd);
      const trimmed = args?.trim();

      // No argument: reorganise all reachable checkpoint commits (session-agnostic).
      if (trimmed === "") {
        const store = new GitCommitStore(git);
        const result = await reorganiseCheckpointsManual(ctx, config, store);
        await handlePipelineEvents(ctx, statusIndicator, result.events);
        await statusIndicator.updateFooter();
        return;
      }

      // Session ID provided directly as argument.
      const store = new GitCommitStore(git);
      const result = await reorganiseCheckpointsManual(
        ctx,
        config,
        store,
        trimmed,
      );
      await handlePipelineEvents(ctx, statusIndicator, result.events);
      await statusIndicator.updateFooter();
    },
    getArgumentCompletions: async (
      _argumentPrefix: string,
    ): Promise<AutocompleteItem[] | null> => {
      try {
        git
        const commits = await git.findReachableCheckpoints(CHECKPOINT_COMMIT_MARKER);
        const sessions = [
          ...new Set(commits.map((w) => w.session).filter((s): s is string => s !== null)),
        ];
        return sessions.map((s) => ({
          value: s,
          label: s,
          description: "Reorganise only this session's checkpoint commits",
        }));
      } catch {
        return null;
      }
    },
  });

  // ───────────────────────────────────────────────────────
  // Show uncommitted changes indicator in footer
  // ───────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    cachedModelRegistry = ctx.modelRegistry;
    const statusIndicator = new StatusIndicator(git, ctx);
    await statusIndicator.updateFooter();

    // Notify the user if unreorganised checkpoints remain (crash recovery).
    try {
      const commits = await git.findReachableCheckpoints(CHECKPOINT_COMMIT_MARKER);
      if (commits.length > 0) {
        ctx.ui.notify(
          `pi-autocommit: 未整理のチェックポイントが残っています。/autocommit-organise で整理できます`,
          "warning",
        );
      }
    } catch {
      // Best-effort: ignore errors during startup check.
    }
  });

  // ───────────────────────────────────────────────────────
  // Auto-commit on turn_end (checkpoint commits)
  // ───────────────────────────────────────────────────────

  pi.on("turn_end", async (event, ctx) => {
    const statusIndicator = new StatusIndicator(git, ctx);
    const config = loadConfig(ctx.cwd);

    if (!config.enable) {
      return;
    }

    if (!shouldCreateCheckpointCommit(event.toolResults)) {
      return;
    }

    if (!(await git.isInsideGitRepo())) {
      return;
    }

    if (!(await git.checkUncommittedChanges())) {
      return;
    }

    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const result = await runCheckpointCommit(
        git,
        `wip(checkpoint): auto-commit at turn ${event.turnIndex + 1}`,
        sessionId,
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
    const statusIndicator = new StatusIndicator(git, ctx);
    const config = loadConfig(ctx.cwd);

    if (!config.enable) {
      await statusIndicator.updateFooter();
      return;
    }

    try {
      const commitStore = new GitCommitStore(git);
      const sessionId = ctx.sessionManager.getSessionId();
      const result = await organizeCheckpointCommits(
        ctx,
        config,
        event,
        commitStore,
        undefined,
        sessionId,
      );

      await handlePipelineEvents(ctx, statusIndicator, result.events);
      await statusIndicator.updateFooter();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-autocommit: error — ${message}`, "error");
      await statusIndicator.updateFooter();
    }
  });
}
