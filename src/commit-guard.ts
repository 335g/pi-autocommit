/**
 * Commit guard — blocks agent-initiated `git commit` during the agent loop.
 *
 * When `enable` is true, pi-autocommit owns commits via the
 * checkpoint-then-reorganise strategy. An agent committing on its own
 * interleaves a foreign commit into the checkpoint run at HEAD, which
 * makes the final history impossible to reassemble cleanly. This module
 * detects `git ... commit` invocations inside a `bash` tool command so
 * the `tool_call` handler in `index.ts` can block them.
 *
 * Detection is deliberately conservative: only `git commit` is blocked.
 * `git add`, `git reset`, `git stash` and other operations are left alone
 * because staging state is restored by the reorganiser at every
 * `turn_end`/`agent_end`, and blocking them would hamper legitimate
 * agent investigation.
 */

/**
 * Split a shell command string into segments that could each be a
 * distinct command, then test each segment for a `git ... commit`
 * invocation.
 *
 * Splits on `&&`, `||`, `;`, `|`, and newlines — the shell operators
 * that separate commands. Quoted substrings are *not* unescaped: the
 * segment retains its quotes, so `sh -c "git commit"` stays inside one
 * segment and the `git commit` inside the quotes is detected.
 *
 * Within each segment, the pattern `/\bgit\b(?:\s+\S+)*\s+commit\b/`
 * matches `git` followed by zero or more global options (e.g.
 * `-C /path`) followed by `commit`. This catches:
 *
 * - `git commit -m "..."`
 * - `git -C /path commit`
 * - `sh -c "git commit"` (quotes stay in the segment)
 *
 * @returns `true` when any segment contains a `git ... commit` invocation.
 */
export function isGitCommitCommand(command: string): boolean {
  if (!command) {
    return false;
  }

  // Split on shell command separators: &&, ||, ;, |, and newlines.
  // A literal `|` inside quotes would wrongly split, but the resulting
  // segments still contain `git commit` if present, so a false split
  // cannot cause a false negative — only a redundant check.
  const segments = command.split(/&&|\|\||;|\||\n/);

  // `git` optionally followed by global options, then `commit` as a
  // standalone word (followed by whitespace or end of segment). The
  // lookahead `(?=\s|$)` prevents matching `commit` inside a filename
  // like `commit-message.txt`.
  const pattern = /\bgit\b(?:\s+\S+)*\s+commit(?=\s|$)/;

  return segments.some((segment) => pattern.test(segment));
}
