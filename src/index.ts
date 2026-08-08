import {
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
} from "@earendil-works/pi-tui";
import {
  blockedInterleavingVerb,
  buildBlockReason,
  interleavingAllowedWithoutCheckpoints,
  shouldCreateCheckpointCommit,
  shouldBlockGitCommit,
  shouldBlockGitHardReset,
  shouldBlockGitPush,
  shouldSkipReorganisation,
} from "./commit-policy.js";
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
  isJapanese,
  loadConfig,
  type PiAutocommitConfig,
  saveEnable,
  saveModel,
} from "./config.js";
import { GitCheckpointStore } from "./checkpoint-store.js";
import { GitPickerStore, type PickerStore } from "./picker-store.js";
import { GitReorganiserStore, type ReorganiserStore } from "./reorganiser-store.js";
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
          `Organise complete: ${event.checkpointCount} checkpoint(s) reorganised into ${event.commitCount} commit(s).`,
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
 * Run an async function while showing the organise progress indicator
 * in the TUI working loader row.
 *
 * The indicator is hidden and the working message is restored in the
 * finally block so success and error paths alike clean up the UI.
 */
async function runWithOrganiseProgress<T>(
  ctx: ExtensionContext,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Show a working indicator in the TUI footer during reorganisation.
  // Completion feedback comes from handlePipelineEvents (organised event).
  ctx.ui.setWorkingMessage(label);
  ctx.ui.setWorkingVisible(true);
  try {
    return await fn();
  } finally {
    ctx.ui.setWorkingVisible(false);
    ctx.ui.setWorkingMessage();
  }
}

/**
 * Show the commit picker popup and reorganise the selected range.
 *
 * Used by `/autocommit-organise` and `agent_end`.
 * In TUI mode, shows the picker; in non-TUI mode, auto-reorganises via the
 * manual reorganise path (`reorganiseCheckpointsManual`).
 *
 * @param emptyMessage Optional message shown when no recent commits are found.
 */
async function maybeRunInteractiveReorganise(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  event: AgentEndEvent,
  statusIndicator: StatusIndicator,
  pickerStore: PickerStore,
  reorganiserStore: ReorganiserStore,
  emptyMessage?: string,
): Promise<void> {
  const raw = await pickerStore.getRecentCommits(config.commitPickerMaxCommits);
  const items = buildCommitItems(raw);
  const remoteTipSha = await pickerStore.getUpstreamTip();

  if (items.length === 0) {
    if (emptyMessage) {
      ctx.ui.notify(emptyMessage, "info");
    }
    await statusIndicator.updateFooter();
    return;
  }

  if (ctx.mode === "tui") {
    const loadMore = async (count: number): Promise<CommitItem[]> => {
      const raw = await pickerStore.getRecentCommits(10, count);
      return buildCommitItems(raw);
    };

    const range = await showCommitPicker(ctx, items, loadMore, remoteTipSha);
    if (range !== null) {
      const result = await runWithOrganiseProgress(
        ctx,
        "⏳ Reorganising checkpoint commits...",
        () => reorganiseSelectedRange(ctx, config, event, reorganiserStore, range),
      );
      await handlePipelineEvents(ctx, statusIndicator, result.events);
    } else {
      ctx.ui.notify(
        "pi-autocommit: 整理をキャンセルしました。「/autocommit-organise」で後から整理できます",
        "info",
      );
    }
  } else {
    const result = await runWithOrganiseProgress(
      ctx,
      "⏳ Reorganising checkpoint commits...",
      () => reorganiseCheckpointsManual(ctx, config, reorganiserStore),
    );
    await handlePipelineEvents(ctx, statusIndicator, result.events);
  }
}

/**
 * Read the subject of the HEAD commit, or `null` when HEAD cannot be
 * resolved (e.g. an unborn branch).
 */
