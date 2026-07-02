import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiGitConfig } from "./config.js";
import { GitOperations } from "./git-operations.js";
import { selectFiles, type FileDetail } from "./file-selector.js";
import { generateCommitMessageWithLLM } from "./llm-commit.js";
import { parseNameStatus } from "./git-parser.js";
import type { MessageAction } from "./confirmation.js";

// ── Type definitions ─────────────────────────────────────

/**
 * Snapshot of pipeline state passed to hooks.
 */
export interface PipelineContext {
  /** pi extension API, needed for crit review etc. */
  pi: ExtensionAPI;
  /** Files the user selected to include in this commit */
  selectedFiles: string[];
  /** Per-file diff details (for QuickLook preview) */
  fileDetails: Map<string, FileDetail> | undefined;
  /** Combined staged diff (git diff --cached) */
  stagedDiff: string;
  /** Staged stat (git diff --cached --stat) */
  stagedStat: string;
  /** Staged name-status (git diff --cached --name-status) */
  stagedNameStatus: string;
}

/**
 * Hooks to customise pipeline behaviour per command.
 */
export interface CommitPipelineHooks {
  /**
   * Called after staging and file selection, before LLM message generation.
   *
   * Use this for crit review or other pre-generation workflows.
   * The `options` parameter is the same mutable object passed to
   * `runCommitPipeline`, so hooks can set `options.llmExtraContext`
   * to pass data to the LLM generation step.
   *
   * Throw to abort the pipeline (cleanup is handled automatically).
   */
  onBeforeGenerate?: (
    ctx: PipelineContext,
    options: CommitPipelineOptions,
  ) => Promise<void>;

  /**
   * Called after the commit message has been generated (or inline message
   * resolved). Implement the confirmation loop here.
   *
   * When undefined, the pipeline commits immediately without confirmation
   * (used by agent_end auto-commit).
   */
  onMessageGenerated?: (message: string) => Promise<MessageAction>;

  /**
   * Called after a successful commit. Reserved for future extensions
   * (e.g. post-commit actions).
   */
  postCommit?: () => Promise<void>;
}

/**
 * Options for customising the commit pipeline.
 */
export interface CommitPipelineOptions {
  hooks?: CommitPipelineHooks;

  /**
   * When set, skip LLM generation and use this message directly.
   * Staging and file selection still run.
   */
  inlineMessage?: string;

  /**
   * When true, skip the actual `git commit` command.
   * All other steps (staging, file selection, LLM generation,
   * confirmation) run normally. No files are unstaged on dry-run.
   */
  dryRun?: boolean;

  /**
   * When true, skip the interactive file selection UI.
   * All staged files are included in the commit.
   * Used by agent_end auto-commit.
   */
  skipFileSelection?: boolean;

  /**
   * Label for the confirm button in the file selector.
   * Defaults to "confirm" when omitted.
   */
  confirmLabel?: string;

  /**
   * Extra context string passed to the LLM when generating the commit
   * message. Used to pass crit review comments as additional context.
   *
   * Typically set by the `onBeforeGenerate` hook via the mutable options
   * reference.
   *
   * NOTE: Ignored when `inlineMessage` is set (no LLM generation occurs).
   */
  llmExtraContext?: string;
}

// ── Pipeline implementation ──────────────────────────────

/**
 * Run the full commit pipeline.
 *
 * Steps:
 *   1. Verify git repository
 *   2. Check for merge conflicts
 *   3. Check for uncommitted changes
 *   4. Stage all files (`git add -A`)
 *   5. File selection (interactive or skip)
 *   6. Unstage files the user did NOT select
 *   7. Collect staged diff/stat/name-status
 *   8. Call `onBeforeGenerate` hook
 *   9. Determine commit message (inline, LLM, or heuristic fallback)
 *  10. Call `onMessageGenerated` hook for confirmation
 *  11. Execute `git commit` (unless dryRun)
 *  12. Call `postCommit` hook
 *  13. Update footer status
 *
 * Error boundary: the entire pipeline is wrapped in try/catch/finally.
 * On any error (hook throw, git failure, etc.), the pipeline guarantees
 * `unstageAll` + footer update, then re-throws to the caller.
 * The caller is responsible for user-facing error notification.
 */
