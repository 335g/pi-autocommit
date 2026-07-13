# Commit guard blocks agent-initiated `git commit` during the agent loop

When `enable` is true, pi-autocommit intercepts the `tool_call` event for
the `bash` tool and blocks any command whose segments contain a
`git ... commit` invocation. The block reason explains that pi-autocommit
manages commits via checkpoint-then-reorganise, so the agent should not
commit on its own.

## Rationale

During an agent loop the LLM occasionally commits spontaneously at a
natural task boundary ("let me commit this"). An interleaved commit
splits the checkpoint run at HEAD: `countCheckpointCommits` stops at the
first non-checkpoint subject, so checkpoints below the foreign commit
are silently dropped from automatic reorganisation. The user's concern
is that interleaved commits make the final history impossible to
reassemble cleanly.

## Considered options

- **A. `pre-commit` git hook.** Rejected as the primary defence: it
  requires a separate setup step outside the extension (installing a
  hook), and `git commit --no-verify` bypasses it. The extension's own
  commits also go through `pi.exec("git", ["commit", ...])`, which would
  trigger the hook unless the extension remembered `--no-verify` on every
  call — coupling the extension to its own hook.
- **B. `tool_call` interception (chosen).** The extension already runs
  inside pi and listens to events. Blocking at the `bash` tool layer
  catches the only path an agent can use to commit (the `bash` tool),
  while the extension's own `pi.exec` commits bypass the tool layer
  entirely, so no self-block risk exists. No extra setup is needed.
- **C. System prompt / AGENTS.md instruction.** Rejected as a sole
  defence: LLMs do not reliably obey "don't commit" instructions, and
  the failure mode is silent history corruption.

## Detection

The `bash` tool's `command` string is split on `&&`, `||`, `;`, `|`, and
newlines into segments. Each segment (including any quoted substring) is
tested against `/\bgit\b(?:\s+\S+)*\s+commit\b/`. This catches:

- `git commit -m "..."`
- `git -C /path commit` (global options between `git` and `commit`)
- `git add foo && git commit` (segment split isolates the `git commit`)
- `sh -c "git commit"` (the quote stays inside one segment)

Only `git commit` is blocked. `git add`, `git reset`, `git stash` and
other operations are left alone — staging state is restored by the
reorganiser at every `turn_end`/`agent_end`, and blocking them would
hamper legitimate agent investigation.

## Consequences

- A new `commit-guard.ts` module owns the segment-splitting and
  pattern-matching logic, kept separate from the `bash` event handler in
  `index.ts` so it is unit-testable.
- The guard is active only while `enable` is true. When disabled, the
  agent is free to commit.
- The reorganiser is unchanged: the existing `agent_end` automatic path
  (`countCheckpointCommits`, consecutive-at-HEAD) stays as-is. Stray
  checkpoints from a crash or a rare bypass are recoverable via the
  existing manual `/autocommit-organise <sessionId>` command
  (ADR-0005). Hardening the automatic path to handle scattered
  checkpoints was considered and deferred — the guard makes
  interleaving rare enough that the manual backstop suffices.
- The block reason is verbose on purpose: telling the LLM *why* commits
  are managed reduces retry attempts.
