# pi-autocommit

Vocabulary for the pi-autocommit extension, which automatically commits changes inside pi using a checkpoint-then-reorganise strategy so the user does not have to write commit messages.

## Committing

**Commit guard**
A safety measure that blocks agent-initiated `git commit` commands during the agent loop when `enable` is true. It intercepts the `bash` tool via the `tool_call` event so that commits stay under pi-autocommit's checkpoint-then-reorganise control and are not interleaved into the checkpoint run.
_Avoid_: commit blocker, commit firewall

**Auto-commit**
Committing changes automatically without interactive confirmation, driven by the `enable` configuration.
_Avoid_: background commit, silent commit

**Checkpoint commit**
A lightweight, temporary commit created during an agent loop to capture the state after a single turn. Checkpoint commits are later reorganised into final commits.
_Avoid_: WIP commit, scratch commit

**Checkpoint session**
The pi session that owns a checkpoint commit. Recorded as a `Checkpoint-Session: <sessionId>` Git trailer on each checkpoint commit so that the reorganiser can limit its scope to the current session when multiple sessions share history.
_Avoid_: session id (ambiguous), commit owner

**Stray checkpoint**
A checkpoint commit left un-reorganised in the branch, typically because its owning session crashed before `agent_end`. The manual `/autocommit-organise` command lets a later session reorganise stray checkpoints by selecting a checkpoint session from a popup.

**Commit pipeline**
The sequence of steps that stages files, generates a commit message, and executes the commit. Used by auto-commit.
_Avoid_: commit flow, commit handler

**Commit reorganiser**
The component that analyses checkpoint commits at the end of an agent loop and splits them into logical, well-described Conventional Commits.
_Avoid_: commit splitter, commit cleaner

**Commit strategy**
The checkpoint-then-reorganise strategy: lightweight checkpoint commits are created during the agent loop and reorganised into logical Conventional Commits at `agent_end`.
_Avoid_: commit mode, commit timing

**Agent baseline HEAD**
The HEAD commit SHA captured at `agent_start`. At `agent_end`, pi-autocommit compares the current HEAD against this baseline; if they are identical, the commit reorganiser (and the TUI commit picker popup) is skipped because the agent run produced no commits.
_Avoid_: initial HEAD, session HEAD, starting HEAD

## Commit message generation

**Commit prompt module**
The deep module that owns prompt assembly, the LLM-call adapter, response cleanup,
and deterministic scope injection for commit messages. Has two interface methods
(one for single-commit generation falling back to the heuristic, one for commit-group
proposition that throws on inference failure). Replaces the duplicated prompt logic
that previously lived inline in the single-commit and reorganiser paths.
_Avoid_: prompt builder, LLM wrapper

**Commit message model**
The LLM model used to generate commit messages. Specified in `config.model` in `"provider/modelId"` format. When omitted, the session's current model (the one driving the conversation) is used as a fallback.
_Avoid_: commit model, LLM model

**Scope mapping**
A user-defined mapping from changed file paths to a fixed Conventional Commits scope, specified in `.pi/pi-autocommit.json` under `scope`. When present, the commit scope is determined by a deterministic path-matching module rather than the LLM, so the scope stays stable across reorganised commits.
_Avoid_: scope config, scope rules

## Manual operations

**Manual organise command**
A slash command (`/autocommit-organise`) that reorganises checkpoint commits on demand. With no argument it reorganises all checkpoint commits at HEAD; when a checkpoint session is chosen from a popup, it reorganises only that session's checkpoints, including scattered stray checkpoints.
_Avoid_: organize command, manual commit, /organize

## Interactive reorganisation

**Commit picker**
A popup shown at `agent_end` that lists recent commits and lets the user select a range to squash and reorganise. `wip(checkpoint):` commits are auto-selected (`[1]` at HEAD, `[2]` at the last checkpoint). The user can extend the range to include non-checkpoint commits by moving the cursor and pressing `1` / `2`.

**Range-based reset**
`git reset --soft HEAD~{N}` where N is the depth of the oldest selected commit from HEAD. All changes in the selected range become staged and are fed to the reorganiser's LLM pipeline for splitting into logical Conventional Commits.
_Avoid_: interactive squash, range squash

## Status

**Uncommitted-changes indicator**
A footer element that shows whether the working tree has uncommitted changes. Its purpose is to give the user a pre-commit cue to spot unintended files before a checkpoint commit captures them.
_Avoid_: status badge, dirty flag
