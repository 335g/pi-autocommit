# @335g/pi-git

[![npm version](https://img.shields.io/npm/v/@335g/pi-git.svg)](https://www.npmjs.com/package/@335g/pi-git)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) の拡張機能です。
LLM またはヒューリスティックフォールバックを用いて [Conventional Commits](https://www.conventionalcommits.org/) 形式のコミットメッセージを生成する `/git-commit`・`/git-review` コマンドと、リポジトリステータスを表示する `/git-status` コマンドを追加します。

## 特徴

- **`/git-status` コマンド** – ワーキングツリーとステージされた変更をスクロール可能なカラー表示の TUI ビューワで確認（pi から離れる必要なし）
- **`/git-commit` コマンド** – 変更をステージし、ファイル選択、AI 生成、確認を経てコミット
- **`/git-review` コマンド** – [crit](https://github.com/335g/crit) によるインラインレビューを経てコミットメッセージを生成
- **インラインコミットメッセージ** – `/git-commit fix typo` のようにメッセージを直接指定すると AI 生成をスキップ
- **AI による生成** – pi の LLM を利用してステージされた差分から Conventional Commits メッセージを生成
- **ヒューリスティックフォールバック** – LLM が利用できない場合、差分解析からコミットメッセージを生成
- **対話型ファイル選択** – どのファイルをコミットに含めるか選択可能。Space キーで差分プレビュー（TUI モード）
- **対話型確認** – 生成されたコミットメッセージを確認・編集・キャンセルしてから実行
- **言語対応** – コミットメッセージを英語または日本語で記述可能（`.pi/pi-git.json` で設定）
- **自動コミット** – `commitEveryTurn: true` 設定で各エージェントターン終了時に自動コミット
- **マージコンフリクト検出** – マージ競合中はコミットを拒否
- **ドライランモード** – `--dry-run` でコミットメッセージのプレビューのみ実行

## インストール

```bash
pi install @335g/pi-git
```

または pi のパッケージ設定に追加:

```json
{
  "packages": {
    "@335g/pi-git": "latest"
  }
}
```

## 使い方

### Git ステータスの表示

```
/git-status
```

ワーキングツリーの状態をスクロール可能なカラー表示の TUI ビューワで表示します。
`!git status` でシェルに抜ける必要はありません。

TUI モード:
- `↑↓` 1行スクロール
- `PgUp` / `PgDn` 20行ジャンプ
- `Esc` / `Ctrl+C` 閉じる

非 TUI モード（RPC/JSON/print）では `ctx.ui.notify()` で出力を表示します。

### 基本コミット

pi セッション内で、git リポジトリの中で以下を実行:

```
/git-commit
```

以下の処理が自動で行われます:
1. マージコンフリクトの確認
2. 未コミットの変更の確認
3. 全ファイルをステージ (`git add -A`)
4. ファイル選択（TUI モード）— Space で差分プレビュー、Enter で確定
5. LLM による Conventional Commits メッセージの生成
6. メッセージの確認（Y/編集/キャンセル）
7. コミットの実行

### インラインコミットメッセージ

```
/git-commit fix typo in header
```

AI 生成をスキップし、指定されたメッセージでコミットします。
ファイル選択は通常通り実行されます（TUI モード）。

### レビュー → コミット

[crit](https://github.com/335g/crit) のインストールが必要です（`npm install -g crit`）。

```
/git-review
```

`/git-commit` と同様のフローですが、ステージとファイル選択の後に:
1. ブラウザで crit レビューが開き、差分にインラインコメントを付けられます
2. レビュー完了後、未解決コメントがあれば表示
3. コメントをコミットメッセージのコンテキストに含めるか選択
4. レビューコメントを反映したコミットメッセージを生成
5. 確認・編集してコミット

### ドライランモード

実行せずにプレビュー:

```
/git-commit --dry-run
/git-review --dry-run
```

パイプライン全体（ステージ、ファイル選択、LLM 生成、確認）は実行されますが、
実際の `git commit` はスキップされます。ファイルはアンステージされません。

### ファイル選択（TUI モード）

`/git-commit` または `/git-review` を TUI モードで実行すると、ファイル選択画面が表示されます:

```
 Select files to commit  (3/5)
   select   stat    type  file
  ─────── ─────── ──── ────
  ▸ ●     +10/-2  mod  src/index.ts
    ○              new  src/pipeline.ts
    ●     +5/-0   mod  src/config.ts

  ↑↓ navigate  → select  ← deselect  space preview  a all  enter commit  esc cancel
```

- `↑↓` 移動
- `→` 選択、`←` 選択解除
- `Space` — 全画面差分プレビュー（QuickLook 風）
- `a` — すべて選択/解除
- `Enter` — 確定
- `Esc` / `Ctrl+C` — キャンセル

### 設定

プロジェクトルートに `.pi/pi-git.json` を作成:

```json
{
  "lang": "ja",
  "noBody": true,
  "commitEveryTurn": false
}
```

| キー | 型 | デフォルト | 説明 |
|-----|------|---------|-------------|
| `lang` | string | `"en"` | コミットメッセージの言語: `"ja"`（日本語）または `"en"`（英語） |
| `noBody` | boolean | `false` | ボディを省略し件名のみに |
| `commitEveryTurn` | `boolean` \| `{ trigger: "agent_end" \| "turn_end" }` | `false` | 自動コミット戦略 |

#### `commitEveryTurn`

自動コミットのタイミングと方式を制御します。

```json
{
  "commitEveryTurn": {
    "trigger": "turn_end"
  }
}
```

- `false` — 無効。
- `true` — 旧式の動作と同じで、`{ "trigger": "agent_end" }` のエイリアス。
- `{ "trigger": "agent_end" }` — 各エージェントループ終了時に1度コミット。
- `{ "trigger": "turn_end" }` — ファイルを変更する各ターン終了時に軽量な WIP コミットを作成し、
  エージェントループ終了時にそれらを論理単位の Conventional Commits に再編成。

`turn_end` 戦略は、1回の依頼で多くの変更を行う長いエージェントセッション（たとえば goal コマンド）
で便利です。ファイルを変更するターンごとに即座に checkpoint が作成され、`agent_end` でそれらを
soft reset して LLM が再分析し、整理されたきれいなコミットを生成します。

バックグラウンドで動作し、進捗やエラーは UI に通知されますが、
対話的な確認は不要です。手動の `/git-commit` と併用しても安全です。
実際に変更がある場合のみコミットします。

## コミットメッセージ規約

生成されるメッセージは [Conventional Commits](https://www.conventionalcommits.org/) 仕様に従います:

```
type(scope): subject

body

footer
```

### タイプ一覧

| タイプ      | 説明                               |
|------------|-----------------------------------|
| `feat`     | 新機能、コマンド、オプション、API     |
| `fix`      | バグ修正、意図しない動作の修正        |
| `refactor` | 振る舞いを変えないコード構造の改善     |
| `chore`    | ビルド設定、依存関係、CI、リポジトリ設定 |
| `docs`     | ドキュメントのみの変更               |
| `test`     | テストの追加・修正                   |
| `style`    | コードフォーマット（振る舞いに影響なし）|
| `perf`     | パフォーマンス改善                   |

## 開発

```bash
# 依存関係のインストール
npm install

# ビルド
npm run build

# テスト実行
npm test
```

## 必要条件

- [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)（ピア依存関係）
- [pi-ai](https://github.com/earendil-works/pi-ai)（ピア依存関係）
- [pi-tui](https://github.com/earendil-works/pi-tui)（オプションのピア依存関係 – 対話型ファイル選択・確認 UI を有効化）
- [crit](https://github.com/335g/crit)（オプション – `/git-review` コマンドに必要）

## ライセンス

MIT © Yoshiki Kudo
