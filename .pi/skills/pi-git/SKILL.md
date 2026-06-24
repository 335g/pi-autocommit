---
name: pi-git
description: Stage all current files and automatically generate a commit message from the changes, then commit
---

# pi-git Skill

A skill for committing AI-agent-made changes in bulk with appropriate Conventional Commits messages.

## Prerequisite: Load configuration

Read `.pi-git/config.toml` from the project root to determine the language of the commit message body.

```toml
; Example configuration
lang = "ja"   ; Body language (default: English)
```

Rules based on the `lang` key:

| `lang` value | Commit subject | Commit body |
|-----------|----------------------------------|-------------------------------|
| `"ja"`    | English (Conventional Commits standard) | Japanese |
| Anything else, unset, or file missing | English | English |

> **Subject** = `feat(cmd): add interactive shell mode` part. Always in English regardless of language setting.
> **Body** = Detailed description of changes. Follows the `lang` setting.

## Workflow

### 1. Check changes

```bash
git status --short
```

Exit immediately if there are no changes.

### 2. Stage all files

```bash
git add -A
```

### 3. Analyze changes

Retrieve the following information to construct the commit message:

- `git diff --cached --stat` — list of changed files
- `git diff --cached` — actual diff content
- `git diff --cached --name-status` — change type per file (added/modified/deleted/renamed)

### 4. Generate Conventional Commits message

Generate the message according to the following rules.

**Type selection criteria:**

| Type | Conditions |
|------|------------|
| `feat` | New feature, implementation of a new command/option/API |
| `fix` | Bug fix, correction of unintended behavior |
| `refactor` | Improve code structure without changing behavior |
| `chore` | Build configuration, dependencies, CI setup, repository configuration |
| `docs` | Documentation-only changes (README, SKILL.md, comments) |
| `test` | Adding or modifying tests |
| `style` | Code formatting, semicolons, indentation (no behavioral impact) |
| `perf` | Performance improvements |

When a change spans multiple types, select the most significant one as the type and describe the rest in the body.

**Scope:**

If possible, describe the affected scope in parentheses (e.g., `feat(cmd):`, `fix(skill):`). There is no fixed list of scopes; determine an appropriate one from the changes.

**Subject rules:**

```
type(scope): brief summary
```

- Write in English (regardless of `lang` value)
- Use imperative present tense ("add", "fix", "update")
- Start with a lowercase letter
- Do not end with a period
- Aim for 50 characters or fewer

**Body rules:**

- List the changed files
- Briefly describe what was changed in each file
- Explain why the change was necessary (as far as possible)
- Follow the language specified by `lang`
- Recommended to wrap at 72 characters

**Footer:**

If there is a BREAKING CHANGE, clearly note it with `BREAKING CHANGE: ...` or the `!` marker.

**Example output (with `lang = "ja"`):**

```
feat(cmd): add interactive shell mode

変更内容:
- src/commands/interactive.ts — 新規作成。インタラクティブシェルモードの
  コマンドハンドラを実装
- src/shell/runner.ts — シェルプロセスの起動・管理ロジックを追加
- tests/interactive.test.ts — インタラクティブモードの統合テストを追加

ユーザーがエージェントと対話しながらシェルコマンドを実行できるように
するための新機能。子プロセスの管理には node-pty を使用。
```

**Example output (default: English):**

```
feat(cmd): add interactive shell mode

Changes:
- src/commands/interactive.ts — new command handler for interactive
  shell mode
- src/shell/runner.ts — add shell process lifecycle management
- tests/interactive.test.ts — integration tests for interactive mode

Introduces a new interactive mode where the user can run shell
commands while conversing with the agent. Uses node-pty for
subprocess management.
```

### 5. User confirmation

Present the generated commit message to the user and ask for confirmation:

```
Commit with the following message?

  {full generated message}

[Y] Execute commit / [N] Cancel and retry / [Edit] Modify the message
```

Respond based on the user's input:
- **Y** → Proceed to step 6
- **N** → Abort and ask the user for instructions
- **Edit request** (any text) → Modify the message as requested and re-confirm

### 6. Execute commit

```bash
git commit -m "<subject>

<body>

<footer>"
```

Display the result on success.

## Edge cases

| Situation | Response |
|-----------|----------|
| No changes | Display "No changes" and exit |
| Only new untracked files | Add & commit as usual (`git add -A` handles these) |
| Merge conflict in progress | Abort the commit and prompt the user to resolve conflicts first |
| Empty commit (all changes already staged) | Run `git commit` normally |
