# pi-git

Git utilities extension for [pi-coding-agent](https://pi.dev).

Provides slash commands to automate and streamline git workflows within pi.

---

## Installation

### From npm (recommended)

```bash
pi install @335g/pi-git
```

Or add to your project's package.json:

```json
{
  "dependencies": {
    "@335g/pi-git": "^0.0.1"
  }
}
```

### As a local extension (development)

```bash
pi -e ./src/index.ts
```

### From local package (development)

```bash
pi install /path/to/pi-git
```

---

## Commands

| Command | Description |
|---------|-------------|
| [`/git-agg-commit`](#git-agg-commit) | Auto stage and commit changes with AI-generated Conventional Commits messages |
| [`/git-auto-agg-commit`](#git-auto-agg-commit) | Toggle automatic `git-agg-commit` after assistant responses |
| [`/git-config`](#git-config) | Get, set, or list pi-git configuration values |

### `/git-agg-commit`

Automatically analyzes the working tree diff, splits changes into logical hunks, generates [Conventional Commits](https://www.conventionalcommits.org/) style messages, stages files, and creates commits — all in one shot.

```
/git-agg-commit [--lang=<code>]
```

### `/git-auto-agg-commit`

Toggles automatic `git-agg-commit` after assistant responses. When enabled, uncommitted changes are automatically committed when the assistant finishes responding.

```
/git-auto-agg-commit [on|off|toggle]
```

### `/git-config`

Gets, sets, or lists pi-git configuration values. Supports global (`~/.config/pi-git/settings.json`) and local (`<repo-root>/.pi-git/settings.json`) scopes.

```
/git-config <key> [value] [--global] [--list] [--show-origin]
```

---

## Documentation

For detailed usage, options, keybindings, and behavior specifications, see:

- **[Command Reference (English)](docs/commands.md)**
- **[コマンドリファレンス (日本語)](docs/commands.ja.md)**

---

## Requirements

- pi-coding-agent
- Git repository
- Active AI model with API key configured (for hunk analysis)

---

## License

MIT
