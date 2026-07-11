import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  Container,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { shouldCreateWipCommit } from "./commit-decider.js";
import type { PipelineEvent } from "./commit-events.js";
import { organizeWipCommits } from "./commit-organizer.js";
import { loadConfig, saveEnable, saveModel } from "./config.js";
import { GitOperations } from "./git-operations.js";
import { validateModelString } from "./llm-commit.js";
import {
  buildModelSelectItems,
  CLEAR_LABEL,
  CLEAR_VALUE,
  MAX_VISIBLE_MODELS,
} from "./model-popup.js";
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
   * Build the popup option list as plain strings.
   *
   * Used only by the non-TUI fallback (`ctx.ui.select`), which takes string
   * options. The TUI path uses `buildModelSelectItems` (SelectItem[]) with a
   * bounded, scrollable `SelectList` overlay.
   */
  function buildModelOptions(
    ctx: ExtensionContext,
    currentModel: string | undefined,
  ): string[] {
    const markCurrent = (label: string, value: string | undefined): string =>
      value === currentModel ? `${label} (current)` : label;

    const options: string[] = [markCurrent(CLEAR_LABEL, undefined)];

    for (const model of ctx.modelRegistry.getAvailable()) {
      const value = `${model.provider}/${model.id}`;
      options.push(markCurrent(value, value));
    }

    // Mention the current value in case it's not in the available list.
    if (currentModel && !options.some((o) => o.startsWith(currentModel))) {
      options.push(`${currentModel} (current, unavailable)`);
    }

    return options;
  }

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

  /**
   * Show the model selector popup and persist the user's choice.
   *
   * In the TUI, uses a centered overlay with a `SelectList` whose viewport is
   * capped at `MAX_VISIBLE_MODELS` rows and scrolls, so the list never
   * overflows the terminal (which previously clipped the top of a long model
   * list). `overlayOptions.margin` reserves a row of space above and below the
   * popup. In non-TUI modes (e.g. RPC), falls back to `ctx.ui.select`.
   */
  async function showModelPopup(
    ctx: ExtensionContext,
    currentModel: string | undefined,
  ): Promise<void> {
    const current = currentModel ?? "session model";
    const title = `pi-autocommit: select model (current: ${current})`;

    if (ctx.mode === "tui") {
      const items = buildModelSelectItems(ctx, currentModel);
      const maxVisible = Math.min(items.length, MAX_VISIBLE_MODELS);

      const choice = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(
            new DynamicBorder((s: string) => theme.fg("accent", s)),
          );
          container.addChild(
            new Text(theme.fg("accent", theme.bold(title)), 1, 0),
          );
          container.addChild(
            new Text(
              theme.fg("dim", "↑↓ navigate · enter select · esc cancel"),
              1,
              0,
            ),
          );

          const selectList = new SelectList(items, maxVisible, {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText: (t: string) => theme.fg("accent", t),
            description: (t: string) => theme.fg("muted", t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
          });
          selectList.onSelect = (item) => done(item.value);
          selectList.onCancel = () => done(null);
          container.addChild(selectList);

          container.addChild(
            new DynamicBorder((s: string) => theme.fg("accent", s)),
          );

          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              selectList.handleInput(data);
              tui.requestRender();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            maxHeight: "80%",
            margin: 1,
          },
        },
      );

      applyModelChoice(ctx, choice);
      return;
    }

    // Non-TUI (e.g. RPC): fall back to the built-in string select dialog.
    const options = buildModelOptions(ctx, currentModel);
    const choice = await ctx.ui.select(title, options);
    if (choice === undefined) {
      return; // cancelled
    }

    if (choice === CLEAR_LABEL || choice.startsWith(`${CLEAR_LABEL} `)) {
      applyModelChoice(ctx, CLEAR_VALUE);
      return;
    }

    // Strip the trailing `(current)` marker if present.
    applyModelChoice(ctx, choice.replace(/ \(current\)$/, ""));
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
        await showModelPopup(ctx, config.model);
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
        await showModelPopup(ctx, config.model);
      }
    },
  });

  // ───────────────────────────────────────────────────────
  // Show uncommitted changes indicator in footer
  // ───────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    cachedModelRegistry = ctx.modelRegistry;
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
