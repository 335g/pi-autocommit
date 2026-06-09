# auto_agg_commit: 小規模変更時の確認ダイアログ実装プラン

## 背景

現在 `auto_agg_commit: true` が設定されている場合、`agent_end` イベントで
1ファイルでも変更があれば自動的にコミットが作成される。

ユーザーは以下の挙動を求めている:
> ファイル数や変更行数が少ない時には自動でコミットせずに一旦ユーザに問い合わせて欲しい

つまり:
- 変更が**大きい**（多数ファイル、多数行）→ 現行通り自動コミット
- 変更が**小さい**（少数ファイル、少数行）→ ユーザーに確認ダイアログを表示し、Yes ならコミット、No ならスキップ

## 設計判断

### 閾値ロジック: OR 条件

「ファイル数 **または** 変更行数が少ない」→ OR 条件で判定する。

```
IF (changed_files <= min_files) OR (changed_lines <= min_lines):
    → 確認ダイアログを表示
ELSE:
    → 自動コミット（現行通り）
```

**理由**: ユーザーの「ファイル数や変更行数が少ない時」という表現（「や」= OR）に従う。
片方でも「小さい」と判断される変更は、ユーザーが意図しない微修正の可能性があるため確認する。

### 閾値のデフォルト値

| 設定キー | デフォルト値 | 意味 |
|---|---|---|
| `auto_agg_commit_min_files` | `3` | 変更ファイル数が3以下の場合に確認 |
| `auto_agg_commit_min_lines` | `20` | 変更行数が20行以下の場合に確認 |

### 確認 UI

TUI オーバーレイでシンプルな Yes/No ダイアログを表示する。
`ctx.ui.custom()` の overlay モードを使用し、以下の情報を表示:
- 変更ファイル一覧（最大5件、超過時は "...and N more"）
- 変更行数
- "Commit this change?" Yes / No

ユーザーが Yes (Enter または y) → コミット処理を続行
ユーザーが No (Esc または n) → コミットをスキップ

ダイアログにタイムアウトは設けない（ユーザーが明示的に選択するまで待つ）。

### 設定キーが未設定時の挙動

`auto_agg_commit_min_files` / `auto_agg_commit_min_lines` が未設定（undefined）の場合は
デフォルト値（3, 20）を使用する。つまり、明示的に設定しなくても確認機能は有効になる。

確認機能を完全に無効化したいユーザーは値を `0` に設定することで、
常に `changed_files > 0` / `changed_lines > 0` となり確認をスキップできる。

## 変更ファイル

### 1. `src/utils/settings.ts` — 設定キーの追加

- `PiGitSettings` インターフェースに以下を追加:
  ```ts
  auto_agg_commit_min_files?: number;
  auto_agg_commit_min_lines?: number;
  ```
- `DEFAULT_SETTINGS` にデフォルト値 `auto_agg_commit_min_files: 3`, `auto_agg_commit_min_lines: 20` を追加
- `VALID_KEYS_META` に2つの新規メタデータエントリを追加（type: "number"）
- 利便性ゲッター `getAutoAggCommitMinFiles()`, `getAutoAggCommitMinLines()` を追加

### 2. `src/commands/config.ts` — 設定キーのバリデーション

- `ValidKey` 型に `"auto_agg_commit_min_files" | "auto_agg_commit_min_lines"` を追加
- `validateValue()` に number パースとバリデーション（正の整数、または 0）を追加

### 3. `src/i18n/messages.ts` — メッセージの追加

#### 設定キー説明（en/ja 両方）
```
"config.keyDesc.auto_agg_commit_min_files":
  "Minimum number of changed files to skip auto-commit confirmation"
  "自動コミット確認をスキップする最小ファイル数"

"config.keyDesc.auto_agg_commit_min_lines":
  "Minimum number of changed lines to skip auto-commit confirmation"
  "自動コミット確認をスキップする最小変更行数"
```

#### 確認ダイアログ用メッセージ
```
"autoCommit.confirmTitle": "Confirm Auto-Commit" / "自動コミットの確認"
"autoCommit.confirmBody":
  "{count} file(s) changed ({lines} lines). Commit this change?"
  "{count}ファイル変更（{lines}行）。この変更をコミットしますか？"
"autoCommit.confirmYes": "Yes (Enter)" / "はい (Enter)"
"autoCommit.confirmNo": "No (Esc)" / "いいえ (Esc)"
"autoCommit.confirmMoreFiles": "...and {count} more files" / "...他{count}ファイル"
"autoCommit.confirmSkipped":
  "Auto-commit skipped (user declined)" / "自動コミットをスキップしました"
```

### 4. `src/core/auto-commit.ts` — 確認フローの追加

`handleAutoCommit()` 関数内、`changedFiles` と `diff` を取得した後、
コミットメッセージ生成の**前**に確認フローを挿入する。

疑似コード:
```ts
// Count changed lines from diff
const changedLines = countChangedLines(diff);

const minFiles = getAutoAggCommitMinFiles(ctx.cwd);
const minLines = getAutoAggCommitMinLines(ctx.cwd);

// If thresholds are configured (>0) and change is small, ask user
if ((minFiles > 0 && minLines > 0) &&
    (changedFiles.length <= minFiles || changedLines <= minLines)) {
  const confirmed = await showConfirmDialog(ctx, changedFiles, changedLines);
  if (!confirmed) {
    ctx.ui.notify(t(lang, "autoCommit.confirmSkipped"), "info");
    return;
  }
}
```

#### 変更行数のカウント方法

`git diff --stat` の出力、または diff 本文の `+` / `-` 行カウントから算出。
最も信頼性の高い方法として `git diff --stat HEAD -- <files>` の出力をパースする。

`--stat` 出力例:
```
 src/foo.ts | 5 +++--
 1 file changed, 3 insertions(+), 2 deletions(-)
```

最終行の `N insertions(+), M deletions(-)` から `N + M` を合計行数とする。

#### 確認ダイアログコンポーネント

`showConfirmDialog()` 関数（新規作成。同ファイル内または別ファイル）:
- `ctx.ui.custom()` を overlay モードで使用
- 中央に小さなダイアログを表示
- キーボード操作: Enter / y → true, Esc / n → false
- コンポーネントは一度きりの使用のためシンプルに実装

### 5. `src/index.ts` — 変更不要

`handleAutoCommit` の内部変更のみで、イベントハンドラの登録方法に変更はない。

## レビュー観点

1. **閾値ロジックの妥当性**: OR 条件で正しいか（AND の方が良いケースはないか）
2. **デフォルト値の適切さ**: min_files=3, min_lines=20 は実用的か
3. **UX**: 確認ダイアログはユーザーフレンドリーか（情報量、操作感）
4. **エッジケース**: 
   - 新規ファイルのみ（diff が空）の場合の行数カウント
   - バイナリファイル変更時の行数カウント
   - footerManager 実行中との競合
5. **設定の後方互換性**: 既存の `auto_agg_commit: true` ユーザーへの影響
6. **i18n の完全性**: en/ja 両方のメッセージが揃っているか
