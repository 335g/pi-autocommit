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

## Status

**Uncommitted-changes indicator**
A footer element that shows whether the working tree has uncommitted changes. Its purpose is to give the user a pre-commit cue to spot unintended files before a checkpoint commit captures them.
_Avoid_: status badge, dirty flag
