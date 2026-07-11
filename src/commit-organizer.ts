import type {
  AgentEndEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { OrganizerResult, PipelineEvent } from "./commit-events.js";
import type { PiAutocommitConfig } from "./config.js";
import {
  completeCommitGroups,
  completeSingleMessage,
  extractAssistantContext,
  type CommitGroup,
  type CompleteFn,
} from "./commit-prompt.js";
import type { CommitStore } from "./commit-store.js";

/** Marker used for checkpoint commits created at `turn_end`. */
export const CHECKPOINT_COMMIT_MARKER = "wip(checkpoint):";

/**
 * Result of checking whether matching checkpoints are contiguous at HEAD.
 */
interface ContiguityCheck {
  /** True when every matching checkpoint is contiguous at the top of HEAD. */
  contiguous: boolean;
  /**
   * Number of consecutive matching checkpoints from HEAD (only meaningful when
   * `contiguous` is true).
   */
  matchCount: number;
}

/**
 * At `agent_end`, detect any checkpoint commits created during the agent
 * loop and reorganise them into logical Conventional Commits.
 *
 * The function uses the current model to analyse the combined diff and the
 * assistant's own explanations (from `event.messages`) to decide how to split
 * the changes. If the LLM call fails or the response cannot be parsed, it
 * falls back to a single Conventional Commit containing all changes.
 *
 * @param targetSessionId When provided, only reorganise checkpoint commits
 *   whose `Checkpoint-Session` trailer matches. Scattered (non-consecutive)
 *   matching commits from older sessions are NOT handled here — use
 *   {@link reorganiseCheckpointsManual} for that.
 */
export async function organizeCheckpointCommits(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  event: AgentEndEvent,
  store: CommitStore,
  complete?: CompleteFn,
  targetSessionId?: string,
): Promise<OrganizerResult> {
  const events: PipelineEvent[] = [];
  let organised = false;

  if (!(await store.isInsideGitRepo())) {
    return { events, organised: false };
  }

  const checkpointCount = await store.countCheckpointCommits(CHECKPOINT_COMMIT_MARKER, targetSessionId);
  if (checkpointCount === 0) {
    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });
    return { events, organised: false };
  }

  // Undo the checkpoint commits but keep all their changes staged.
  await store.resetSoft(checkpointCount);

  try {
    const groups = await proposeCommitGroups(ctx, config, event, store, complete);
    if (groups.length === 0) {
      // No logical groups: fall back to one commit.
      await fallbackSingleCommit(ctx, config, store, events, complete);
      organised = true;
      events.push({
        type: "stage-changed",
        hasChanges: await store.checkUncommittedChanges(),
      });
      return { events, organised };
    }

    // Stage and commit each logical group in order.
    let commitCount = 0;
    for (const group of groups) {
      await store.unstageAll();
      await store.stageFiles(group.files);

      // Skip groups with no staged changes (e.g. duplicate files already committed).
      if (!(await store.hasStagedChanges())) {
        events.push({
          type: "info",
          message: `Skipped empty commit group: ${group.message.split("\n")[0]}`,
        });
        continue;
      }

      commitCount++;
      const result = await store.commit(group.message);
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || "Unknown error";
        throw new Error(
          `Commit failed (code ${result.code}): ${detail}`,
        );
      }
    }

    events.push({
      type: "organised",
      checkpointCount: checkpointCount,
      commitCount,
    });
    organised = true;
    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });
    return { events, organised };
  } catch (error) {
    // Fall back to a single commit so checkpoint commits are not left half-organised.
    try {
      await store.stageAll();
      await fallbackSingleCommit(ctx, config, store, events, complete);
      organised = true;
    } catch {
      const message = error instanceof Error ? error.message : String(error);
      events.push({
        type: "error",
        message: `pi-autocommit: reorganisation failed — ${message}`,
      });
    }
    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });
    return { events, organised };
  }
}

/**
 * Entry point for the manual `/autocommit-organise` command.
 *
 * When `targetSessionId` is omitted, reorganises ALL reachable checkpoint commits at
 * HEAD (same as the no-argument manual command). When provided, reorganises
 * only the commits that carry that session's `Checkpoint-Session` trailer,
 * handling both contiguous and scattered (interleaved) cases.
 *
 * @param complete Optional LLM adapter (injected in tests).
 */
export async function reorganiseCheckpointsManual(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  store: CommitStore,
  targetSessionId?: string,
  complete?: CompleteFn,
): Promise<OrganizerResult> {
  const events: PipelineEvent[] = [];
  let organised = false;

  if (!(await store.isInsideGitRepo())) {
    return { events, organised: false };
  }

  const reachableCheckpoints = await store.findReachableCheckpoints(CHECKPOINT_COMMIT_MARKER);
  if (reachableCheckpoints.length === 0) {
    events.push({
      type: "info",
      message: "No checkpoint commits found at HEAD.",
    });
    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });
    return { events, organised: false };
  }

  // ── No target session: reorganise ALL checkpoint commits (consecutive only) ──
  if (targetSessionId === undefined) {
    const checkpointCount = await store.countCheckpointCommits(CHECKPOINT_COMMIT_MARKER);
    if (checkpointCount === 0) {
      events.push({
        type: "stage-changed",
        hasChanges: await store.checkUncommittedChanges(),
      });
      return { events, organised: false };
    }
    await store.resetSoft(checkpointCount);
    return assembleAndCommit(ctx, config, store, checkpointCount, events, "", complete);
  }

  // ── Target session: check contiguity ────────────────────────────────
  const targetCheckpoints = reachableCheckpoints.filter((w) => w.session === targetSessionId);
  if (targetCheckpoints.length === 0) {
    events.push({
      type: "info",
      message: `No checkpoint commits found for session ${targetSessionId}.`,
    });
    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });
    return { events, organised: false };
  }

  const contiguity = checkContiguity(reachableCheckpoints, targetSessionId);

  if (contiguity.contiguous) {
    // Contiguous from HEAD: happy path.
    await store.resetSoft(contiguity.matchCount);
    return assembleAndCommit(
      ctx,
      config,
      store,
      contiguity.matchCount,
      events,
      "",
      complete,
    );
  }

  // ── Scattered case: reassemble via git apply --cached ────────────────
  // Order oldest-first so diffs apply sequentially without conflict.
  const oldestFirst = [...targetCheckpoints].reverse();
  for (const commit of oldestFirst) {
    const result = await store.applyCommitDiffToIndex(commit.sha);
    if (!result.success) {
      events.push({
        type: "error",
        message: `散在チェックポイントの適用に失敗しました — ${result.error || "不明なエラー"}。手動で解決してください。`,
      });
      return { events, organised: false };
    }
  }

  return assembleAndCommit(
    ctx,
    config,
    store,
    targetCheckpoints.length,
    events,
    "",
    complete,
  );
}