export async function runCommitPipeline(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: PiGitConfig,
  options?: CommitPipelineOptions,
): Promise<void> {
  const git = new GitOperations(pi);
  const hooks = options?.hooks;
  const dryRun = options?.dryRun ?? false;
  const updateFooter = async () => {
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
  };

  // Error boundary: cleanup + re-throw
  try {
    // ── 1. Verify git repository ────────────────────────
    if (!(await git.isInsideGitRepo())) {
      ctx.ui.notify("Not a git repository", "error");
      return;
    }

    // ── 2. Check for merge conflict ─────────────────────
    if (await git.hasMergeConflict()) {
      ctx.ui.notify(
        "Merge conflict in progress. Please resolve conflicts first.",
        "error",
      );
      return;
    }

    // ── 3. Check for changes ────────────────────────────
    const status = await git.checkStatus();
    if (!status.hasChanges) {
      ctx.ui.notify("No changes to commit", "info");
      await updateFooter();
      return;
    }

    // ── 4. Stage all files ──────────────────────────────
    await git.stageAll();

    // ── 5. File selection ───────────────────────────────
    const nameStatusBeforeSelect = await git.getStagedNameStatus();

    // Pre-fetch per-file diffs and stats for QuickLook preview (TUI only)
    let fileDetails: Map<string, FileDetail> | undefined;
    if (ctx.mode === "tui" && !options?.skipFileSelection) {
      fileDetails = new Map();
      const parsed = parseNameStatus(nameStatusBeforeSelect);
      await Promise.all(
        parsed.map(async (entry) => {
          const [diffResult, numstatResult] = await Promise.all([
            git.getFileStagedDiff(entry.path),
            git.getFileStagedNumstat(entry.path),
          ]);
          fileDetails!.set(entry.path, {
            diff: diffResult,
            additions: numstatResult.additions,
            deletions: numstatResult.deletions,
          });
        }),
      );
    }

    let selectedFiles: string[] | null;
    if (options?.skipFileSelection) {
      selectedFiles = parseNameStatus(nameStatusBeforeSelect).map(
        (e) => e.path,
      );
    } else {
      selectedFiles = await selectFiles(ctx, nameStatusBeforeSelect, {
        fileDetails: fileDetails && fileDetails.size > 0
          ? fileDetails
          : undefined,
        confirmLabel: options?.confirmLabel,
      });
    }

    // Handle cancellation (null) or empty selection ([])
    if (selectedFiles === null || selectedFiles.length === 0) {
      await git.unstageAll();
      ctx.ui.notify(
        selectedFiles === null
          ? "Commit cancelled (no files selected)."
          : "No files selected — nothing to commit.",
        "info",
      );
      await updateFooter();
      return;
    }

    // ── 6. Unstage non-selected files ───────────────────
    const allParsed = parseNameStatus(nameStatusBeforeSelect);
    for (const entry of allParsed) {
      if (!selectedFiles.includes(entry.path)) {
        await git.unstageFile(entry.path);
      }
    }

    // ── 7. Collect staged info ──────────────────────────
    const stagedNameStatus = await git.getStagedNameStatus();
    const stagedStat = await git.getStagedStat();
    const stagedDiff = await git.getStagedDiff();

    const pipelineCtx: PipelineContext = {
      pi,
      selectedFiles,
      fileDetails,
      stagedDiff,
      stagedStat,
      stagedNameStatus,
    };

    // ── 8. onBeforeGenerate hook ────────────────────────
    if (hooks?.onBeforeGenerate) {
      await hooks.onBeforeGenerate(pipelineCtx, options ?? {});
    }

    // ── 9. Determine commit message ─────────────────────
    let fullMessage: string;

    if (options?.inlineMessage) {
      fullMessage = options.inlineMessage;
    } else {
      ctx.ui.notify("Generating commit message via LLM...", "info");
      fullMessage = await generateCommitMessageWithLLM(
        pi,
        ctx,
        stagedNameStatus,
        stagedStat,
        stagedDiff,
        config,
        options?.llmExtraContext,
      );
    }

    // ── 10. onMessageGenerated hook (confirmation) ──────
    if (hooks?.onMessageGenerated) {
      const action = await hooks.onMessageGenerated(fullMessage);

      if (action.action === "cancel") {
        ctx.ui.notify("Commit cancelled.", "info");
        await git.unstageAll();
        await updateFooter();
        return;
      }

      if (action.action === "edit") {
        fullMessage = action.message;
      }
      // "commit" → proceed as-is
    }

    // ── 11. Execute commit ──────────────────────────────
    if (dryRun) {
      ctx.ui.notify(
        `[DRY RUN] Skipped. Would commit with:\n\n${fullMessage}`,
        "info",
      );
      await updateFooter();
      return;
    }

    const result = await git.commit(fullMessage);
    if (result.code !== 0) {
      throw new Error(
        `Commit failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
      );
    }

    ctx.ui.notify(
      `Committed successfully:\n${result.stdout.trim() || fullMessage.split("\n")[0]}`,
      "info",
    );

    // ── 12. postCommit hook ─────────────────────────────
    if (hooks?.postCommit) {
      await hooks.postCommit();
    }

    // ── 13. Update footer ───────────────────────────────
    await updateFooter();
  } catch (error) {
    // Error boundary: cleanup before re-throwing
    try {
      await git.unstageAll();
    } catch {
      // Best-effort cleanup
    }
    try {
      await updateFooter();
    } catch {
      // Best-effort cleanup
    }
    throw error;
  }
}
