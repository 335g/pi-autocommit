# @335g/pi-git

[![npm version](https://img.shields.io/npm/v/@335g/pi-git.svg)](https://www.npmjs.com/package/@335g/pi-git)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension that adds `/git-commit` and `/git-status` commands for [Conventional Commits](https://www.conventionalcommits.org/) message generation and repository status inspection.

## Features

- **`/git-status` command** – View working tree and staged changes in a scrollable, colour-coded TUI viewer without leaving pi
- **`/git-commit` command** – Stage all changes, optionally select files, and commit with an AI-generated message
- **Inline message support** – `/git-commit fix typo` uses the message directly without AI generation
- **AI-powered generation** – Leverages pi's LLM to produce Conventional Commits messages from staged diffs
- **Heuristic fallback** – When the LLM is unavailable, generates a commit message from diff analysis
- **Interactive file selection** – Pick which staged files to include; preview diffs with QuickLook-style overlay (TUI mode)
- **Interactive confirmation** – Review, edit, or cancel the proposed commit message before executing
- **Language support** – Commit messages can be written in English or Japanese (configured via `.pi/pi-git.json`)
- **Auto-commit on every turn** – Automatically commit changes at the end of each agent turn when `commitEveryTurn: true` is set in config
- **Merge conflict detection** – Refuses to commit when a merge is in progress
- **Dry-run mode** – Preview the generated commit message without executing

## Installation

```bash
pi install @335g/pi-git
```

Or add it to your pi package config:

```json
{
  "packages": {
    "@335g/pi-git": "latest"
  }
}
```

## Usage

### Basic commit

In a pi session, inside a git repository:

```
/git-commit
```

This will:
1. Check for merge conflicts
2. Check for uncommitted changes
3. Stage all files (`git add -A`)
4. Present an interactive file selector (TUI mode) — pick files to include, preview diffs with Space
5. Generate a Conventional Commits message via LLM
6. Present the message for confirmation (Y/Edit/Cancel)
7. Execute the commit

### Git status

```
/git-status
```

Shows the working tree status in a scrollable, colour-coded TUI viewer—no need to drop to a shell with `!git status`.

In TUI mode:
- `↑↓` scroll one line
- `PgUp` / `PgDn` scroll 20 lines
- `Esc` / `Ctrl+C` close

In non-TUI mode (RPC/JSON/print), the output is shown via `ctx.ui.notify()`.

### Inline commit message

```
/git-commit fix typo in header
```

Skips AI generation and commits directly with the provided message. File selection still runs (TUI mode).

### Dry-run mode

Preview without committing:

```
/git-commit --dry-run
```

The full pipeline (stage, file selection, LLM generation, confirmation) runs, but the actual `git commit` is skipped. No files are unstaged.

### Interactive file selection (TUI mode)

When running `/git-commit` in TUI mode, an interactive file picker appears:

```
 Select files to commit  (3/5)
   select   stat    type  file
  ─────── ─────── ──── ────
  ▸ ●     +10/-2  mod  src/index.ts
    ○              new  src/pipeline.ts
    ●     +5/-0   mod  src/config.ts

  ↑↓ navigate  → select  ← deselect  space preview  a all  enter commit  esc cancel
```

- `↑↓` navigate
- `→` select, `←` deselect
- `Space` — open a full-screen diff preview (QuickLook-style)
- `a` — toggle all
- `Enter` — confirm selection
- `Esc` / `Ctrl+C` — cancel

### Configuration

Create `.pi/pi-git.json` in your project root:

```json
{
  "lang": "ja",
  "noBody": true,
  "commitEveryTurn": false,
  "model": "anthropic/claude-sonnet-4"
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `lang` | string | `"en"` | Commit message language: `"ja"` (Japanese) or `"en"` (English) |
| `noBody` | boolean | `false` | Omit body, subject-only commit message |
| `commitEveryTurn` | `boolean` | `false` | Auto-commit (checkpoint-then-reorganise strategy) |
| `model` | string | — | LLM model for commit message generation, in `"provider/modelId"` format (e.g. `"anthropic/claude-sonnet-4"`). When omitted, the session's current model is used. |

#### `commitEveryTurn`

When `true`, the extension creates lightweight checkpoint commits at the end
of each turn that mutates files, then reorganises those checkpoints into logical
Conventional Commits at the end of the agent loop.

```json
{
  "commitEveryTurn": true
}
```

This strategy is useful for long agent sessions (for example, a goal command that
makes many changes in one request). Each file-mutating turn is immediately
checkpointed, and at `agent_end` the checkpoints are soft-reset and re-analysed
by the LLM to produce clean, logical commits.

This runs silently in the background — notifications appear in the UI for progress
and errors, but no interactive confirmation is required.

The feature is safe to enable alongside manual `/git-commit` usage; it only commits
when there are actual changes.

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
- [pi-tui](https://github.com/earendil-works/pi-tui) (optional peer dependency – enables interactive file selection and confirmation UI)


## License

MIT © Yoshiki Kudo
