# @335g/pi-git

[![npm version](https://img.shields.io/npm/v/@335g/pi-git.svg)](https://www.npmjs.com/package/@335g/pi-git)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension that adds `/commit` and `/review` commands for generating [Conventional Commits](https://www.conventionalcommits.org/) messages using LLM or heuristic fallback.

## Features

- **`/commit` command** – Stage all changes, optionally select files, and commit with an AI-generated message
- **`/review` command** – Stage, review changes with [crit](https://github.com/335g/crit) inline comments, then generate a commit message
- **Inline message support** – `/commit fix typo` uses the message directly without AI generation
- **AI-powered generation** – Leverages pi's LLM to produce Conventional Commits messages from staged diffs
- **Heuristic fallback** – When the LLM is unavailable, generates a commit message from diff analysis
- **Interactive file selection** – Pick which staged files to include; preview diffs with QuickLook-style overlay (TUI mode)
- **Interactive confirmation** – Review, edit, or cancel the proposed commit message before executing
- **Language support** – Commit messages can be written in English or Japanese (configured via `.pi-git/config.toml`)
- **Auto-commit on every turn** – Automatically commit changes at the end of each agent turn when `commit_every_turn = true` is set in config
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
/commit
```

This will:
1. Check for merge conflicts
2. Check for uncommitted changes
3. Stage all files (`git add -A`)
4. Present an interactive file selector (TUI mode) — pick files to include, preview diffs with Space
5. Generate a Conventional Commits message via LLM
6. Present the message for confirmation (Y/Edit/Cancel)
7. Execute the commit

### Inline commit message

```
/commit fix typo in header
```

Skips AI generation and commits directly with the provided message. File selection still runs (TUI mode).

### Review-then-commit

Requires [crit](https://github.com/335g/crit) to be installed (`npm install -g crit`).

```
/review
```

Same flow as `/commit`, but after staging and file selection:
1. Opens a crit review in your browser for inline comments on the diff
2. After finishing the review, unresolved comments are shown
3. Choose whether to include comments in the commit message context
4. A commit message is generated incorporating the review feedback
5. Confirm or edit the message, then commit

### Dry-run mode

Preview without committing:

```
/commit --dry-run
/review --dry-run
```

The full pipeline (stage, file selection, LLM generation, confirmation) runs, but the actual `git commit` is skipped. No files are unstaged.

### Interactive file selection (TUI mode)

When running `/commit` or `/review` in TUI mode, an interactive file picker appears:

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

Create `.pi-git/config.toml` in your project root:

```toml
# .pi-git/config.toml
lang = "ja"              # Commit message language: "ja" (Japanese) or "en" (English, default)
no_body = true           # Omit body, subject-only commit message (default: false)
commit_every_turn = true # Auto-commit at the end of every agent turn (default: false)
```

#### `commit_every_turn`

When enabled, the extension listens for the `agent_end` event and automatically:
1. Checks for uncommitted changes
2. Stages all files (`git add -A`)
3. Generates a Conventional Commits message via LLM
4. Executes the commit

This runs silently in the background — notifications appear in the UI for progress
and errors, but no interactive confirmation is required.

The feature is safe to enable alongside manual `/commit` usage; it only commits
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
- [crit](https://github.com/335g/crit) (optional – required for `/review` command)

## License

MIT © Yoshiki Kudo
