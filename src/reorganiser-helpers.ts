import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PipelineEvent } from "./commit-events.js";
import { completeSingleMessage, type CompleteFn } from "./commit-prompt.js";
import type { CommitGroup } from "./commit-prompt.js";
import type { PiAutocommitConfig } from "./config.js";
import type { ReorganiserStore } from "./reorganiser-store.js";

/**
 * Stage and commit each logical group in order.
 *
 * Skips groups with no staged changes. Throws when a commit fails so the
 * caller can catch and run the fallback path.
 *
 * @returns The number of commits actually executed.
 */
export async function commitGroups(
  store: ReorganiserStore,
  groups: CommitGroup[],
  events: PipelineEvent[],
): Promise<number> {
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
      const detail =
        result.stderr.trim() || result.stdout.trim() || "Unknown error";
      throw new Error(
        `Commit failed (code ${result.code}): ${detail}`,
      );
    }
  }
  return commitCount;
}

/**
 * Fall back to a single Conventional Commit for all staged changes.
 *
 * One call to {@link completeSingleMessage} absorbs the LLM path and the
 * heuristic path alike — so the reorganiser's fallback no longer triggers a
 * second silent LLM roundtrip.
 */
export async function fallbackSingleCommit(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  store: ReorganiserStore,
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
    const detail =
      result.stderr.trim() || result.stdout.trim() || "Unknown error";
    throw new Error(
      `Fallback commit failed (code ${result.code}): ${detail}`,
    );
  }

  events.push({
    type: "fallback",
    message: `Reorganisation fell back to a single commit:\n${message.split("\n")[0]}`,
  });
}
