---
name: pi-git
description: 現状の全ファイルについてステージングし、これらのファイルの変更内容等の情報からコミットメッセージを自動で作成し、コミットする
---

# pi-git Skill

AIエージェントが編集した変更を、適切な Conventional Commits メッセージで一括コミットするためのスキル。

## 事前準備：設定ファイルの読み込み

コミットメッセージの本文の言語を決定するため、プロジェクトルートの `.pi-git/config.toml` を読み込む。

```toml
; 設定例
lang = "ja"   ; 本文の言語（デフォルト: 英語）
```

`lang` キーの値に応じたルール：

| lang の値 | コミットメッセージ件名（subject） | コミットメッセージ本文（body） |
|-----------|----------------------------------|-------------------------------|
| `"ja"`    | 英語（Conventional Commits標準） | 日本語 |
| それ以外 または 未設定/ファイル不在 | 英語 | 英語 |

> **件名（subject）** = `feat(cmd): add interactive shell mode` の部分。言語によらず英語。
> **本文（body）** = 変更の詳細説明。`lang` の値に従う。

## ワークフロー

### 1. 変更の確認

```bash
git status --short
```

変更がない場合は即座に終了する。

### 2. 全ファイルをステージング

```bash
git add -A
```

### 3. 変更内容の分析

以下の情報を取得し、コミットメッセージの材料とする：

- `git diff --cached --stat` — 変更ファイル一覧
- `git diff --cached` — 実際の変更内容
- `git diff --cached --name-status` — ファイルごとの変更種別（追加/変更/削除/リネーム）

### 4. Conventional Commits メッセージの生成

以下のルールでメッセージを生成する。

**型（type）の判定基準:**

| 型 | 条件 |
|------|------|
| `feat` | 新機能の追加、新しいコマンド・オプション・APIの実装 |
| `fix` | バグ修正、意図しない動作の是正 |
| `refactor` | 振る舞いを変えずにコード構造を改善 |
| `chore` | ビルド設定、依存関係、CI設定、リポジトリ設定 |
| `docs` | ドキュメントのみの変更（README、SKILL.md、コメント） |
| `test` | テストの追加・修正 |
| `style` | コードフォーマット、セミコロン、インデント（振る舞いに影響なし） |
| `perf` | パフォーマンス改善 |

複数の型にまたがる変更が含まれる場合、最も主要なものを型として選び、その他の変更は本文に記載する。

**scope（スコープ）:**

可能であれば影響範囲を括弧内に記述する（例: `feat(cmd):`、`fix(skill):`）。特に決まったスコープ一覧はなく、変更内容から適切なものを判断する。

**件名（subject）のルール:**

```
型(スコープ): 簡潔な要約
```

- 英語で記述する（`lang` の値によらない）
- 命令形の現在形で書く（"add", "fix", "update"）
- 先頭は小文字
- 末尾にピリオドは付けない
- 50文字以内を目安に

**本文（body）のルール:**

- 変更のあったファイルをリストアップする
- 各ファイルで何を変更したかを簡潔に説明する
- なぜその変更が必要だったか（可能な範囲で）
- 言語は `lang` の値に従う
- 72文字で折り返し推奨

**フッター（footer）:**

BREAKING CHANGE がある場合は、`BREAKING CHANGE: ...` または `!` マーカーを付けて明記する。

**出力形式の例（`lang = "ja"` の場合）:**

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

**出力形式の例（デフォルト: 英語）:**

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

### 5. ユーザー確認

生成したコミットメッセージをユーザーに提示し、確認を求める：

```
以下のコミットメッセージでコミットしてよろしいですか？

  {生成されたメッセージ全文}

[Y] コミットを実行 / [N] やり直し / [編集] メッセージを修正
```

ユーザーの応答に応じて：
- **Y** → 手順6へ
- **N** → 処理を中断し、ユーザーの指示を仰ぐ
- **編集リクエスト**（任意の文言）→ 指定に従ってメッセージを修正し、再確認

### 6. コミット実行

```bash
git commit -m "<件名>

<本文>

<フッター>"
```

成功したら結果を表示する。

## エッジケース

| 状況 | 対応 |
|------|------|
| 変更なし | 「変更はありません」と表示して終了 |
| 新規 untracked ファイルのみ | 通常通り add & commit（`git add -A` で拾える） |
| マージコンフリクト中 | コミットを中断し、コンフリクト解決を促す |
| 空のコミット（全変更がadd済み） | 通常通り `git commit` を実行 |
