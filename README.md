# @335g/pi-autocommit

[![npm version](https://img.shields.io/npm/v/@335g/pi-autocommit.svg)](https://www.npmjs.com/package/@335g/pi-autocommit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension that automatically commits your changes so you never have to write a commit message. It uses a **checkpoint-then-reorganise** strategy: lightweight checkpoint commits are created at the end of each turn that mutates files, then at the end of the agent loop they are soft-reset and reorganised into logical [Conventional Commits](https://www.conventionalcommits.org/) by the LLM.

> **Migrated from `@335g/pi-git`?** See [Migration](#migration-from-335gpi-git) below. The `/git-commit` and `/git-status` commands were removed; auto-commit is now the sole feature.

## Features

- **Automatic checkpoints** — commits changes at the end of every turn that mutates files, so intermediate state is never lost.
- **LLM-powered reorganisation** — at the end of the agent loop, checkpoints are soft-reset and split into coherent Conventional Commits using the assistant's own reasoning as context.
- **Heuristic fallback** — when the LLM is unavailable, a single Conventional Commit is produced from diff analysis.
- **Uncommitted-changes footer indicator** — a footer cue shows whether the working tree has changes, so you can spot unintended files *before* a checkpoint captures them.
- **Language support** — commit messages follow the conversation's language automatically (English, Japanese, Korean, Chinese, Russian by script), or a fixed language of your choice via `lang`.
- **Merge conflict detection** — skips committing when a merge is in progress.

## Installation

```bash
pi install @335g/pi-autocommit
```

Or add it to your pi package config:

```json
{
  "packages": {
    "@335g/pi-autocommit": "latest"
  }
}
```

## How it works

Auto-commit is **disabled by default**. Enable it by setting `"enable": true` in `.pi/pi-autocommit.json` or running `/autocommit-enable true`; the extension then:

1. **`turn_end`** — After each turn that ran a file-mutating tool (`write`, `edit`, `bash`), if the working tree has changes, it stages everything (`git add -A`) and creates a checkpoint commit:
   ```
   wip(checkpoint): auto-commit at turn N
   ```
2. **`agent_end`** — At the end of the agent loop, it counts the checkpoint commits at HEAD, soft-resets them, and asks the LLM to split the combined diff into logical Conventional Commits (using the assistant's own messages as context). Each logical group is then staged and committed separately.

The footer indicator (`[has changes]`) reminds you when there are uncommitted changes — check it before writing your next prompt to catch unintended files.

While enabled, agent-initiated destructive or history-interleaving git commands in the `bash` tool are blocked: `git commit` (including `--amend`), `git push`, `git reset --hard`, `git merge`, `git cherry-pick`, and `git rebase`. Commits and pushes are blocked so history stays under pi-autocommit's checkpoint-then-reorganise control — a push before `agent_end` would ship raw checkpoint commits to the remote; `reset --hard` is blocked because it destroys the index and working tree; `merge`, `cherry-pick`, and `rebase` are blocked because they interleave a foreign commit into the checkpoint run, breaking automatic reorganisation.

Two exceptions make branch integration practical when delegating work to another agent via a separate worktree:

- **`git merge --squash` is always allowed** — it stages the merged changes without creating a commit, so it cannot break the checkpoint run. This is the recommended way to integrate a worktree branch, and it is immune to the case where the other agent crashed before `agent_end` and left `wip(checkpoint)` commits at its branch tip.
- **Plain `git merge` / `git cherry-pick` are allowed when HEAD holds no checkpoint commits** — with a clean HEAD there is no checkpoint run to strand below the foreign commit, so merging a finished worktree branch (whose commits were already reorganised by the other agent) works directly. They are still blocked when checkpoints sit at HEAD; the block reason then suggests `/autocommit-organise` or `--squash`.

If a merge does pull in un-reorganised checkpoint commits from another session (the other agent crashed), both `session_start` and `agent_end` report them — the changes are already in the tree, but the `wip(checkpoint)` entries stay in history, so re-integrate with `--squash` next time. The reported checkpoints carry the origin worktree branch (`Checkpoint-Branch` trailer), which is also shown in the commit picker and the `/autocommit-organise` session completions so you can tell which delegated branch each checkpoint came from.

The block reason follows the configured commit-message language (Japanese when `lang` is Japanese, otherwise English) and notes that the guard can be disabled with `/autocommit-enable false`. When disabled, the agent is free to use git on its own.

This runs silently in the background. Notifications appear for progress and errors, but no interactive confirmation is required.

## Configuration

Create `.pi/pi-autocommit.json` in your project root:

```json
{
  "lang": "ja",
  "enable": true,
  "model": "anthropic/claude-sonnet-4"
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `lang` | string | `"auto"` | Commit message language. `"auto"` (default) detects it from the conversation (Japanese, Korean, Chinese, Russian by script); Latin-script conversations fall back to English. Any other value — a code (`"ja"`, `"ko"`) or a language name in any language (`"Korean"`, `"한국어"`) — fixes that language |
| `enable` | boolean | `false` | Whether auto-commit is active |
| `model` | string | — | LLM model for commit message generation, in `"provider/modelId"` format (e.g. `"anthropic/claude-sonnet-4"`). When omitted, the session's current model is used. |
| `scope` | object | — | Path-to-scope mapping that fixes the Conventional Commits scope deterministically. When set, the LLM no longer infers the scope; it is resolved from the changed file paths instead. See [Scope mapping](#scope-mapping) below. |
| `ignoreSubmodules` | boolean | `false` | Keep submodule-related parent-side changes out of auto-commits: gitlink updates (mode 160000 index entries, including absorbed embedded repositories) and `.gitmodules`. Checkpoint commits and the reorganiser never record these paths, so pin updates are left to you. Detached-orphan detection stays active as an informational notice at session start. See [Submodules](#submodules) below. |
| `mergeSimilarPrevious` | boolean | `true` | When reorganisation finds a commit in the group directly below the checkpoint run (contiguous commits no more than 10 seconds apart in committer time) that mostly touches the same files (Jaccard overlap ≥ 0.5) with the same Conventional Commit `type`/`scope`, the checkpoint run and that whole group are re-consolidated together. Pushed groups are never rewritten; a notice is shown instead. See [Merging into a similar previous commit group](#merging-into-a-similar-previous-commit-group) below. |

The `lang` resolution priority: the configured value when set (a fixed language wins over detection), else auto-detection from the conversation's user messages, else English. Auto-detection inspects character scripts; the heuristic fallback (used when the LLM is unavailable) only writes Japanese or English.

### Disabling auto-commit

```json
{
  "enable": false
}
```

Outside a git repository, the extension does nothing regardless of config.

### Scope mapping

By default, the commit scope is inferred by the LLM from the changed file paths. When you want the scope to stay fixed — for example, while working on a feature, or when a sub-project lives under a specific directory — set `scope` to a path-to-scope mapping:

```json
{
  "scope": {
    "packages/frontend/**": "frontend",
    "packages/backend/**": "backend",
    "**": "app"
  }
}
```

Keys are [picomatch](https://github.com/micromatch/picomatch) globs evaluated against the changed file paths. When a commit touches files that all resolve to the **same** scope, that scope is used; if files resolve to **different** scopes (or none match), the scope is omitted (`type: subject`). The most specific (longest literal) glob wins on conflict.

Once `scope` is set, the LLM is instructed to write `type: subject` (no scope) and the scope is injected deterministically — so the scope never drifts. When `scope` is unset, the previous LLM-driven behaviour is preserved.

The `**` glob is a handy way to set a single fixed scope for the whole repo:

```json
{ "scope": { "**": "auth" } }
```

### Submodules

By default (manual submodule mode), pi-autocommit never commits inside a submodule. The user commits there; the parent records the resulting gitlink update like any other changed file, and detached-orphan submodule commits are warned about.

When your workflow keeps submodule pin updates out of pi-autocommit's hands entirely, enable:

```json
{ "ignoreSubmodules": true }
```

Checkpoint commits and reorganisation then never record gitlink updates or `.gitmodules` changes — commits piling up inside a submodule produce no parent-side auto-commits. The pin drift stays visible as an uncommitted change in the footer indicator; commit it manually when you want to move the pin. Detection of detached-orphan submodule commits stays active, shown as an informational notice at session start.

### Merging into a similar previous commit group

At `agent_end`, the commits directly below the checkpoint run form a *previous commit group*: contiguous commits no more than 10 seconds apart in committer time, which is how the multiple logical commits one `agent_end` produced appear. When any member of that group satisfies all of the following, the checkpoint run and the whole group are soft-reset together and the combined diff is fed to the reorganiser again:

1. Its changed-file set mostly overlaps a group proposed for the checkpoint run — Jaccard similarity (`shared ÷ union`) of at least `0.5`, so one extra file next to the files it covers still merges while an unrelated change does not.
2. Its `type(scope)` matches that group's (a missing scope on either side degrades to a type-only match).
3. No member of the group is pushed (none exists on the upstream branch).

This re-consolidates rather than amending, because the right message for the combined diff can differ from either side's. So when the previous reorganisation produced `feat(cli)` and `test(cli)` and the current agent run touches the same files, they are re-split with the current changes.

When condition 3 fails — the group is already on the remote — history is left untouched: only the checkpoint commits are reorganised as usual and a notice reports that no merge happened.

To disable the behaviour:

```json
{ "mergeSimilarPrevious": false }
```

## Commit Message Convention

Generated messages follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
type(scope): subject

body

footer
```

### Types

| Type       | Description                                         |
|------------|-----------------------------------------------------|
| `feat`     | New feature, command, option, or API                |
| `fix`      | Bug fix or correction of unintended behavior        |
| `refactor` | Code structure improvement without behavior change  |
| `chore`    | Build config, dependencies, CI, repository setup    |
| `docs`     | Documentation-only changes                          |
| `test`     | Adding or modifying tests                           |
| `style`    | Code formatting (no behavioral impact)              |
| `perf`     | Performance improvements                            |

## Migration from `@335g/pi-git`

`@335g/pi-git` has been renamed and narrowed in scope to become `@335g/pi-autocommit`:

- The `/git-commit` and `/git-status` commands **were removed**. Use `!git commit` / `!git status` in pi for manual operations.
- The config file moved from `.pi/pi-git.json` to **`.pi/pi-autocommit.json`**. The old file is **not** read.
- `commitEveryTurn` was renamed to **`enable`** and now defaults to **`true`** (installing an autocommit package and getting nothing would be surprising).
- `noBody` was removed — commit messages now always include a body.

To migrate:

```bash
pi uninstall @335g/pi-git
pi install @335g/pi-autocommit
```

Then rename your config and adjust keys:

```json
// .pi/pi-autocommit.json
{
  "lang": "ja",
  "enable": true
}
```

The old `@335g/pi-git` package is marked `deprecated` on npm but remains installable.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

## Requirements

- [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) (peer dependency)
- [pi-ai](https://github.com/earendil-works/pi-ai) (peer dependency)
- [pi-tui](https://github.com/earendil-works/pi-tui) (optional peer dependency — enables the footer status indicator)


## License

MIT © Yoshiki Kudo
