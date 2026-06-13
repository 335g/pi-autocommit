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
    "@335g/pi-git": "^0.0.4"
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
| [`/git-config`](#git-config) | Get, set, or list pi-git configuration values |

### `/git-agg-commit`

Automatically analyzes the working tree diff, splits changes into logical hunks, generates [Conventional Commits](https://www.conventionalcommits.org/) style messages, stages files, and creates commits — all in one shot.

```
/git-agg-commit [--lang=<code>] [--review]
```

TurnLog conversation context is automatically accumulated across turns and injected into the AI prompt for higher-quality hunk splitting. See [docs](docs/accumulate-mode.md).

### `/git-config`

Gets, sets, or lists pi-git configuration values. Supports global (`~/.config/pi-git/settings.json`) and local (`<repo-root>/pi-git.toml`) scopes.

```
/git-config <key> [value] [--global] [--list] [--show-origin] [--keys] [--models] [--help]
```

**Key settings**:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `lang` | `string` | `"en"` | Display and commit message language (`"en"` / `"ja"`) |
| `analysis_model` | `string` | `""` | AI model for diff analysis |

---

## Documentation

- **[TurnLog + Batch Commit Guide](docs/accumulate-mode.md)**
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
