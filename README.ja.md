# pi-git

[pi-coding-agent](https://pi.dev) 向けのGitユーティリティ拡張機能です。

pi内でgitワークフローを自動化・効率化するスラッシュコマンドを提供します。

---

## インストール

### npmから（推奨）

```bash
pi install @335g/pi-git
```

または、プロジェクトのpackage.jsonに追加：

```json
{
  "dependencies": {
    "@335g/pi-git": "^0.0.1"
  }
}
```

### ローカル拡張機能として（開発用）

```bash
pi -e ./src/index.ts
```

### ローカルパッケージから（開発用）

```bash
pi install /path/to/pi-git
```

---

## コマンド

| コマンド | 説明 |
|---------|------|
| [`/git-agg-commit`](#git-agg-commit) | 変更を自動ステージングし、AI生成のConventional Commitsメッセージでコミット |
| [`/git-auto-agg-commit`](#git-auto-agg-commit) | アシスタント応答後の自動 `git-agg-commit` をトグル |
| [`/git-config`](#git-config) | pi-git の設定値を取得・設定・一覧表示 |

### `/git-agg-commit`

ワーキングツリーの差分を自動解析し、論理的なhunkに分割して[Conventional Commits](https://www.conventionalcommits.org/)スタイルのコミットメッセージを生成、ステージングしてコミットまで一気に行います。

```
/git-agg-commit [--lang=<code>]
```

### `/git-auto-agg-commit`

アシスタント応答後の自動 `git-agg-commit` をトグルします。有効時は、アシスタントの応答完了時に未コミットの変更が自動的にコミットされます。

```
/git-auto-agg-commit [on|off|toggle]
```

### `/git-config`

pi-git の設定値を取得・設定・一覧表示します。グローバル（`~/.config/pi-git/settings.json`）とローカル（`<リポジトリルート>/.pi-git/settings.json`）スコープに対応しています。

```
/git-config <key> [value] [--global] [--list] [--show-origin]
```

---

## ドキュメント

詳細な使い方、オプション、キーバインド、動作仕様については、以下を参照してください：

- **[Command Reference (English)](docs/commands.md)**
- **[コマンドリファレンス (日本語)](docs/commands.ja.md)**

---

## 要件

- pi-coding-agent
- Gitリポジトリ
- APIキーが設定されたAIモデル（hunk解析用）

---

## ライセンス

MIT
