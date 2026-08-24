import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PipelineEvent } from "./commit-events.js";
import type { CommitGroup } from "./commit-prompt.js";
import { type CompleteFn, completeSingleMessage } from "./commit-prompt.js";
import type { PiAutocommitConfig } from "./config.js";
import type { ReorganiserStore } from "./reorganiser-store.js";

/**
 * Stage and commit each logical group in order.
 *
 * Skips groups with no staged changes. Throws when a commit fails so the
 * caller can catch and run the fallback path.
 *
 * Also throws when the groups do not cover every staged file: the prompt
 * contract is "every file in exactly one group, no omissions", so a group
 * partition that drops a file would otherwise leave that change silently
 * uncommitted. Throwing routes the caller into the fallback single-commit
 * path, which stages and commits everything remaining.
 *
 * @returns The number of commits actually executed.
 */
export async function commitGroups(
  store: ReorganiserStore,
  groups: CommitGroup[],
  events: PipelineEvent[],
): Promise<number> {
  // Capture the full staged file set before group staging mutates the index.
  const { nameStatus } = await store.getStagedMaterials();
  const stagedPaths = parseNameStatusPaths(nameStatus);

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
      throw new Error(`Commit failed (code ${result.code}): ${detail}`);
    }
  }

  // Coverage guard: every staged file must be claimed by at least one group.
  const covered = new Set(groups.flatMap((g) => g.files));
  const missing = stagedPaths.filter((p) => !covered.has(p));
  if (missing.length > 0) {
    throw new Error(
      `Commit groups do not cover ${missing.length} staged file(s): ` +
        `${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}. ` +
        "Falling back to a single commit.",
    );
  }

  return commitCount;
}

/**
 * Parse `git diff --cached --name-status` output into the staged paths.
 * Rename lines carry three tab-separated fields (status, old path, new path);
 * the new path is the one a commit group would reference.
 */
function parseNameStatusPaths(nameStatus: string): string[] {
  const paths: string[] = [];
  for (const line of nameStatus.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    const path = parts.length >= 3 ? parts[2] : parts[1];
    if (path) paths.push(path);
  }
  return paths;
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
    throw new Error(`Fallback commit failed (code ${result.code}): ${detail}`);
  }

  events.push({
    type: "fallback",
    message: `Reorganisation fell back to a single commit:\n${message.split("\n")[0]}`,
  });
}
