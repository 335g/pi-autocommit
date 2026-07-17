import {
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
} from "@earendil-works/pi-tui";
import { shouldCreateCheckpointCommit } from "./commit-decider.js";
import { isGitCommitCommand } from "./commit-guard.js";
import { shouldSkipReorganisation } from "./head-guard.js";
import type { PipelineEvent } from "./commit-events.js";
import {
  organizeCheckpointCommits,
  reorganiseCheckpointsManual,
  reorganiseSelectedRange,
  CHECKPOINT_COMMIT_MARKER,
} from "./commit-organizer.js";
import {
  buildCommitItems,
  showCommitPicker,
  type CommitItem,
} from "./commit-picker.js";
import {
  loadConfig,
  type PiAutocommitConfig,
  saveDeferReorganise,
  saveEnable,
  saveModel,
} from "./config.js";
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
 * Show the commit picker popup and reorganise the selected range.
 *
 * Used by `/autocommit-organise`, `/autocommit-defer false`, and `agent_end`.
 * In TUI mode, shows the picker; in non-TUI mode, auto-reorganises using the
 * appropriate manual or agent_end path.
 *
 * @param manual When `true`, use the manual command reorganise path
 *   (`reorganiseCheckpointsManual`). When `false`, use the agent_end path
 *   (`organizeCheckpointCommits` scoped to the current session).
 * @param emptyMessage Optional message shown when no recent commits are found.
 */
