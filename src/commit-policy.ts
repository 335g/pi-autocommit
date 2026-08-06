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