async function getHeadSubject(git: GitOperations): Promise<string | null> {
  const raw = await git.getRecentCommits(1);
  const subject = raw.split("\0")[1];
  return subject && subject.length > 0 ? subject : null;
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
        const pickerStore = new GitPickerStore(git);
        const reorganiserStore = new GitReorganiserStore(git);
        const event = { type: "agent_end", messages: [] } as AgentEndEvent;
        await maybeRunInteractiveReorganise(
          ctx,
          config,
          event,
          statusIndicator,
          pickerStore,
          reorganiserStore,
          "pi-autocommit: コミットが見つかりません",
        );
        await statusIndicator.updateFooter();
        return;
      }

      // Session ID provided directly as argument.
      const reorganiserStore = new GitReorganiserStore(git);
      const result = await runWithOrganiseProgress(
        ctx,
        "⏳ Reorganising checkpoint commits...",
        () => reorganiseCheckpointsManual(ctx, config, reorganiserStore, trimmed),
      );
      await handlePipelineEvents(ctx, statusIndicator, result.events);
      await statusIndicator.updateFooter();
    },
    getArgumentCompletions: async (
      _argumentPrefix: string,
    ): Promise<AutocompleteItem[] | null> => {
      try {
        const commits = await git.findReachableCheckpoints(CHECKPOINT_COMMIT_MARKER);
        const sessions = [
          ...new Set(commits.map((w) => w.session).filter((s): s is string => s !== null)),
        ];
        return sessions.map((s) => {
          // Label the origin branch when the session's checkpoints carry one
          // (e.g. a delegated worktree branch) so the cryptic session id is
          // recognisable.
          const branch = commits.find((c) => c.session === s)?.branch;
          return {
            value: s,
            label: branch ? `${branch} · ${s}` : s,
            description: "Reorganise only this session's checkpoint commits",
          };
        });
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

    try {
      const sessionId = ctx.sessionManager.getSessionId();

      // Own-session crash leftovers at HEAD (session-aware so a resumed
      // session only claims its own checkpoints). These are reorganisable
      // via the manual command.
      const checkpointCount = sessionId
        ? await git.countCheckpointCommits(CHECKPOINT_COMMIT_MARKER, sessionId)
        : await git.countCheckpointCommits(CHECKPOINT_COMMIT_MARKER);
      if (checkpointCount > 0) {
        ctx.ui.notify(
          `pi-autocommit: 未整理のチェックポイントが残っています。/autocommit-organise で整理できます`,
          "warning",
        );
      }

      // Foreign-session checkpoints in the un-pushed range: checkpoints
      // merged in from another session's branch (e.g. a delegated worktree
      // agent that crashed before agent_end). These cannot be reorganised
      // after the merge — surface them so the user can decide.
      if (sessionId) {
        const upstreamTip = await git.getUpstreamTip();
        if (upstreamTip) {
          const merged = await git.findCheckpointsSince(
            upstreamTip,
            CHECKPOINT_COMMIT_MARKER,
          );
          const foreign = merged.filter(
            (c) => c.session !== null && c.session !== sessionId,
          );
          if (foreign.length > 0) {
            const origin = foreign[0].branch
              ? `（由来: ${foreign[0].branch}）`
              : "";
            ctx.ui.notify(
              `pi-autocommit: マージによって他セッションの未整理チェックポイントが ${foreign.length} 件取り込まれています${origin}（履歴に wip(checkpoint) が残ります）。ブランチ統合時は \`git merge --squash\` を使うと回避できます。`,
              "warning",
            );
          }
        }
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
  // Git guard: block agent-initiated `git commit` / `git push` during the
  // agent loop
  // ───────────────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) {
      return;
    }

    const config = loadConfig(ctx.cwd);
    if (!config.enable) {
      return;
    }

    const command = event.input.command;
    let blocked = shouldBlockGitCommit(command)
      ? "commit"
      : shouldBlockGitPush(command)
        ? "push"
        : shouldBlockGitHardReset(command)
          ? "reset --hard"
          : blockedInterleavingVerb(command);

    // `git merge --squash` never blocks (blockedInterleavingVerb skips it:
    // no commit is created). Plain merge/cherry-pick only break the
    // checkpoint run when checkpoints sit at HEAD; with a clean HEAD there
    // is nothing to strand below the foreign commit, so allow the
    // integration — e.g. merging a delegated worktree branch from the main
    // session.
    if (blocked === "merge" || blocked === "cherry-pick") {
      const headSubject = await getHeadSubject(git);
      if (
        interleavingAllowedWithoutCheckpoints(
          blocked,
          headSubject,
          CHECKPOINT_COMMIT_MARKER,
        )
      ) {
        blocked = null;
      }
    }

    if (blocked === null) {
      return;
    }

    return {
      block: true,
      reason: buildBlockReason(blocked, isJapanese(config)),
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

    const checkpointStore = new GitCheckpointStore(git);

    if (!(await checkpointStore.isInsideGitRepo())) {
      return;
    }

    if (!(await checkpointStore.checkStatus()).hasChanges) {
      return;
    }

    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const result = await runCheckpointCommit(
        checkpointStore,
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
      const reorganiserStore = new GitReorganiserStore(git);

      // Skip reorganisation when HEAD has not moved since agent_start.
      // This means the agent run produced no commits, so there is nothing
      // to reorganise.
      const currentHead = await git.getHead();
      if (shouldSkipReorganisation(agentBaselineHead, currentHead)) {
        await statusIndicator.updateFooter();
        return;
      }

      // Auto-organise checkpoint commits directly (no interactive popup).
      // The manual /autocommit-organise command is available for interactive
      // use when needed.
      const sessionId = ctx.sessionManager.getSessionId();
      const result = await runWithOrganiseProgress(
        ctx,
        "⏳ チェックポイントを整理中...",
        () =>
          organizeCheckpointCommits(
            ctx,
            config,
            event,
            reorganiserStore,
            undefined,
            sessionId,
          ),
      );
      await handlePipelineEvents(ctx, statusIndicator, result.events);

      // Detect checkpoint commits from other sessions that entered via a
      // merge during this run (e.g. a delegated worktree branch whose agent
      // crashed before agent_end). Their changes are already in the tree and
      // the scattered manual path cannot re-apply them, so they stay in
      // history as wip(checkpoint) — surface them so the user can decide
      // (leave it, or re-integrate with --squash next time).
      if (agentBaselineHead !== null && sessionId !== null) {
        try {
          const merged = await reorganiserStore.findCheckpointsSince(
            agentBaselineHead,
            CHECKPOINT_COMMIT_MARKER,
          );
          const foreign = merged.filter((c) => c.session !== sessionId);
          if (foreign.length > 0) {
            const origin = foreign[0].branch
              ? `（由来: ${foreign[0].branch}）`
              : "";
            ctx.ui.notify(
              `pi-autocommit: マージによって他セッションの未整理チェックポイントが ${foreign.length} 件取り込まれました${origin}（履歴に wip(checkpoint) が残ります）。` +
                "ブランチ統合時は `git merge --squash` を使うと回避できます。",
              "warning",
            );
          }
        } catch {
          // Best-effort: ignore detection errors.
        }
      }

      await statusIndicator.updateFooter();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-autocommit: error — ${message}`, "error");
      await statusIndicator.updateFooter();
    }
  });
}
