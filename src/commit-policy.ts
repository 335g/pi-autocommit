import type { ToolResultMessage } from "@earendil-works/pi-ai";

/**
 * Tools that may have changed files in the working tree.
 *
 * Read-only tools (`read`, `grep`, `find`, `ls`) are intentionally excluded.
 * `bash` is included because many file mutations happen through shell commands
 * (`sed`, `make`, `npm install`, ...). The final authority is `git status`, so
 * a non-mutating `bash` command simply results in no checkpoint commit.
 */
const POTENTIALLY_MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

/**
 * Decide whether the turn just performed a file mutation worth checkpointing.
 *
 * This is a fast heuristic. It checks `toolResults` to see whether any tool
 * that may mutate files was invoked. Callers should still verify with
 * `git status` that the working tree actually changed before creating a checkpoint
 * commit.
 *
 * @param toolResults - Tool results emitted in `turn_end`.
 */
export function shouldCreateCheckpointCommit(
  toolResults: ToolResultMessage[],
): boolean {
  if (!toolResults || toolResults.length === 0) {
    return false;
  }
  return toolResults.some((r) => POTENTIALLY_MUTATING_TOOLS.has(r.toolName));
}

/**
 * Git guard — blocks agent-initiated `git commit` / `git push` during the
 * agent loop.
 *
 * When `enable` is true, pi-autocommit owns commits via the
 * checkpoint-then-reorganise strategy. An agent committing on its own
 * interleaves a foreign commit into the checkpoint run at HEAD, which
 * makes the final history impossible to reassemble cleanly; and a push
 * before `agent_end` ships the raw checkpoint run to the remote, which
 * diverges from the reorganised history created afterwards. This module
 * detects such invocations inside a `bash` tool command so the
 * `tool_call` handler in `index.ts` can block them.
 *
 * Detection is deliberately conservative: only `git commit` and
 * `git push` are blocked. `git add`, `git reset`, `git stash`, `git
 * fetch` and other operations are left alone because staging state is
 * restored by the reorganiser at every `turn_end`/`agent_end`, and
 * blocking them would hamper legitimate agent investigation.
 */

/**
 * Split a shell command string into segments that could each be a
 * distinct command, then test each segment for a `git ... <verb>`
 * invocation.
 *
 * Splits on `&&`, `||`, `;`, `|`, and newlines — the shell operators
 * that separate commands. Quoted substrings are *not* unescaped: the
 * segment retains its quotes, so `sh -c "git commit"` stays inside one
 * segment and the `git commit` inside the quotes is detected.
 *
 * Within each segment, the pattern `/\bgit\b(?:\s+\S+)*\s+<verb>/`
 * matches `git` followed by zero or more global options (e.g.
 * `-C /path`) followed by `<verb>`. This catches:
 *
 * - `git commit -m "..."` / `git push origin main`
 * - `git -C /path commit` / `git -C /path push`
 * - `sh -c "git push"` (quotes stay in the segment)
 *
 * @returns `true` when any segment contains a `git ... <verb>` invocation.
 */
function shouldBlockGitVerb(command: string, verb: string): boolean {
  if (!command) {
    return false;
  }

  // Split on shell command separators: &&, ||, ;, |, and newlines.
  // A literal `|` inside quotes would wrongly split, but the resulting
  // segments still contain `git commit` if present, so a false split
  // cannot cause a false negative — only a redundant check.
  const segments = command.split(/&&|\|\||;|\||\n/);

  // `git` optionally followed by global options, then the verb as a
  // standalone word (followed by whitespace or end of segment). The
  // lookahead `(?=\s|$)` prevents matching a verb inside a filename
  // like `commit-message.txt`.
  const pattern = new RegExp(`\\bgit\\b(?:\\s+\\S+)*\\s+${verb}(?=\\s|$)`);

  return segments.some((segment) => pattern.test(segment));
}

/**
 * Detect a `git ... commit` invocation inside a shell command.
 *
 * @returns `true` when any segment contains a `git ... commit` invocation.
 */
export function shouldBlockGitCommit(command: string): boolean {
  return shouldBlockGitVerb(command, "commit");
}

/**
 * Detect a `git ... push` invocation inside a shell command.
 *
 * Pushing before `agent_end` ships raw checkpoint commits to the remote,
 * which then diverge from the reorganised history pi-autocommit creates
 * afterwards.
 *
 * @returns `true` when any segment contains a `git ... push` invocation.
 */
