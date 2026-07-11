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
export const WIP_COMMIT_MARKER = "wip(checkpoint):";

/**
 * At `agent_end`, detect any WIP checkpoint commits created during the agent
 * loop and reorganise them into logical Conventional Commits.
 *
 * The function uses the current model to analyse the combined diff and the
 * assistant's own explanations (from `event.messages`) to decide how to split
 * the changes. If the LLM call fails or the response cannot be parsed, it
 * falls back to a single Conventional Commit containing all changes.
 */
export async function organizeWipCommits(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  event: AgentEndEvent,
  store: CommitStore,
  complete?: CompleteFn,
): Promise<OrganizerResult> {
  const events: PipelineEvent[] = [];
  let organised = false;

  if (!(await store.isInsideGitRepo())) {
    return { events, organised: false };
  }

  const wipCount = await store.countWipCommits(WIP_COMMIT_MARKER);
  if (wipCount === 0) {
    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });
    return { events, organised: false };
  }

  // Undo the WIP commits but keep all their changes staged.
  await store.resetSoft(wipCount);

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
    for (const group of groups) {
      await store.unstageAll();
      await store.stageFiles(group.files);
      const result = await store.commit(group.message);
      if (result.code !== 0) {
        throw new Error(
          `Commit failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
        );
      }
    }

    events.push({
      type: "organised",
      checkpointCount: wipCount,
      commitCount: groups.length,
    });
    organised = true;
    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });
    return { events, organised };
  } catch (error) {
    // Fall back to a single commit so WIP commits are not left half-organised.
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
    throw new Error(
      `Fallback commit failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
    );
  }

  events.push({
    type: "fallback",
    message: `Reorganisation fell back to a single commit:\n${message.split("\n")[0]}`,
  });
}