async function maybeRunInteractiveReorganise(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  event: AgentEndEvent,
  statusIndicator: StatusIndicator,
  store: GitCommitStore,
  manual: boolean,
  emptyMessage?: string,
): Promise<void> {
  const raw = await store.getRecentCommits(config.commitPickerMaxCommits);
  const items = buildCommitItems(raw);

  if (items.length === 0) {
    if (emptyMessage) {
      ctx.ui.notify(emptyMessage, "info");
    }
    await statusIndicator.updateFooter();
    return;
  }

  if (ctx.mode === "tui") {
    const loadMore = async (count: number): Promise<CommitItem[]> => {
      const raw = await store.getRecentCommits(10, count);
      return buildCommitItems(raw);
    };

    const range = await showCommitPicker(ctx, items, loadMore);
    if (range !== null) {
      const result = await reorganiseSelectedRange(
        ctx,
        config,
        event,
        store,
        range,
      );
      await handlePipelineEvents(ctx, statusIndicator, result.events);
    } else {
      ctx.ui.notify(
        "pi-autocommit: 整理をキャンセルしました。「/autocommit-organise」で後から整理できます",
        "info",
      );
    }
  } else {
    if (manual) {
      const result = await reorganiseCheckpointsManual(ctx, config, store);
      await handlePipelineEvents(ctx, statusIndicator, result.events);
    } else {
      const sessionId = ctx.sessionManager.getSessionId();
      const result = await organizeCheckpointCommits(
        ctx,
        config,
        event,
        store,
        undefined,
        sessionId,
      );
      await handlePipelineEvents(ctx, statusIndicator, result.events);
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
  // HEAD commit SHA captured at agent_start. Used at agent_end to decide
  // whether the agent run produced any commits.
  let agentBaselineHead: string | null = null;
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
  // /autocommit-defer [true|false]
  // ───────────────────────────────────────────────────────

  pi.registerCommand("autocommit-defer", {
    description:
      "Toggle deferred reorganisation (true|false). When true, checkpoint " +
      "commits are created at turn_end but the commit reorganiser (and " +
      "the agent_end popup) is skipped; use false to show the commit picker " +
      "and reorganise immediately. No arg shows current state.",
    handler: async (args, ctx) => {
      const config = loadConfig(ctx.cwd);
      const trimmed = args?.trim().toLowerCase();

      if (trimmed === "") {
        ctx.ui.notify(
          `pi-autocommit: deferReorganise = ${config.deferReorganise}`,
          "info",
        );
        return;
      }

      if (trimmed !== "true" && trimmed !== "false") {
        ctx.ui.notify("Usage: /autocommit-defer <true|false>", "error");
        return;
      }

      const defer = trimmed === "true";
      saveDeferReorganise(ctx.cwd, defer);
      ctx.ui.notify(`pi-autocommit: deferReorganise = ${defer}`, "info");

      if (!defer) {
        const statusIndicator = new StatusIndicator(git, ctx);
        const store = new GitCommitStore(git);
        const checkpointCount = await store.countCheckpointCommits(
          CHECKPOINT_COMMIT_MARKER,
        );
        if (checkpointCount === 0) {
          ctx.ui.notify(
            "pi-autocommit: 整理対象の checkpoint がありません",
            "info",
          );
          await statusIndicator.updateFooter();
          return;
        }
        const event = { type: "agent_end", messages: [] } as AgentEndEvent;
        await maybeRunInteractiveReorganise(
          ctx,
          config,
          event,
          statusIndicator,
          store,
          true,
        );
        await statusIndicator.updateFooter();
      }
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

      // No argument: show interactive commit picker popup.
      if (trimmed === "") {
        const store = new GitCommitStore(git);
        const event = { type: "agent_end", messages: [] } as AgentEndEvent;
        await maybeRunInteractiveReorganise(
          ctx,
          config,
          event,
          statusIndicator,
          store,
          true,
          "pi-autocommit: コミットが見つかりません",
        );
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
  // /autocommit-test-picker — show commit picker popup with sample data
  // ───────────────────────────────────────────────────────

  pi.registerCommand("autocommit-test-picker", {
    description: "Show the commit picker popup with sample data (for testing).",
    handler: async (_args, ctx) => {
      const items = [
        { sha: "aaa", subject: "wip(checkpoint): turn 5", isCheckpoint: true },
        { sha: "bbb", subject: "wip(checkpoint): turn 4", isCheckpoint: true },
        { sha: "ccc", subject: "wip(checkpoint): turn 3", isCheckpoint: true },
        { sha: "ddd", subject: "feat: implement X", isCheckpoint: false },
        { sha: "eee", subject: "fix: correct Y", isCheckpoint: false },
        { sha: "fff", subject: "chore: update deps", isCheckpoint: false },
        { sha: "ggg", subject: "docs: add readme", isCheckpoint: false },
        { sha: "hhh", subject: "refactor: extract module", isCheckpoint: false },
        { sha: "iii", subject: "wip(checkpoint): turn 2", isCheckpoint: true },
        { sha: "jjj", subject: "wip(checkpoint): turn 1", isCheckpoint: true },
        { sha: "kkk", subject: "test: add integration tests", isCheckpoint: false },
      ];

      const range = await showCommitPicker(ctx, items);
      if (range !== null) {
        ctx.ui.notify(
          `選択範囲: ${range.startIndex} (HEAD) 〜 ${range.endIndex} (HEAD~${range.endIndex})`,
          "info",
        );
      } else {
        ctx.ui.notify("キャンセルしました", "info");
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

    // Notify the user if unreorganised checkpoint commits remain at HEAD
    // (crash recovery). Uses countCheckpointCommits so only consecutive
    // checkpoints at HEAD are reported — scattered historical checkpoints
    // buried under regular commits are silently ignored because they cannot
    // be reorganised by the no-arg command.
    try {
      const checkpointCount = await git.countCheckpointCommits(CHECKPOINT_COMMIT_MARKER);
      if (checkpointCount > 0) {
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
  // Capture baseline HEAD at the start of each agent run
  // ───────────────────────────────────────────────────────

  pi.on("agent_start", async (_event, _ctx) => {
    // Reset per-run baseline. If HEAD cannot be read, leave it as null so
    // agent_end falls back to its normal behaviour.
    agentBaselineHead = await git.getHead();
  });

  // ───────────────────────────────────────────────────────
  // Commit guard: block agent-initiated `git commit` during the agent loop
  // ───────────────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) {
      return;
    }

    const config = loadConfig(ctx.cwd);
    if (!config.enable) {
      return;
    }

    if (!isGitCommitCommand(event.input.command)) {
      return;
    }

    return {
      block: true,
      reason:
        "pi-autocommit がコミットを管理しているため、エージェントループ中の `git commit` はブロックされました。" +
        "turn_end でチェックポイントコミットが自動作成され、agent_end で論理的な Conventional Commits に整理されるため、手動でコミットする必要はありません。",
    };
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

      // Deferred reorganisation: keep creating checkpoints at turn_end,
      // but skip the commit picker popup / auto-reorganise at agent_end.
      if (config.deferReorganise) {
        const checkpointCount = await commitStore.countCheckpointCommits(
          CHECKPOINT_COMMIT_MARKER,
        );
        if (checkpointCount > 0) {
          ctx.ui.notify(
            `pi-autocommit: deferReorganise が有効なため整理をスキップしました（未整理 checkpoint: ${checkpointCount}件）。/autocommit-defer false で整理できます`,
            "info",
          );
        }
        await statusIndicator.updateFooter();
        return;
      }

      // Skip reorganisation when HEAD has not moved since agent_start.
      // This means the agent run produced no commits, so there is nothing
      // to reorganise.
      const currentHead = await commitStore.getHead();
      if (shouldSkipReorganisation(agentBaselineHead, currentHead)) {
        await statusIndicator.updateFooter();
        return;
      }

      await maybeRunInteractiveReorganise(
        ctx,
        config,
        event,
        statusIndicator,
        commitStore,
        false,
      );

      await statusIndicator.updateFooter();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-autocommit: error — ${message}`, "error");
      await statusIndicator.updateFooter();
    }
  });
}