export function shouldBlockGitPush(command: string): boolean {
  return shouldBlockGitVerb(command, "push");
}

/**
 * Detect a `git ... reset --hard` invocation inside a shell command.
 *
 * `git reset --soft` / `--mixed` (the default) only move HEAD and staging and
 * are left alone — agents legitimately use them to inspect and rewind history.
 * `--hard` additionally destroys the working tree, which can wipe changes made
 * in the current turn before the next checkpoint captures them.
 *
 * @returns `true` when any segment contains a `git ... reset` invocation and a
 *   `--hard` flag.
 */
export function shouldBlockGitHardReset(command: string): boolean {
  if (!command) {
    return false;
  }

  const segments = command.split(/&&|\|\||;|\||\n/);
  const resetPattern = /\bgit\b(?:\s+\S+)*\s+reset(?=\s|$)/;
  return segments.some(
    (segment) => resetPattern.test(segment) && /--hard\b/.test(segment),
  );
}

/** Verbs that would interleave a foreign commit into the checkpoint run at HEAD. */
const INTERLEAVING_VERBS = ["merge", "cherry-pick", "rebase"] as const;

/**
 * Detect a `git ... <verb>` invocation that would interleave a foreign commit
 * into the checkpoint run (merge, cherry-pick, rebase), returning the matched
 * verb, or `null` when none is found.
 *
 * `git merge --squash` is excluded: it stages the merged changes without
 * creating a commit, so it cannot interleave history — the staged changes flow
 * through the normal turn_end checkpoint instead. This is the blessed way to
 * integrate a worktree branch whose tip may still hold un-reorganised
 * checkpoints (e.g. a delegated agent that crashed before `agent_end`).
 *
 * The other three rewrite or append history at HEAD: the merged/cherry-picked/
 * rebased commits are not checkpoints, so `countCheckpointCommits` stops at
 * them and the checkpoints below are silently dropped from automatic
 * reorganisation. `rebase` additionally leaves the repo in a half-finished
 * state on conflict.
 *
 * @returns The matched verb, or `null`.
 */
export function blockedInterleavingVerb(command: string): string | null {
  if (!command) {
    return null;
  }
  for (const verb of INTERLEAVING_VERBS) {
    if (!shouldBlockGitVerb(command, verb)) {
      continue;
    }
    if (verb === "merge" && isSquashMerge(command)) {
      continue; // no commit is created — nothing to interleave
    }
    return verb;
  }
  return null;
}

/**
 * Whether a `git merge` invocation carries `--squash` (stages the merged
 * changes without creating a commit). `--no-squash` does not match.
 */
function isSquashMerge(command: string): boolean {
  const segments = command.split(/&&|\|\||;|\||\n/);
  return segments.some(
    (segment) =>
      shouldBlockGitVerb(segment, "merge") &&
      /(^|\s)--squash(?=\s|$)/.test(segment),
  );
}

/**
 * Whether a merge/cherry-pick invocation is safe to allow without a guard
 * block because HEAD holds no checkpoint commit to interleave into.
 *
 * Called by the `tool_call` handler when `blockedInterleavingVerb` matched
 * "merge" or "cherry-pick". When HEAD's subject is not a checkpoint there is
 * no checkpoint run at the top of the branch, so the foreign commit cannot
 * strand any checkpoints below it. A `null` headSubject (HEAD unresolved) is
 * treated conservatively as "block" so an unreadable repo is not silently
 * allowed to break the checkpoint run.
 */
export function interleavingAllowedWithoutCheckpoints(
  blocked: string | null,
  headSubject: string | null,
  marker: string,
): boolean {
  if (blocked !== "merge" && blocked !== "cherry-pick") {
    return false;
  }
  return headSubject !== null && !headSubject.startsWith(marker);
}

/** Footer note appended to every block reason. */
const DISABLE_NOTE_JA =
  "無効化するには `/autocommit-enable false` を実行してください。";
const DISABLE_NOTE_EN =
  "To disable this guard, run `/autocommit-enable false`.";

/**
 * Build the user-facing block reason for a blocked git operation.
 *
 * Explains why the operation is blocked and how to disable the guard
 * (`/autocommit-enable false`). Written in Japanese when `japanese` is true,
 * English otherwise. When `enable` is false the guard is inert and none of
 * these operations are blocked.
 */
