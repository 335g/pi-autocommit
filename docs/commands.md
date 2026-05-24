# pi-git Commands

This document describes all slash commands provided by the `pi-git` extension.

---

## `/git-agg-commit`

Automatically analyzes the working tree diff, splits changes into logical hunks, generates [Conventional Commits](https://www.conventionalcommits.org/) style messages, stages files, and creates commits — all in one shot.

### Usage

```
/git-agg-commit
/git-agg-commit --lang=ja
/git-agg-commit --language=en
```

### Options

| Option | Description |
|--------|-------------|
| `--lang=<code>`<br>`--language=<code>` | Override the display and commit message language for **this run only**. Accepted values: `en` (English), `ja` (Japanese). |

> **Note:** `--lang` does **not** save to any settings file. Use `/git-config` to persist language preferences.

### Execution Phases

| Phase | English | Japanese |
|-------|---------|----------|
| Preparation | `[pi-git] Preparing...` | `[pi-git] 準備中...` |
| Diff collection | `[pi-git] Collecting diff...` | `[pi-git] diff収集中...` |
| Hunk analysis | `[pi-git] Analyzing hunks...` | `[pi-git] hunk解析中...` |
| Message generation | `[pi-git] Generating messages...` | `[pi-git] コミットメッセージ生成中...` |
| Committing | `[pi-git] Committing...` | `[pi-git] コミット実行中...` |

When `auto-agg-commit` is enabled, the prefix becomes `[pi-git: auto-commit]` and the persistent `[pi-git] auto-commit: ON` status indicator is temporarily hidden during execution to avoid duplicate status lines.

### Behavior

| Situation | Behavior |
|-----------|----------|
| Not a git repository | Warns and aborts |
| No changes in working tree | Notifies and exits |
| Non-interactive mode (`--print`, JSON) | Skips silently |
| Pre-commit hook fails | Resets staging and warns; continues with remaining hunks |
| AI model unavailable / auth fails | Falls back to file-per-hunk splitting |
| Untracked files | Included in diff analysis and committed |
| User edits files during execution | Safe: diff is snapshotted at the start via `git stash` so analysis is not affected by concurrent edits |
| `/git-agg-commit` run while another is already in progress | Blocked with a warning; prevents staging area conflicts between concurrent executions |

### Commit Message Format

Messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[(scope)]: <subject>
```

Types are automatically inferred by AI, then validated to one of: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `revert`.

---

## `/git-auto-agg-commit`

Toggle the automatic `git-agg-commit` feature. When enabled, `pi-git` automatically runs `/git-agg-commit` after the assistant finishes responding if there are uncommitted changes in the working tree.

### Usage

```
/git-auto-agg-commit         # Show current status
/git-auto-agg-commit on      # Enable
/git-auto-agg-commit off     # Disable
/git-auto-agg-commit toggle  # Toggle
```

### Behavior

- Saves the setting to the **global** config file (`~/.config/pi-git/settings.json`).
- Updates the persistent footer indicator `[pi-git] auto-commit: ON` when enabled.
- The auto-commit trigger fires on the `agent_end` event.
- Does not run if another `/git-agg-commit` is already in progress.

---

## `/git-config`

Get, set, or list `pi-git` configuration values. Supports both global and local scopes.

### Settings Precedence

1. **Local config** — `<repo-root>/.pi-git/settings.json` (highest priority)
2. **Global config** — `~/.config/pi-git/settings.json`
3. **Built-in defaults** — `{"lang": "en", "autoAggCommit": false}` (lowest priority)

Values from local config take precedence over global config. If a key is missing in local config, the global value (or default) is used.

### Available Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `lang` | `string` | `"en"` | Display and commit message language. `"en"` or `"ja"`. |
| `autoAggCommit` | `boolean` | `false` | Whether to automatically run `git-agg-commit` after assistant responses. |

### Usage

```
# Get a value (shows effective value)
/git-config lang

# Set a value (default: local scope inside a repo, global otherwise)
/git-config lang ja

# Set a value explicitly in global scope
/git-config --global lang ja

# List all effective values
/git-config --list

# List with origin information
/git-config --list --show-origin
```

### Scope Rules

| Situation | Target | Behavior |
|-----------|--------|----------|
| Inside a git repo, no `--global` | Local | Saves to `<repo-root>/.pi-git/settings.json` |
| Inside a git repo, `--global` | Global | Saves to `~/.config/pi-git/settings.json` |
| Outside a git repo, no `--global` | Global (fallback) | Saves to `~/.config/pi-git/settings.json` with a notice |
| First write, both configs absent | Local (initialized with defaults) | Creates `.pi-git/settings.json` with all default values plus the requested change |

### Examples

```bash
# Show current effective language
/git-config lang
# → en

# Set language to Japanese for this repo only
/git-config lang ja
# → Saved lang=ja to local config

# Set globally (applies to all repos unless overridden locally)
/git-config --global lang en

# List all settings with where they come from
/git-config --list --show-origin
# → lang=ja (local)
# → autoAggCommit=false (default)
```

---

## Settings Files

### Global Config

Path: `~/.config/pi-git/settings.json`

Manually editable JSON file. Used as the fallback when no local config exists or when a key is not overridden locally.

### Local Config

Path: `<git-repo-root>/.pi-git/settings.json`

Project-specific overrides. Created automatically on the first `/git-config` write inside a git repository when neither global nor local config exists yet. Only stores values that differ from or should override the global/default settings.

**Recommended:** Add `.pi-git/` to your repository's `.gitignore` if team members should not share the same pi-git settings, or commit it if you want to share project defaults.

---

## `/git-diff`

Interactive diff review with AI-assisted hunk decomposition. Displays a side-by-side file tree and diff viewer, allowing you to review, adjust, and commit changes one logical hunk at a time.

### Usage

```
/git-diff
/git-diff --lang=ja
```

### Options

| Option | Description |
|--------|-------------|
| `--lang=<code>` | Override the display and commit message language for **this run only**. Accepted values: `en` (English), `ja` (Japanese). |

### Layout

The UI is an overlay with three areas:

- **Top bar** — Current hunk's commit message and file count (`hunk files / total files`). Press `e` to edit the message inline.
- **Left pane** — File tree. Changed files are listed with their git status. Files in the current hunk are shown in color (green=added, yellow=modified, red=deleted). Unassigned files are dimmed.
- **Right pane** — Unified diff of the selected file.
- **Bottom bar** — Contextual key guide or status messages.

### Keybindings

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move selection in file tree |
| `Space` | Toggle selected file in/out of current hunk |
| `c` | Commit the current hunk |
| `s` | Skip the current hunk (files become unassigned) |
| `n` | Analyze remaining unassigned files and generate the next hunk candidate |
| `a` | Add all unassigned files to the current hunk |
| `r` | Remove all files from the current hunk |
| `e` | Edit the commit message (Enter to confirm, Escape to cancel) |
| `q` / `Escape` | Quit `/git-diff` |
| `?` | Show/hide full keybinding help |

### Workflow

1. **Snapshot** — Working tree changes are stashed to freeze the diff.
2. **Analysis** — AI splits the diff into logical hunks with Conventional Commit messages.
3. **Review** — Browse files, read diffs, and adjust which files belong to the current hunk.
4. **Edit message** — Press `e` to customize the AI-generated commit message.
5. **Commit** — Press `c` to stage and commit the current hunk.
6. **Iterate** — Remaining unassigned files are shown; press `n` to generate the next hunk, or continue adjusting.
7. **Restore** — When done (or quit), the stash is popped to restore the working tree.

### Notes

- If you quit without committing all changes, uncommitted files remain in the working tree (the stash is popped).
- Pre-commit hooks run normally; if a commit fails, the error is shown and you can edit the message and retry.
- Side-by-side (two-column) diff display is planned as a future enhancement.

---

## Environment & Concurrency

- All commands that modify the working tree (`/git-agg-commit`) detect and prevent concurrent execution to avoid staging area conflicts.
- Settings are read with `cwd`-aware resolution, so running pi from a subdirectory of a monorepo still respects the repository root's `.pi-git/settings.json`.
