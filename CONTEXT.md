# pi-autocommit

Vocabulary for the pi-autocommit extension, which automatically commits changes inside pi using a checkpoint-then-reorganise strategy so the user does not have to write commit messages.

## Committing

**Auto-commit**
Committing changes automatically without interactive confirmation, driven by the `enable` configuration.
_Avoid_: background commit, silent commit

**Checkpoint commit**
A lightweight, temporary commit created during an agent loop to capture the state after a single turn. Checkpoint commits are later reorganised into final commits.
_Avoid_: WIP commit, scratch commit

**Commit pipeline**
The sequence of steps that stages files, generates a commit message, and executes the commit. Used by auto-commit.
_Avoid_: commit flow, commit handler

**Commit reorganiser**
The component that analyses checkpoint commits at the end of an agent loop and splits them into logical, well-described Conventional Commits.
_Avoid_: commit splitter, commit cleaner

**Commit strategy**
The checkpoint-then-reorganise strategy: lightweight checkpoint commits are created during the agent loop and reorganised into logical Conventional Commits at `agent_end`.
_Avoid_: commit mode, commit timing
