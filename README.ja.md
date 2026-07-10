# @335g/pi-autocommit

[![npm version](https://img.shields.io/npm/v/@335g/pi-autocommit.svg)](https://www.npmjs.com/package/@335g/pi-autocommit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) の拡張機能です。
ユーザがコミットメッセージを書かなくて済むように、変更を自動でコミットします。
**checkpoint-then-reorganise** 戦略を採用しており、ファイルを変更する各ターンの終わりに軽量な checkpoint コミットを作成し、エージェントループ終了時にそれらを soft reset して LLM が論理的な [Conventional Commits](https://www.conventionalcommits.org/) に再構成します。

> **`@335g/pi-git` から移行した方へ**：下記の [移行ガイド](#335gpi-git-からの移行) を参照してください。`/git-commit` と `/git-status` コマンドは削除され、自動コミットのみが機能となりました。

## 特徴

- **自動チェックポイント** — ファイルを変更するターン終了ごとにコミットを作成するため、途中経過が失われることはありません。
- **LLM による再構成** — エージェントループ終了時に checkpoint を soft reset し、アシスタント自身の推論をコンテキストとして論理的な Conventional Commits に分割します。
- **ヒューリスティックフォールバック** — LLM が利用できない場合は差分解析から単一の Conventional Commit を生成します。
- **未コミット変更のフッター表示** — ワーキングツリーに変更があるかをフッターに表示し、checkpoint に取り込まれる前に意図しないファイルに気づけるようにします。
- **言語対応** — コミットメッセージを英語または日本語で生成可能。
- **マージコンフリクト検出** — マージ競合中はコミットをスキップします。

## インストール

```bash
pi install @335g/pi-autocommit
```

または pi のパッケージ設定に追加:

```json
{
  "packages": {
    "@335g/pi-autocommit": "latest"
  }
}
```

## 仕組み

自動コミットは**デフォルトで有効**です。インストールすると、拡張機能は次を行います。

1. **`turn_end`** — ファイルを変更するツール（`write`, `edit`, `bash`）を実行したターンの終了後、ワーキングツリーに変更があればすべてステージ（`git add -A`）し、checkpoint コミットを作成します:
   ```
   wip(checkpoint): auto-commit at turn N
   ```
2. **`agent_end`** — エージェントループ終了時に HEAD にある checkpoint コミットを数え、soft reset し、LLM に結合差分を論理的な Conventional Commits に分割させます（アシスタント自身のメッセージをコンテキストとして使用）。各論理グループを順にステージしてコミットします。

フッター表示（`[has changes]`）は未コミット変更の有無を知らせます。次のプロンプトを書く前に確認すれば、意図しないファイルの混入に気づけます。

バックグラウンドで動作し、進捗やエラーは UI に通知されますが、対話的な確認は不要です。

## 設定

プロジェクトルートに `.pi/pi-autocommit.json` を作成:

```json
{
  "lang": "ja",
  "enable": true,
  "model": "anthropic/claude-sonnet-4"
}
```

| キー | 型 | デフォルト | 説明 |
|-----|------|---------|-------------|
| `lang` | string | `"en"` | コミットメッセージの言語: `"ja"`（日本語）または `"en"`（英語） |
| `enable` | boolean | `true` | 自動コミットを有効にするか |
| `model` | string | — | コミットメッセージ生成に使用する LLM モデルを `"provider/modelId"` 形式で指定（例: `"anthropic/claude-sonnet-4"`）。省略時はセッションの現在のモデルを使用 |
| `scope` | object | — | パスから scope へのマッピング。Conventional Commits の scope を決定論的に固定します。設定すると LLM は scope を推論せず、変更ファイルパスから解決されます。下記の [スコープマッピング](#スコープマッピング) を参照 |

### 自動コミットを無効化する

```json
{
  "enable": false
}
```

git リポジトリ外では設定に関わらず何もしません。

### スコープマッピング

デフォルトでは、コミットの scope は LLM が変更ファイルパスから推論します。機能開発中やサブプロジェクトが特定ディレクトリ以下にある場合など、scope を固定したい時は `scope` にパス→scope のマッピングを設定します:

```json
{
  "scope": {
    "packages/frontend/**": "frontend",
    "packages/backend/**": "backend",
    "**": "app"
  }
}
```

キーは [picomatch](https://github.com/micromatch/picomatch) の glob で、変更ファイルパスに対して評価されます。1コミット内の全ファイルが **同じ scope** に解決された時その scope が採用され、**異なる scope** に解決された時（またはどれにもマッチしない時）は scope が省略されます（`type: subject`）。複数マッチした時は最も具体的な（リテラルが長い）glob が優先されます。

`scope` を設定すると LLM には `type: subject`（scope なし）で書くよう指示し、scope は決定論モジュールが注入します — これにより scope がブレることがありません。`scope` 未設定時は従来通り LLM が推論する挙動が維持されます。

`**` glob を使えば、リポジトリ全体を単一の scope に固定できます:

```json
{ "scope": { "**": "auth" } }
```

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

## `@335g/pi-git` からの移行

`@335g/pi-git` は `@335g/pi-autocommit` にリネームされ、スコープを自動コミットに絞りました。

- `/git-commit` と `/git-status` コマンドは**削除されました**。手動操作には pi の `!git commit` / `!git status` を使用してください。
- 設定ファイルは `.pi/pi-git.json` から **`.pi/pi-autocommit.json`** に移動しました。古いファイルは**読み込まれません**。
- `commitEveryTurn` は **`enable`** にリネームされ、デフォルトは **`true`** になりました（autocommit パッケージを入れて何も起きないのは不自然だからです）。
- `noBody` は削除されました。コミットメッセージは常にボディを含みます。

移行手順:

```bash
pi uninstall @335g/pi-git
pi install @335g/pi-autocommit
```

設定ファイルをリネームし、キーを調整してください:

```json
// .pi/pi-autocommit.json
{
  "lang": "ja",
  "enable": true
}
```

旧 `@335g/pi-git` パッケージは npm で `deprecated` 扱いになりますが、インストール自体は可能です。

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
- [pi-tui](https://github.com/earendil-works/pi-tui)（オプションのピア依存関係 – フッターステータス表示を有効化）


## ライセンス

MIT © Yoshiki Kudo
