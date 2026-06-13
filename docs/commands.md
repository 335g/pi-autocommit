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
/git-agg-commit --help
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

When `auto-agg-commit` is enabled, the prefix becomes `[pi-git: auto-commit]` and the persistent `auto-commit: on (...)` status indicator is temporarily hidden during execution to avoid duplicate status lines.

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

## `/git-config`

Get, set, or list `pi-git` configuration values. Supports both global and local scopes.

### Settings Precedence

1. **Local config** — `<repo-root>/pi-git.toml` (highest priority)
2. **Global config** — `~/.config/pi-git/settings.json`
3. **Built-in defaults** — `{"lang": "en", "auto_agg_commit": false, "analysis_model": ""}` (lowest priority)

Values from local config take precedence over global config. If a key is missing in local config, the global value (or default) is used.

### Available Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `lang` | `string` | `"en"` | Display and commit message language. `"en"` or `"ja"`. |
| `analysis_model` | `string` | `""` | AI model for diff analysis in `provider/model-id` format (e.g., `anthropic/claude-3-5-sonnet-20241022`). When empty, the current session model is used. |

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

# Show all valid keys with descriptions
/git-config --keys

# List available AI models for analysis_model
/git-config --models

# Delete the global config file
/git-config --delete-global
```

### Scope Rules

| Situation | Target | Behavior |
|-----------|--------|----------|
| Inside a git repo, no `--global` | Local | Saves to `<repo-root>/pi-git.toml` |
| Inside a git repo, `--global` | Global | Saves to `~/.config/pi-git/settings.json` |
| Outside a git repo, no `--global` | Global (fallback) | Saves to `~/.config/pi-git/settings.json` with a notice |
| First write, both configs absent | Local (initialized with defaults) | Creates `pi-git.toml` with all default values plus the requested change |
| `--delete-global` | Global | Deletes `~/.config/pi-git/settings.json` |

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

# Delete the global config file
/git-config --delete-global

# List all settings with where they come from
/git-config --list --show-origin
# → lang=ja (local)
# → auto_agg_commit=false (default)
# → analysis_model=anthropic/claude-3-5-sonnet-20241022 (local)
```

---

## Settings Files

### Global Config

Path: `~/.config/pi-git/settings.json`

Manually editable JSON file. Used as the fallback when no local config exists or when a key is not overridden locally.

### Local Config

Path: `<git-repo-root>/pi-git.toml`

Project-specific overrides in TOML format. Created automatically on the first `/git-config` write inside a git repository when neither global nor local config exists yet. Only stores values that differ from or should override the global/default settings.

**Recommended:** Add `pi-git.toml` to your repository's `.gitignore` if team members should not share the same pi-git settings, or commit it if you want to share project defaults.

---

## Environment & Concurrency

- All commands that modify the working tree (`/git-agg-commit`) detect and prevent concurrent execution to avoid staging area conflicts.
- Settings are read with `cwd`-aware resolution, so running pi from a subdirectory of a monorepo still respects the repository root's `pi-git.toml`.
