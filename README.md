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

### `/git-auto-commit`

Automatically analyzes the working tree diff, splits changes into logical hunks, generates [Conventional Commits](https://www.conventionalcommits.org/) style messages, stages files, and creates commits — all in one shot.

#### Usage

```
/git-auto-commit
/git-auto-commit --lang=ja
/git-auto-commit --language=en
```

#### Options

| Option | Description |
|--------|-------------|
| `--lang=<code>`<br>`--language=<code>` | Set the display and commit message language. Supported: `en` (default), `ja`. The setting is persisted to `~/.config/pi-git/settings.json`. |

#### What it does

1. **Preparation** — Verifies the current directory is a git repository and detects changes.
2. **Diff collection** — Gathers diff from both tracked (`git diff HEAD`) and untracked files.
3. **Hunk analysis** — Sends the diff to the active AI model to split changes into logical hunks.
4. **Message generation** — Each hunk gets a Conventional Commits message (e.g., `feat: add user login`).
5. **Staging & committing** — Files are staged per-hunk and committed with the generated message.

#### Example

```bash
# Stage all changes and create logically split commits with English messages
/git-auto-commit

# Use Japanese for both status messages and commit messages
/git-auto-commit --lang=ja
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

## Requirements

- pi-coding-agent
- Git repository
- Active AI model with API key configured (for hunk analysis)

---

## License

MIT