/**
 * Shared post-stage-assembly pipeline: propose commit groups, commit them,
 * and return an {@link OrganizerResult}.
 *
 * Expects the caller to have already assembled the desired staged state
 * (via `resetSoft` or `applyCommitDiffToIndex`).
 *
 * @param reasoning Assistant reasoning text (empty string for manual
 *   commands).
 * @param complete Optional LLM adapter for tests.
 */
async function assembleAndCommit(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  store: CommitStore,
  checkpointCount: number,
  events: PipelineEvent[],
  reasoning: string,
  complete?: CompleteFn,
): Promise<OrganizerResult> {
  let organised = false;

  try {
    const groups = await proposeCommitGroupsFromReasoning(
      ctx,
      config,
      store,
      reasoning,
      complete,
    );

    if (groups.length === 0) {
      await fallbackSingleCommit(ctx, config, store, events);
      organised = true;
      events.push({
        type: "stage-changed",
        hasChanges: await store.checkUncommittedChanges(),
      });
      return { events, organised };
    }

    let commitCount = 0;
    for (const group of groups) {
      await store.unstageAll();
      await store.stageFiles(group.files);

      // Skip groups with no staged changes (e.g. duplicate files already committed).
      if (!(await store.hasStagedChanges())) {
        events.push({
          type: "info",
          message: `Skipped empty commit group: ${group.message.split("\n")[0]}`,
        });
        continue;
      }

      commitCount++;
      const result = await store.commit(group.message);
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || "Unknown error";
        throw new Error(
          `Commit failed (code ${result.code}): ${detail}`,
        );
      }
    }

    events.push({
      type: "organised",
      checkpointCount,
      commitCount,
    });
    organised = true;
    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });
    return { events, organised };
  } catch (error) {
    try {
      await store.stageAll();
      await fallbackSingleCommit(ctx, config, store, events);
      organised = true;
    } catch {
      const message =
        error instanceof Error ? error.message : String(error);
      events.push({
        type: "error",
        message: `pi-autocommit: reorganisation failed — ${message}`,
      });
    }
    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });
    return { events, organised };
  }
}

/**
 * Check whether all commits matching `targetSessionId` are contiguous at
 * the very top of the `reachableCheckpoints` list (i.e. HEAD is one of them and
 * every commit before the first non-matching one also matches).
 */
function checkContiguity(
  reachableCheckpoints: Array<{
    sha: string;
    subject: string;
    session: string | null;
  }>,
  targetSessionId: string,
): ContiguityCheck {
  let matchCount = 0;
  for (const checkpoint of reachableCheckpoints) {
    if (checkpoint.session === targetSessionId) {
      matchCount++;
    } else {
      break;
    }
  }
  return {
    contiguous: matchCount > 0,
    matchCount,
  };
}

/**
 * Ask the commit prompt module to split the staged diff into logical
 * commit groups, using the agent's own reasoning as context.
 */
async function proposeCommitGroups(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  event: AgentEndEvent,
  store: CommitStore,
  complete?: CompleteFn,
): Promise<CommitGroup[]> {
  const { diff } = await store.getStagedMaterials();
  if (!diff) {
    return [];
  }

  const reasoning = extractAssistantContext(event.messages);
  return completeCommitGroups(ctx, config, { diff, reasoning }, complete);
}

/**
 * Overload of {@link proposeCommitGroups} that accepts a raw reasoning
 * string instead of an `AgentEndEvent` (used by the manual command).
 */
async function proposeCommitGroupsFromReasoning(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  store: CommitStore,
  reasoning: string,
  complete?: CompleteFn,
): Promise<CommitGroup[]> {
  const { diff } = await store.getStagedMaterials();
  if (!diff) {
    return [];
  }
  return completeCommitGroups(ctx, config, { diff, reasoning }, complete);
}

/**
 * Fall back to a single Conventional Commit for all staged changes.
 *
 * One call to {@link completeSingleMessage} absorbs the LLM path and the
 * heuristic path alike — so the reorganiser's fallback no longer triggers a
 * second silent LLM roundtrip.
 */
async function fallbackSingleCommit(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  store: CommitStore,
  events: PipelineEvent[],
  complete?: CompleteFn,
): Promise<void> {
  const { diff, nameStatus, stat } = await store.getStagedMaterials();

  const message = await completeSingleMessage(
    ctx,
    config,
    { diff, nameStatus, stat },
    complete,
  );

  const result = await store.commit(message);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "Unknown error";
    throw new Error(
      `Fallback commit failed (code ${result.code}): ${detail}`,
    );
  }

  events.push({
    type: "fallback",
    message: `Reorganisation fell back to a single commit:\n${message.split("\n")[0]}`,
  });
}
