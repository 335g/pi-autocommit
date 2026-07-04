# pi-git

Vocabulary for the pi-git extension, which provides `/git-commit`, `/git-review`, `/git-status`, and automatic checkpointing inside pi.

## Committing

**Auto-commit**
Committing changes automatically without interactive confirmation, driven by the `commitEveryTurn` configuration.
_Avoid_: background commit, silent commit

**Checkpoint commit**
A lightweight, temporary commit created during an agent loop to capture the state after a single turn. Checkpoint commits are later reorganised into final commits.
_Avoid_: WIP commit, scratch commit

**Commit pipeline**
The shared sequence of steps that stages files, selects files, generates a commit message, and executes the commit. Used by `/git-commit`, `/git-review`, and auto-commit.
_Avoid_: commit flow, commit handler

**Commit reorganiser**
The component that analyses checkpoint commits at the end of an agent loop and splits them into logical, well-described Conventional Commits.
_Avoid_: commit splitter, commit cleaner

**Commit strategy**
The rule that decides when automatic commits happen. The two strategies are `agent_end` (one commit per agent loop) and `turn_end` (checkpoint commits during the loop, reorganised at `agent_end`).
_Avoid_: commit mode, commit timing

## Review

**Crit review**
A code-review step that runs the crit tool on staged changes before the commit message is generated.
_Avoid_: pre-commit review

**File selection**
The interactive step in the commit pipeline that lets the user choose which staged files to include in a commit.
_Avoid_: file picker, stage selection
