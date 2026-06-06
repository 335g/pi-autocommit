# pi-git コマンドリファレンス

`pi-git` 拡張機能が提供するすべてのスラッシュコマンドの仕様を解説します。

---

## `/git-agg-commit`

ワーキングツリーの差分を自動解析し、論理的な hunk に分割して [Conventional Commits](https://www.conventionalcommits.org/) スタイルのコミットメッセージを生成、ステージングしてコミットまで一気に行います。

### 使い方

```
/git-agg-commit
/git-agg-commit --lang=ja
/git-agg-commit --language=en
```

### オプション

| オプション | 説明 |
|-----------|------|
| `--lang=<code>`<br>`--language=<code>` | **この実行のみ**言語を上書きします。指定可能な値: `en`（英語）、`ja`（日本語）。 |

> **注意:** `--lang` はどの設定ファイルにも保存しません。言語設定を永続化する場合は `/git-config` を使用してください。

### 実行フェーズ

| フェーズ | 英語 | 日本語 |
|----------|------|--------|
| 準備 | `[pi-git] Preparing...` | `[pi-git] 準備中...` |
| diff 収集 | `[pi-git] Collecting diff...` | `[pi-git] diff収集中...` |
| hunk 解析 | `[pi-git] Analyzing hunks...` | `[pi-git] hunk解析中...` |
| メッセージ生成 | `[pi-git] Generating messages...` | `[pi-git] コミットメッセージ生成中...` |
| コミット実行 | `[pi-git] Committing...` | `[pi-git] コミット実行中...` |

`auto-agg-commit` が有効な場合、ステータス接頭辞は `[pi-git: auto-commit]` になり、永続的な `auto-commit: on (...)` インジケータは実行中に一時的に非表示になり、ステータス行の重複を防ぎます。

### 動作仕様

| 状況 | 動作 |
|------|------|
| Git リポジトリでない | 警告して中止 |
| ワーキングツリーに変更がない | 通知して終了 |
| 非インタラクティブモード | 黙ってスキップ |
| pre-commit フック失敗 | ステージングをリセットして警告し、残りの hunk は継続 |
| AI モデル利用不可 / 認証失敗 | ファイル単位の分割にフォールバック |
| untracked ファイル | diff 解析・コミットに含まれる |
| 実行中にファイル編集 | 安全: 開始時に `git stash` で差分をスナップショットしているため、並行編集の影響を受けない |
| 既に `/git-agg-commit` 実行中 | 警告してブロック。ステージング領域の衝突を防ぐ |

### コミットメッセージ形式

[Conventional Commits](https://www.conventionalcommits.org/) に従います:

```
<type>[(scope)]: <subject>
```

type は AI が自動推論し、以下のいずれかにバリデーションされます: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `revert`

---

## `/git-auto-agg-commit`

自動 `git-agg-commit` 機能の ON/OFF を切り替えます。有効時は、アシスタントの応答完了後にワーキングツリーに未コミットの変更があれば、自動で `/git-agg-commit` を実行します。

### 使い方

```
/git-auto-agg-commit         # 現在の状態を表示
/git-auto-agg-commit on      # 有効化
/git-auto-agg-commit off     # 無効化
/git-auto-agg-commit toggle  # トグル
```

### 動作仕様

- 設定は **ローカル** 設定 (`<リポジトリルート>/.pi-git/settings.json`) に保存されます（Git リポジトリ内の場合）。リポジトリ外の場合は **グローバル** 設定 (`~/.config/pi-git/settings.json`) にフォールバックします。
- 有効時はフッターに `auto-commit: on (clean)` または `auto-commit: on (changed)` の永続インジケータが表示されます。
- トリガーは `agent_end` イベントです。
- 別の `/git-agg-commit` が実行中の場合、自動実行はスキップされます。

---

## `/git-config`

`pi-git` の設定値を取得・設定・一覧表示します。グローバルスコープとローカルスコープの両方に対応しています。

### 設定の優先順位

1. **ローカル設定** — `<リポジトリルート>/.pi-git/settings.json`（最優先）
2. **グローバル設定** — `~/.config/pi-git/settings.json`
3. **ビルトイン既定値** — `{"lang": "en", "auto_agg_commit": false, "analysis_model": ""}`（最下位）

ローカル設定に存在するキーはグローバルを上書きします。ローカルにキーがない場合はグローバル値（または既定値）が使用されます。

### 利用可能なキー

| キー | 型 | 既定値 | 説明 |
|------|----|--------|------|
| `lang` | `string` | `"en"` | 表示・コミットメッセージの言語。`"en"` または `"ja"`。 |
| `auto_agg_commit` | `boolean` | `false` | アシスタント応答後に自動で `git-agg-commit` を実行するかどうか。 |
| `analysis_model` | `string` | `""` | diff 分析に使用する AI モデル（`provider/model-id` 形式、例: `anthropic/claude-3-5-sonnet-20241022`）。空の場合は現在のセッションモデルが使用されます。 |

### 使い方

```
# 値を取得（実効値が表示されます）
/git-config lang

# 値を設定（既定: リポジトリ内ならローカル、それ以外ならグローバル）
/git-config lang ja

# グローバルスコープで明示的に設定
/git-config --global lang ja

# 実効値の一覧を表示
/git-config --list

# 出典付きで一覧表示
/git-config --list --show-origin

# 有効なキー一覧と説明を表示
/git-config --keys

# analysis_model に設定可能なモデル一覧を表示
/git-config --models
```

### スコープのルール

| 状況 | 保存先 | 動作 |
|------|--------|------|
| Git リポジトリ内、 `--global` なし | ローカル | `<リポジトリルート>/.pi-git/settings.json` に保存 |
| Git リポジトリ内、 `--global` あり | グローバル | `~/.config/pi-git/settings.json` に保存 |
| Git リポジトリ外、 `--global` なし | グローバル（フォールバック） | `~/.config/pi-git/settings.json` に保存し、通知で報告 |
| 初回書き込みで両方の設定が存在しない | ローカル（既定値で初期化） | `.pi-git/settings.json` をすべての既定値＋指定値で作成 |

### 使用例

```bash
# 現在の実効言語を確認
/git-config lang
# → ja

# このリポジトリだけ日本語にする
/git-config lang ja
# → ローカル設定に保存しました

# グローバルに設定（ローカルで上書きされていないリポジトリ全てに適用）
/git-config --global lang en

# すべての設定とその出典を確認
/git-config --list --show-origin
# → lang=ja (local)
# → auto_agg_commit=false (default)
# → analysis_model=anthropic/claude-3-5-sonnet-20241022 (local)
```

---

## 設定ファイル

### グローバル設定

パス: `~/.config/pi-git/settings.json`

手動で編集可能な JSON ファイルです。ローカル設定がない、またはローカルで上書きされていないキーのフォールバックとして使用されます。

### ローカル設定

パス: `<git-repo-root>/.pi-git/settings.json`

プロジェクト固有の上書き設定です。Git リポジトリ内で初めて `/git-config` で書き込んだとき、グローバル・ローカル両方の設定ファイルが存在しない場合は自動的に作成されます。ファイルには「グローバル/既定値と異なる値、または明示的に上書きしたい値」のみを記述することを推奨します。

**推奨事項:** チームで設定を共有したい場合は `.pi-git/settings.json` をコミットしてください。個人ごとに異なる設定にしたい場合は `.pi-git/` を `.gitignore` に追加してください。

---

## 環境と並行性

- ワーキングツリーを変更するコマンド（`/git-agg-commit`）は、並行実行を検出して防止します。ステージング領域の衝突を避けるためです。
- 設定は `cwd` を考慮して解決されます。monorepo のサブディレクトリから pi を実行しても、リポジトリルートの `.pi-git/settings.json` が正しく読み込まれます。
