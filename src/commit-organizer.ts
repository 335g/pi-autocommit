import type {
  AgentEndEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { OrganizerResult, PipelineEvent } from "./commit-events.js";
import {
  type CommitGroup,
  type CompleteFn,
  completeCommitGroups,
  diffExceedsLlmLimit,
  extractAssistantContext,
  MAX_LLM_DIFF_CHARS,
} from "./commit-prompt.js";
import type { PiAutocommitConfig } from "./config.js";
import { commitGroups, fallbackSingleCommit } from "./reorganiser-helpers.js";
import type { ReorganiserStore } from "./reorganiser-store.js";

/**
 * Stage everything for the reorganiser's fallback commit.
 *
 * With `ignoreSubmodules`, gitlink updates and `.gitmodules` are left out so
 * submodule pins never enter a reorganised commit either.
 */
function stageForFallback(
  store: ReorganiserStore,
  config: PiAutocommitConfig,
): Promise<void> {
  return config.ignoreSubmodules
    ? store.stageAllIgnoringSubmodules()
    : store.stageAll();
}

import { detectLanguage, languageName, userMessageTexts } from "./language.js";

/** Marker used for checkpoint commits created at `turn_end`. */
export const CHECKPOINT_COMMIT_MARKER = "wip(checkpoint):";

/** Conventional Commit `type`/`scope` extracted from a subject line. */
interface TypeScope {
  type: string;
  scope: string | null;
}

/**
 * Parse `type(scope): subject` (or `type: subject`) from a commit subject.
 * Returns `null` when the subject is not a Conventional Commit.
 */
function parseTypeScope(subject: string): TypeScope | null {
  const match = /^([a-z]+)(?:\(([^)]*)\))?!?:/.exec(subject.trim());
  if (!match) return null;
  const scope = match[2] ? match[2].trim() : "";
  return { type: match[1], scope: scope.length > 0 ? scope : null };
}

/**
 * Whether two type/scope pairs count as the same kind of change. A missing
 * scope on either side degrades to a type-only match.
 */
function typeScopeMatches(a: TypeScope, b: TypeScope): boolean {
  if (a.type !== b.type) return false;
  if (a.scope === null || b.scope === null) return true;
  return a.scope === b.scope;
}

/** Set equality for changed-file lists (order-independent). */
function sameFileSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((path) => set.has(path));
}

/** Seconds of committer-time gap that still counts as one previous commit group. */
export const PREVIOUS_GROUP_MAX_GAP_SECONDS = 10;
/** Upper bound on how many commits one previous group may absorb. */
export const PREVIOUS_GROUP_MAX_SIZE = 20;

/** One commit in the previous commit group, with the data needed to match it. */
interface PreviousGroupMember {
  subject: string;
  files: string[];
  typeScope: TypeScope | null;
}

/** The contiguous run of commits directly below the checkpoint run. */
interface PreviousGroup {
  /** Newest first: `HEAD~checkpointCount`, `HEAD~(checkpointCount+1)`, … */
  members: PreviousGroupMember[];
  /** True when any member already exists on the upstream branch. */
  pushed: boolean;
}

/**
 * Walk from `HEAD~checkpointCount` downwards while consecutive commits are no
 * more than {@link PREVIOUS_GROUP_MAX_GAP_SECONDS} apart in committer time,
 * so the commits one `agent_end` produced as a batch are treated as a single
 * group. Returns `null` when there is no commit below the run.
 */
async function findPreviousGroup(
  store: ReorganiserStore,
  checkpointCount: number,
): Promise<PreviousGroup | null> {
  const members: PreviousGroupMember[] = [];
  let previousTime: number | null = null;

  for (
    let index = checkpointCount;
    index < checkpointCount + PREVIOUS_GROUP_MAX_SIZE;
    index++
  ) {
    const summary = await store.getCommitSummary(`HEAD~${index}`);
    if (!summary) break;
    if (
      previousTime !== null &&
      Math.abs(previousTime - summary.committerTime) >
        PREVIOUS_GROUP_MAX_GAP_SECONDS
    ) {
      break;
    }
    members.push({
      subject: summary.subject,
      files: summary.files,
      typeScope: parseTypeScope(summary.subject),
    });
    previousTime = summary.committerTime;
  }

  if (members.length === 0) return null;

  // Index of the oldest member from HEAD; the group is on the remote when
  // that index has reached the upstream tip.
  const aheadCount = await store.getUpstreamAheadCount();
  const oldestIndex = checkpointCount + members.length - 1;
  const pushed = aheadCount !== null && oldestIndex >= aheadCount;
  return { members, pushed };
}