export function buildBlockReason(blocked: string, japanese: boolean): string {
  if (japanese) {
    switch (blocked) {
      case "reset --hard":
        return (
          "pi-autocommit: エージェントループ中の `git reset --hard` はインデックスと作業ツリーを破棄するためブロックされました。" +
          "履歴を戻すには `git reset --soft` を、変更を捨てる必要がある場合は turn_end のチェックポイントに任せてください。" +
          DISABLE_NOTE_JA
        );
      case "merge":
        return (
          "pi-autocommit: エージェントループ中の `git merge` は、HEAD に未整理のチェックポイントがあるためブロックされました。" +
          "まず `/autocommit-organise` で整理するか、コミットを作らず差分だけ取り込む `git merge --squash` を使ってください。" +
          DISABLE_NOTE_JA
        );
      case "cherry-pick":
        return (
          "pi-autocommit: エージェントループ中の `git cherry-pick` は、HEAD に未整理のチェックポイントがあるためブロックされました。" +
          "まず `/autocommit-organise` で整理してから実行してください。" +
          DISABLE_NOTE_JA
        );
      case "rebase":
        return (
          "pi-autocommit: エージェントループ中の `git rebase` はチェックポイントコミットの列を壊すためブロックされました。" +
          "pi の外で開始した rebase が進行中の場合、`git rebase --abort` 等は手動で解決してください。" +
          DISABLE_NOTE_JA
        );
      default:
        return (
          `pi-autocommit がコミット履歴を管理しているため、エージェントループ中の \`git ${blocked}\` はブロックされました。` +
          "turn_end でチェックポイントコミットが自動作成され、agent_end で論理的な Conventional Commits に整理されます。" +
          "整理前に push するとリモートがチェックポイント履歴と乖離するため、手動で commit/push する必要はありません。" +
          DISABLE_NOTE_JA
        );
    }
  }

  switch (blocked) {
    case "reset --hard":
      return (
        "pi-autocommit: `git reset --hard` is blocked during the agent loop because it destroys the index and the working tree. " +
        "To rewind history use `git reset --soft`; to discard changes, rely on the turn_end checkpoint. " +
        DISABLE_NOTE_EN
      );
    case "merge":
      return (
        "pi-autocommit: `git merge` is blocked during the agent loop because HEAD holds un-reorganised checkpoint commits. " +
        "Reorganise them first with `/autocommit-organise`, or use `git merge --squash`, which stages the changes " +
        "without creating a commit. " +
        DISABLE_NOTE_EN
      );
    case "cherry-pick":
      return (
        "pi-autocommit: `git cherry-pick` is blocked during the agent loop because HEAD holds un-reorganised checkpoint commits. " +
        "Reorganise them first with `/autocommit-organise`. " +
        DISABLE_NOTE_EN
      );
    case "rebase":
      return (
        "pi-autocommit: `git rebase` is blocked during the agent loop because it breaks the checkpoint commit run. " +
        "If a rebase started outside pi is in progress, resolve it manually (e.g. `git rebase --abort`). " +
        DISABLE_NOTE_EN
      );
    default:
      return (
        `pi-autocommit manages the commit history, so \`git ${blocked}\` is blocked during the agent loop. ` +
        "Checkpoint commits are created at turn_end and reorganised into logical Conventional Commits at agent_end. " +
        "Pushing before reorganisation would diverge the remote from the reorganised history, so there is no need to commit or push manually. " +
        DISABLE_NOTE_EN
      );
  }
}

/**
 * Decide whether the commit reorganiser should be skipped at `agent_end`.
 *
 * Returns `true` when the HEAD commit captured at `agent_start` matches the
 * current HEAD. This means the agent run produced no commits, so there is
 * nothing to reorganise.
 *
 * A `null` baseline (e.g., HEAD could not be read at `agent_start`) is treated
 * as "unknown", so the reorganiser proceeds with its normal behaviour rather
 * than risk silently skipping a real reorganisation.
 */
export function shouldSkipReorganisation(
  baselineHead: string | null,
  currentHead: string | null,
): boolean {
  if (baselineHead === null || currentHead === null) {
    return false;
  }
  return baselineHead === currentHead;
}
