# pi-git

Git utilities extension for [pi-coding-agent](https://pi.dev).

Provides slash commands to automate and streamline git workflows within pi.

---

## Installation

### As a local extension

```bash
pi -e ./src/index.ts
```

### As a pi package

```bash
pi install /path/to/pi-git
```

---

## Commands

### `/git-agg-commit`

Automatically analyzes the working tree diff, splits changes into logical hunks, generates [Conventional Commits](https://www.conventionalcommits.org/) style messages, stages files, and creates commits — all in one shot.

#### Usage

```
/git-agg-commit
/git-agg-commit --lang=ja
/git-agg-commit --language=en
```

#### Options

| Option | Description |
|--------|-------------|
| `--lang=<code>`<br>`--language=<code>` | Set the display and commit message language. Supported: `en` (default), `ja`. The setting is persisted to `~/.config/pi-git/settings.json`. |

#### What it does

1. **Preparation** — Verifies the current directory is a git repository and detects changes.
2. **Diff snapshot** — Temporarily stashes all changes (including untracked files) via `git stash push -u`, captures the diff, then restores the working tree with `git stash pop`. This freezes the diff so concurrent edits do not affect analysis.
3. **Hunk analysis** — Sends the snapshotted diff to the active AI model to split changes into logical hunks.
4. **Message generation** — Each hunk gets a Conventional Commits message (e.g., `feat: add user login`).
5. **Staging & committing** — Files are staged per-hunk and committed with the generated message.

#### Example

```bash
# Stage all changes and create logically split commits with English messages
/git-agg-commit

# Use Japanese for both status messages and commit messages
/git-agg-commit --lang=ja
```

#### Generated commit message format

Messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[(scope)]: <subject>
```

Types are automatically inferred by AI, then validated to one of:
`feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `revert`.

#### Language support

- **English (`en`)** — Default.
- **Japanese (`ja`)** — Status messages and AI-generated commit messages are in Japanese.

The language setting is saved to `~/.config/pi-git/settings.json` and reused across sessions:

```json
{
  "lang": "ja"
}
```

#### Behavior

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

#### Status display

During execution, the current phase is shown in the pi footer:

| Phase | English | Japanese |
|-------|---------|----------|
| Preparation | `[pi-git] Preparing...` | `[pi-git] 準備中...` |
| Diff collection | `[pi-git] Collecting diff...` | `[pi-git] diff収集中...` |
| Hunk analysis | `[pi-git] Analyzing hunks...` | `[pi-git] hunk解析中...` |
| Message generation | `[pi-git] Generating messages...` | `[pi-git] コミットメッセージ生成中...` |
| Committing | `[pi-git] Committing...` | `[pi-git] コミット実行中...` |

---

### `/git-diff`

Interactive diff review with AI-assisted hunk decomposition. Displays a file tree and unified diff side-by-side, letting you review, adjust, and commit changes one logical hunk at a time.

#### Usage

```
/git-diff
/git-diff --lang=ja
```

#### What it does

1. **Snapshot** — Stashes the working tree to freeze the diff.
2. **Hunk analysis** — AI splits changes into logical hunks with Conventional Commit messages.
3. **Interactive review** — Browse files with `↑`/`↓`, toggle files in/out of the current hunk with `Space`, and edit the commit message with `e`.
4. **Commit** — Press `c` to stage and commit the current hunk.
5. **Iterate** — Remaining unassigned files are re-analyzed with `n` for the next hunk.
6. **Restore** — Pops the stash when done.

#### Keybindings

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move in file tree |
| `Space` | Toggle file in/out of hunk |
| `c` | Commit current hunk |
| `s` | Skip current hunk |
| `n` | Generate next hunk from remaining changes |
| `a` / `r` | Add all / Remove all files from current hunk |
| `e` | Edit commit message |
| `q` / `Escape` | Quit |
| `?` | Show keybinding help |

---

## Requirements

- pi-coding-agent
- Git repository
- Active AI model with API key configured (for hunk analysis)

---

## License

MIT