/**
 * Whether any proposed checkpoint group matches a member of the previous
 * group: an exact changed-file set and a matching Conventional `type(scope)`.
 */
function hasMatchingPreviousCommit(
  groups: CommitGroup[],
  members: PreviousGroupMember[],
): boolean {
  for (const group of groups) {
    const groupTypeScope = parseTypeScope(group.message);
    if (!groupTypeScope) continue;
    for (const member of members) {
      if (!member.typeScope) continue;
      if (
        sameFileSet(group.files, member.files) &&
        typeScopeMatches(groupTypeScope, member.typeScope)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Abort a reorganisation whose staged diff is too large for the LLM.
 *
 * Nothing is committed, and the soft reset that detached the checkpoint
 * commits is deliberately left in place: the checkpoint changes stay staged so
 * the user can unstage the junk and commit the rest file by file. The
 * detached checkpoint tip survives in `ORIG_HEAD` for anyone who wants it
 * back.
 *
 * Callers must have the diff staged already — the size check needs it.
 *
 * @returns true when the caller must abort without committing.
 */
async function abortOnOversizedDiff(
  store: ReorganiserStore,
  events: PipelineEvent[],
): Promise<boolean> {
  const { diff } = await store.getStagedMaterials();
  if (!diffExceedsLlmLimit(diff)) {
    return false;
  }

  events.push({
    type: "error",
    message:
      `pi-autocommit: ステージされた差分が大きすぎるため整理を中止しました（${diff.length} 文字 > ${MAX_LLM_DIFF_CHARS}）。` +
      "コミットは作成していません。チェックポイントの変更は staged のまま残しているので、" +
      "node_modules やビルド成果物などの不要なファイルを unstage（例: git rm -r --cached <path>）してから、" +
      "必要なファイルを手動でコミットしてください。",
  });
  events.push({
    type: "stage-changed",
    hasChanges: await store.checkUncommittedChanges(),
  });
  return true;
}

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
 * When the staged diff is too large to send to the LLM (see
 * {@link MAX_LLM_DIFF_CHARS}) nothing is committed: the checkpoints are left
 * soft-reset with their changes staged, and a warning explains what to do.
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
  store: ReorganiserStore,
  complete?: CompleteFn,
  targetSessionId?: string,
): Promise<OrganizerResult> {
  const events: PipelineEvent[] = [];
  let organised = false;

  if (!(await store.isInsideGitRepo())) {
    return { events, organised: false };
  }

  const checkpointCount = await store.countCheckpointCommits(
    CHECKPOINT_COMMIT_MARKER,
    targetSessionId,
  );
  if (checkpointCount === 0) {
    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });
    return { events, organised: false };
  }

  // The previous commit group (the batch the last `agent_end` produced) sits
  // directly below the checkpoint run. Capture it before the reset moves HEAD.
  const previousGroup = config.mergeSimilarPrevious
    ? await findPreviousGroup(store, checkpointCount)
    : null;

  // Undo the checkpoint commits but keep all their changes staged. Leaving
  // them staged is also the abort state: an oversized diff stops here with the
  // changes ready for the user to commit by hand.
  await store.resetSoft(checkpointCount);

  if (await abortOnOversizedDiff(store, events)) {
    return { events, organised: false };
  }

  // Resolve the commit message language from the conversation when `lang`
  // is unset (auto-detect). Detection needs user messages, so the manual
  // command (no messages) keeps the configured/default language.
  resolveLanguageFromMessages(config, event.messages);

  try {
    let groups = await proposeCommitGroups(
      ctx,
      config,
      event,
      store,
      complete,
    );

    if (
      previousGroup &&
      groups.length > 0 &&
      hasMatchingPreviousCommit(groups, previousGroup.members)
    ) {
      if (previousGroup.pushed) {
        events.push({
          type: "info",
          message:
            "pi-autocommit: 前回の似たコミット群は push 済みのため統合しませんでした。" +
            "チェックポイントのみを整理しました。",
        });
      } else {
        // Extend the soft reset over the whole previous group. The index
        // already holds the combined diff (the group's tip tree plus the
        // checkpoint changes), so resetting HEAD further only widens it.
        await store.resetSoft(previousGroup.members.length);
        if (await abortOnOversizedDiff(store, events)) {
          return { events, organised: false };
        }

        // Re-split the combined diff: the right message for the merged
        // changes can differ from either side's, so this is a fresh pass.
        groups = await proposeCommitGroups(
          ctx,
          config,
          event,
          store,
          complete,
        );
        events.push({
          type: "merged",
          message: `pi-autocommit: 前回のコミット群（${previousGroup.members.length} 件）と統合して再整理しました。`,
        });
      }
    }

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
    const commitCount = await commitGroups(store, groups, events);

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
    // Fall back to a single commit so checkpoint commits are not left half-organised.
    try {
      await stageForFallback(store, config);
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
  store: ReorganiserStore,
  targetSessionId?: string,
  complete?: CompleteFn,
): Promise<OrganizerResult> {
  const events: PipelineEvent[] = [];

  if (!(await store.isInsideGitRepo())) {
    return { events, organised: false };
  }

  const reachableCheckpoints = await store.findReachableCheckpoints(
    CHECKPOINT_COMMIT_MARKER,
  );
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

  // ── No target session: reorganise ALL reachable checkpoint commits ──
  if (targetSessionId === undefined) {
    const checkpointCount = await store.countCheckpointCommits(
      CHECKPOINT_COMMIT_MARKER,
    );
    if (checkpointCount > 0) {
      // Consecutive at HEAD: fast path with resetSoft.
      if (await crossesRemoteTip(store, checkpointCount, events)) {
        return { events, organised: false };
      }
      await store.resetSoft(checkpointCount);
      return assembleAndCommit(
        ctx,
        config,
        store,
        checkpointCount,
        events,
        "",
        complete,
      );
    }

    // Non-consecutive (scattered): reorganise only checkpoint commits that
    // carry a session trailer. Historical checkpoints without a trailer
    // are skipped — they are buried under regular commits so their changes
    // are already part of the normal history and cannot be reapplied safely.
    const trailered = reachableCheckpoints.filter((w) => w.session !== null);
    if (trailered.length === 0) {
      events.push({
        type: "info",
        message:
          "No reorganisable checkpoint commits found. Scattered historical " +
          "checkpoints without a session trailer are already part of the regular history.",
      });
      events.push({
        type: "stage-changed",
        hasChanges: await store.checkUncommittedChanges(),
      });
      return { events, organised: false };
    }

    // Apply each trailered checkpoint's diff to the index in oldest-first
    // order so they apply sequentially without conflict.
    const oldestFirst = [...trailered].reverse();
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
      trailered.length,
      events,
      "",
      complete,
    );
  }

  // ── Target session: check contiguity ────────────────────────────────
  const targetCheckpoints = reachableCheckpoints.filter(
    (w) => w.session === targetSessionId,
  );
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
    if (await crossesRemoteTip(store, contiguity.matchCount, events)) {
      return { events, organised: false };
    }
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
  store: ReorganiserStore,
  checkpointCount: number,
  events: PipelineEvent[],
  reasoning: string,
  complete?: CompleteFn,
): Promise<OrganizerResult> {
  let organised = false;

  if (await abortOnOversizedDiff(store, events)) {
    return { events, organised: false };
  }

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

    const commitCount = await commitGroups(store, groups, events);

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
      await stageForFallback(store, config);
      await fallbackSingleCommit(ctx, config, store, events);
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
 * Check whether soft-resetting `commitCount` commits from HEAD would
 * rewrite commits that already exist on the upstream branch. When it
 * would, pushes an error event and returns `true`.
 */
async function crossesRemoteTip(
  store: ReorganiserStore,
  commitCount: number,
  events: PipelineEvent[],
): Promise<boolean> {
  const aheadCount = await store.getUpstreamAheadCount();
  if (aheadCount === null || commitCount <= aheadCount) {
    return false;
  }
  const remoteTipLabel = aheadCount === 0 ? "現在のHEAD" : `HEAD~${aheadCount}`;
  events.push({
    type: "error",
    message:
      `pi-autocommit: チェックポイントがリモート先端（${remoteTipLabel}）より古いコミットまで続いているため中止しました。` +
      "先に push するか、範囲を狭めて再実行してください。",
  });
  events.push({
    type: "stage-changed",
    hasChanges: await store.checkUncommittedChanges(),
  });
  return true;
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
 * Resolve the commit message language from the conversation when `lang` is
 * unset (auto-detect), storing the display name on the config. No-op when
 * `lang` is fixed or no user message has a detectable script.
 */
function resolveLanguageFromMessages(
  config: PiAutocommitConfig,
  messages: ReadonlyArray<unknown>,
): void {
  if (config.lang && config.lang !== "auto") {
    return;
  }
  const detected = detectLanguage(userMessageTexts(messages));
  if (detected) {
    config.langName = languageName(detected);
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
  store: ReorganiserStore,
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
  store: ReorganiserStore,
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
 * Reorganise a user-selected range of commits into logical Conventional Commits.
 *
 * Called from the interactive commit picker popup at `agent_end`. When the
 * range starts at HEAD (startIndex=0), uses the fast path
 * (`resetSoft`). When the range starts after HEAD (startIndex>0), preserves
 * the above-range commits by extracting the range diff, resetting to before
 * the range, applying the range diff, reorganising, then cherry-picking the
 * above-range commits back on top.
 *
 * @param range 0-based indexes from HEAD (inclusive). `startIndex` ≤ `endIndex`.
 */
export async function reorganiseSelectedRange(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  event: AgentEndEvent,
  store: ReorganiserStore,
  range: { startIndex: number; endIndex: number },
  complete?: CompleteFn,
): Promise<OrganizerResult> {
  const events: PipelineEvent[] = [];
  const { startIndex: lo, endIndex: hi } = range;
  const commitCount = hi - lo + 1;

  // Same language auto-detection as the agent_end path.
  resolveLanguageFromMessages(config, event.messages);

  // ── Remote-tip guard ────────────────────────────────────────────
  // Never rewrite commits that already exist on the upstream branch:
  // reorganising them rewrites pushed history and breaks the next push.
  // The range [lo, hi] is safe only when its oldest commit (hi) is newer
  // than the upstream tip, i.e. hi < aheadCount.
  const aheadCount = await store.getUpstreamAheadCount();
  if (aheadCount !== null && hi >= aheadCount) {
    const remoteTipLabel =
      aheadCount === 0 ? "現在のHEAD" : `HEAD~${aheadCount}`;
    events.push({
      type: "error",
      message:
        `pi-autocommit: 選択範囲がリモート先端（${remoteTipLabel}）まで達しています。` +
        "プッシュ済み履歴を書き換えるため中止しました。範囲を狭めて再実行してください。",
    });
    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });
    return { events, organised: false };
  }

  if (lo === 0) {
    // ════════════════════════════════════════════════════════════
    // Fast path: range starts at HEAD — use resetSoft directly.
    // ════════════════════════════════════════════════════════════
    const resetCount = hi + 1;
    await store.resetSoft(resetCount);

    try {
      if (await abortOnOversizedDiff(store, events)) {
        return { events, organised: false };
      }

      const groups = await proposeCommitGroups(
        ctx,
        config,
        event,
        store,
        complete,
      );
      if (groups.length === 0) {
        await fallbackSingleCommit(ctx, config, store, events, complete);
        events.push({
          type: "organised",
          checkpointCount: commitCount,
          commitCount: 1,
        });
      } else {
        const actual = await commitGroups(store, groups, events);
        events.push({
          type: "organised",
          checkpointCount: commitCount,
          commitCount: actual,
        });
      }
    } catch (error) {
      try {
        await stageForFallback(store, config);
        await fallbackSingleCommit(ctx, config, store, events, complete);
        events.push({
          type: "organised",
          checkpointCount: commitCount,
          commitCount: 1,
        });
      } catch {
        const message = error instanceof Error ? error.message : String(error);
        events.push({
          type: "error",
          message: `pi-autocommit: 範囲の再編成に失敗しました — ${message}`,
        });
      }
    }

    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });

    return { events, organised: true };
  }

  // ════════════════════════════════════════════════════════════════
  // Slow path: range starts after HEAD.
  // 1. Collect SHAs for above-range commits and range boundaries
  // 2. hardReset to beforeSHA (clean state)
  // 3. Apply range diff to both working tree and index
  // 4. Run reorganiser pipeline
  // 5. Cherry-pick above-range commits back on top
  // ════════════════════════════════════════════════════════════════

  // Fetch (hi+2) commits so we have SHAs for:
  //   [0..lo-1] = above-range commits
  //   [lo]      = rangeStartSHA (first commit in range)
  //   [hi]      = rangeEndSHA (last commit in range)
  //   [hi+1]    = beforeSHA (parent of rangeEndSHA)
  const rawAll = await store.getRecentCommits(hi + 2);
  const allSHAs: string[] = [];
  for (const line of rawAll.trim().split("\n")) {
    if (!line) continue;
    const sha = line.split("\0")[0];
    if (sha) allSHAs.push(sha);
  }

  if (allSHAs.length <= hi + 1) {
    events.push({
      type: "error",
      message: "pi-autocommit: 選択範囲のコミット情報が取得できませんでした",
    });
    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });
    return { events, organised: false };
  }

  const beforeSHA = allSHAs[hi + 1]; // HEAD~(hi+1)
  const rangeStartSHA = allSHAs[lo]; // HEAD~lo
  // above-range SHAs (newest first) at positions 0..lo-1
  const aboveSHAs = allSHAs.slice(0, lo);
  // Reverse to oldest-first for cherry-pick
  const aboveSHAsOldestFirst = [...aboveSHAs].reverse();
  // Original HEAD: exact pre-operation state for full restore on failure.
  const originalHead = allSHAs[0];

  // hardReset destroys uncommitted changes — refuse to run on a dirty tree.
  if (await store.checkUncommittedChanges()) {
    events.push({
      type: "error",
      message:
        "pi-autocommit: 未コミットの変更があるため範囲の再編成を中止しました。" +
        "先にコミットまたはstashしてください。",
    });
    events.push({
      type: "stage-changed",
      hasChanges: true,
    });
    return { events, organised: false };
  }

  try {
    // Step 2: reset to before the range (clean working tree + index).
    await store.hardReset(beforeSHA);

    // Step 3: apply the combined range diff to both working tree and index.
    const applyResult = await store.applyRangeDiff(beforeSHA, rangeStartSHA);
    if (!applyResult.success) {
      throw new Error(
        `範囲の差分適用に失敗しました — ${applyResult.error || "不明なエラー"}`,
      );
    }

    // Step 3b: refuse to feed an oversized diff to the LLM. Throwing routes
    // into the catch below, which is this path's failure policy anyway:
    // restore the original HEAD so the above-range commits survive.
    const { diff: rangeDiff } = await store.getStagedMaterials();
    if (diffExceedsLlmLimit(rangeDiff)) {
      throw new Error(
        `ステージされた差分が大きすぎます（${rangeDiff.length} 文字 > ${MAX_LLM_DIFF_CHARS}）`,
      );
    }

    // Step 4: run reorganiser — propose groups and commit them.
    const groups = await proposeCommitGroupsFromReasoning(
      ctx,
      config,
      store,
      extractAssistantContext(event.messages),
      complete,
    );

    if (groups.length === 0) {
      await fallbackSingleCommit(ctx, config, store, events, complete);
      events.push({
        type: "organised",
        checkpointCount: commitCount,
        commitCount: 1,
      });
    } else {
      const actual = await commitGroups(store, groups, events);
      events.push({
        type: "organised",
        checkpointCount: commitCount,
        commitCount: actual,
      });
    }

    // Step 5: cherry-pick each above-range commit back in order (oldest first).
    for (const sha of aboveSHAsOldestFirst) {
      const cherryResult = await store.cherryPick(sha);
      if (!cherryResult.success) {
        throw new Error(
          `上のコミットの復元（cherry-pick）に失敗しました — ${cherryResult.error || "不明なエラー"}`,
        );
      }
    }
  } catch (error) {
    // Restore the exact pre-operation state so no commit is left dismantled.
    // The original commits are still reachable (reflog) if manual recovery
    // is ever needed.
    try {
      await store.hardReset(originalHead);
    } catch {
      // Best effort: report the original error below.
    }
    const message = error instanceof Error ? error.message : String(error);
    events.push({
      type: "error",
      message: `pi-autocommit: 範囲の再編成に失敗しました（操作前の状態に復元済み）— ${message}`,
    });
    events.push({
      type: "stage-changed",
      hasChanges: await store.checkUncommittedChanges(),
    });
    return { events, organised: false };
  }

  events.push({
    type: "stage-changed",
    hasChanges: await store.checkUncommittedChanges(),
  });

  return { events, organised: true };
}
