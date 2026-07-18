# Interactive range-based reorganiser via commit picker popup

At `agent_end`, instead of automatically reorganising only the consecutive
checkpoint commits, show a TUI popup that lets the user select an arbitrary
range of recent commits (checkpoint and non-checkpoint alike) to squash
into logical Conventional Commits.

## Motivation

The original checkpoint-then-reorganise strategy assumes that only
checkpoint commits (`wip(checkpoint):`) sit at the top of HEAD, and that
reorganisation can always be a fully automatic `reset --soft` of a
consecutive checkpoint run. Two problems make this brittle:

1. **Interleaved manual commits.** The commit guard (ADR-0006) was added
   to block agent-initiated `git commit` during the loop, but it adds
   complexity and removes user agency. We want to remove the guard and
   let commits of any kind exist between checkpoints.

2. **Cross-session reorganisation.** After checkpoints are reorganised
   into logical commits, a later agent turn may need to amend those
   commits. The user should be able to select a range spanning past
   reorganised commits — not just the latest checkpoint run — and
   squash all of them together for reorganisation.

A manual range-based selection popup solves both: the user can
arbitrarily expand the squash window to include any commits, and
checkpoints within the range remain automatically pre-selected so the
common case (squash all checkpoints) is a single Enter press.

## Design

### Trigger

- Shown at `agent_end` when there are recent commits and the session is in
  TUI mode. The popup always lets the user select any range — checkpoint
  commits are not required.
- Non-TUI (RPC) mode falls back to the original automatic reorganisation
  path.
- Show no popup when there are zero recent commits (e.g. a freshly
  initialised repository with no history) or when `head-guard` detects
  that HEAD did not move during the agent run.

### Popup

- Centered overlay window rendered via `ctx.ui.custom()` with
  `{ overlay: true, overlayOptions: { anchor: "center" } }`.
- Lists up to 100 recent commits from HEAD in reverse chronological
  order (newest first).
- Each line shows `[1]` / `[2]` / `[ ]` markers, a `▸` cursor, and
  the commit subject.
- `wip(checkpoint):` commits are displayed with the prefix stripped to
  `wip(checkpoint)` for readability.

### Default state

- Marker `[1]` (range start, newest side) at HEAD.
- Marker `[2]` (range end, oldest side) at the last `wip(checkpoint):`
  commit in the list.
- Cursor starts at `[2]` — the user's most common action is to extend
  the range downward by moving the cursor and pressing `2` again.
- All commits between `[1]` and `[2]` (inclusive) are visually
  highlighted to show the selected range.

### Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move cursor one line. Scrolls the list when at the edge. |
| `1` | Set range start (`[1]`) at cursor position. |
| `2` | Set range end (`[2]`) at cursor position. |
| `Enter` | Confirm — close the popup and begin reorganisation of the selected range. |
| `Esc` | Cancel — close popup, leave the working tree as-is. |

### Range-based reset

When the user confirms a range `[lo, hi]` (0-based indexes from HEAD):

1. `git reset --soft HEAD~{hi + 1}` — move HEAD past the oldest selected
   commit, keeping all changes staged.
2. Feed the combined staged diff into the existing `proposeCommitGroups`
   LLM pipeline — the same logic that already splits checkpoint diffs
   into logical Conventional Commits.
3. Commit each group in order via `commitGroups`.

The range is always contiguous: no skip-selection. If the user wants to
exclude a commit, they narrow the range instead.

### Error handling

- **LLM failure:** falls back to a single Conventional Commit via the
  existing `fallbackSingleCommit`.
- **User cancels (Esc):** no git operations are performed. The user can
  run `/autocommit-organise` later.

## Consequences

- The commit guard (ADR-0006) becomes redundant and should be removed in
  a follow-up change. The guard's original problem (interleaved commits
  breaking auto-reorganisation) no longer applies because the user
  explicitly selects the range.
- The auto-reorganisation path in `organizeCheckpointCommits` is kept for
  non-TUI sessions.
- A new `reorganiseSelectedRange` function is added to
  `commit-organizer.ts`, sharing the `proposeCommitGroups` /
  `commitGroups` / `fallbackSingleCommit` helpers with the auto path.
- The agent loop no longer silently rewrites history: every
  reorganisation is user-confirmed.
