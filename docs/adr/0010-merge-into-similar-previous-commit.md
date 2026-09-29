# Merge reorganisation into a similar previous commit

The checkpoint-then-reorganise strategy only ever rewrites the checkpoint run
at HEAD. When an agent works on a feature across several runs, the previous
run's reorganised commit (`feat(cli): ...`) sits directly below the new
checkpoint run, and the same files get a second, nearly identical commit.
We decided to extend `agent_end` reorganisation one commit further down —
into `HEAD~{checkpointCount}` — when that commit is a similar commit, folding
the checkpoint changes into it with `git commit --amend`.

"Similar" is deterministic on purpose: the previous commit's changed-file set
must exactly equal the checkpoint run's changed-file set, and its
Conventional Commit `type(scope)` must equal the reorganiser's single
resulting group (a missing scope on either side degrades to a type-only
match). Only the immediately preceding commit is considered — because
`agent_end` runs every turn, the commit above it has already been compared on
a previous pass.

Pushing is the one condition that cannot be decided locally. The previous
commit is compared against `@{upstream}` (falling back to `origin/HEAD`) via
the same `getUpstreamAheadCount` guard already used for the manual picker: if
the commit exists on the remote it is left untouched, only the checkpoints
are reorganised, and a notice says why. No force-push path is offered.

Amending preserves the previous commit's author and keeps its position in
history; the commit date becomes the amend time.

## Considered Options

- **LLM decides similarity** — rejected: the decision becomes
  non-deterministic and costs an extra roundtrip, while the file-set and
  `type(scope)` signals already capture the intended case.
- **Walk down a chain of similar commits** — rejected: `agent_end` already
  compares the boundary commit on every run, so a chain would only ever
  deepen for commits that were never pushed between runs.
- **Force-push published history to merge anyway** — rejected: rewriting
  pushed commits is the exact hazard the upstream guard exists to prevent.
- **Require an interactive confirmation** — rejected: the operation is
  guarded, narrow, and reversible via the reflog; a popup every `agent_end`
  would defeat the zero-interaction design.

## Consequences

- A feature touched again in a later run collapses into one commit instead of
  accumulating near-duplicate commits.
- The previous commit's message is regenerated from the combined diff, so the
  body reflects both runs.
- The merge is skipped whenever the checkpoint run touches one extra file or
  splits into more than one group; the checkpoint-only reorganisation then
  proceeds as before.
- `mergeSimilarPrevious` (default `true`) turns the behaviour off without
  touching the push guard.
