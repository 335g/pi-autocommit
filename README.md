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
- **Language support** — commit messages can be written in English or Japanese.
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

Auto-commit is **enabled by default**. Once installed, the extension:

1. **`turn_end`** — After each turn that ran a file-mutating tool (`write`, `edit`, `bash`), if the working tree has changes, it stages everything (`git add -A`) and creates a checkpoint commit:
   ```
   wip(checkpoint): auto-commit at turn N
   ```
2. **`agent_end`** — At the end of the agent loop, it counts the checkpoint commits at HEAD, soft-resets them, and asks the LLM to split the combined diff into logical Conventional Commits (using the assistant's own messages as context). Each logical group is then staged and committed separately.

The footer indicator (`[has changes]`) reminds you when there are uncommitted changes — check it before writing your next prompt to catch unintended files.

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
| `lang` | string | `"en"` | Commit message language: `"ja"` (Japanese) or `"en"` (English) |
| `enable` | boolean | `true` | Whether auto-commit is active |
| `model` | string | — | LLM model for commit message generation, in `"provider/modelId"` format (e.g. `"anthropic/claude-sonnet-4"`). When omitted, the session's current model is used. |
| `scope` | object | — | Path-to-scope mapping that fixes the Conventional Commits scope deterministically. When set, the LLM no longer infers the scope; it is resolved from the changed file paths instead. See [Scope mapping](#scope-mapping) below. |

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
