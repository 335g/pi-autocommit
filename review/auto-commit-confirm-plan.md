# auto_agg_commit: 小規模変更時の確認ダイアログ実装プラン (v3)

## 背景

現在 `auto_agg_commit: true` が設定されている場合、`agent_end` イベントで
1ファイルでも変更があれば自動的にコミットが作成される。

ユーザーは以下の挙動を求めている:
> ファイル数や変更行数が少ない時には自動でコミットせずに一旦ユーザに問い合わせて欲しい

つまり:
- 変更が**大きい**（多数ファイル、多数行）→ 現行通り自動コミット
- 変更が**小さい**（少数ファイル、少数行）→ ユーザーに確認ダイアログを表示し、Yes ならコミット、No ならスキップ

## 設計判断（v2 からの変更点）

### v3 変更点

- **Blocker #1 修正**: `DynamicBorder` 不使用。`render()` 内で罫線を自前描画（`review.ts` と同じパターン）
- **Blocker #2 修正**: i18n 説明を正しいロジックに修正。`0 = チェック無効化（常に自動コミット）`
- 全 Note を実装上の注意点として各セクションに反映

---

## 設計判断（v1 からの変更点）

### 1. 閾値ロジック: 次元独立 OR 条件（v1 の Blocker #1 修正）

v1 では外側ガード `(minFiles > 0 && minLines > 0)` により片方 0 で全体無効化されるバグがあった。
v2 では次元ごとに独立してチェックする:

```ts
// 各次元を独立チェック。0 の次元は確認スキップ
const filesBelow = minFiles > 0 && changedFiles.length <= minFiles;
const linesBelow = minLines > 0 && changedLines <= minLines;

if (filesBelow || linesBelow) {
  // 確認ダイアログ
}
```

これにより:
- `minFiles=2, minLines=0` → 行数無視、ファイル数 2 以下なら確認（独立動作）
- `minFiles=0, minLines=10` → ファイル数無視、行数 10 以下なら確認（独立動作）
- `minFiles=0, minLines=0` → 確認機能完全無効（意図通り）

### 2. 後方互換性: オプトアウト方式（v1 の Blocker #3 対応）

デフォルト値に非ゼロを設定する（確認機能をデフォルト有効にする）。
確認を無効化したいユーザーは明示的に `0` を設定する。

| 設定キー | デフォルト値 |
|---|---|
| `auto_agg_commit_min_files` | `2` |
| `auto_agg_commit_min_lines` | `10` |

### 3. 確認ダイアログの挿入位置（v1 の Blocker #2 修正）

v1 では確認ダイアログが `footerManager.setRunning()` の**後**に配置されていた。
v2 では `footerManager.setRunning()` の**前**に移動する。具体的には:

```ts
// auto-commit.ts handleAutoCommit() 内の処理順序:

// Step 1: changedFiles と diff を取得（現行通り、変更なし）
// Step 2: 変更行数を --numstat でカウント（新規）
// Step 3: 閾値チェック + 確認ダイアログ（新規、setRunning の前）
// Step 4: footerManager.setRunning("auto-commit", "generateMessage")
// Step 5: コミットメッセージ生成 + コミット実行（現行通り）
```

### 4. 変更行数カウント方式: `--numstat`（v1 の Note #6 対応）

`git diff --stat` の summary 行パースではなく `git diff --numstat` を使用する。

**通常ファイル**:
```
1\t2\tsrc/foo.ts
0\t0\tsrc/bar.ts
```
`added` 列 + `deleted` 列を合計 → 変更行数。

**バイナリファイル**:
```
-\t-\tbinary.bin
```
両列が `-` → 行数にカウントしない（`-` を 0 扱い）。

**新規（untracked）ファイル**:
`git diff --numstat HEAD` は untracked ファイルを捕捉しない。そのため別途ハンドリング:
- `git status --short` の出力から `??` で始まるファイルを抽出
- 新規ファイルの行数を `wc -l` で取得（または `0` として扱い、「新規ファイルあり」注釈を表示）
- 代替案: `git ls-files --others --exclude-standard | xargs wc -l` で一括カウント

**実装方式**:
```ts
// tracked changes
const { stdout } = await pi.exec("git", ["diff", "--numstat", "HEAD"], { cwd });
let lines = 0;
for (const line of stdout.trim().split("\n").filter(Boolean)) {
  const [added, deleted] = line.split("\t");
  if (added !== "-") lines += parseInt(added, 10) || 0;
  if (deleted !== "-") lines += parseInt(deleted, 10) || 0;
}

// untracked files: count lines
const untrackedFiles = statusOutput.split("\n")
  .filter(l => l.startsWith("??"))
  .map(l => l.slice(3).trim());
if (untrackedFiles.length > 0) {
  // wc -l for untracked files
  const { stdout: wcOut } = await pi.exec("wc", ["-l", "--", ...untrackedFiles], { cwd });
  // parse wc output, sum up
}
```

### 5. 確認 UI の詳細設計

TUI オーバーレイで Yes/No ダイアログを表示。`ctx.ui.custom()` の overlay モードを使用。

表示内容:
```
┌─ Confirm Auto-Commit ──────────────────────────┐
│                                                 │
│  3 files changed (25 lines)                     │
│                                                 │
│  Files:                                         │
│    src/foo.ts                                   │
│    src/bar.ts                                   │
│    src/baz.ts (new)                             │
│                                                 │
│  Commit this change?                            │
│                                                 │
│    [ Yes (Enter) ]   [ No (Esc) ]               │
│                                                 │
└─────────────────────────────────────────────────┘
```

- ファイル一覧: 最大 **8** 件表示、超過時は `...and N more files` を末尾に追加
- 新規ファイルには `(new)` マーク
- 変更行数が 0 の場合（バイナリのみ等）: `N files changed (binary)` と表示
- キー操作:
  - `Enter` / `y` / `Y` → Yes（コミット続行）
  - `Esc` / `n` / `N` → No（コミットスキップ）
- **タイムアウト**: 120 秒。タイムアウト時は No 扱い（安全側）

## 変更ファイル

### 1. `src/utils/settings.ts` — 設定キーの追加

- `PiGitSettings` に以下を追加:
  ```ts
  auto_agg_commit_min_files?: number;
  auto_agg_commit_min_lines?: number;
  ```
- `DEFAULT_SETTINGS` に追加:
  ```ts
  auto_agg_commit_min_files: 2,
  auto_agg_commit_min_lines: 10,
  ```
- `VALID_KEYS_META` に追加:
  ```ts
  {
    key: "auto_agg_commit_min_files",
    type: "number",
    messageKey: "config.keyDesc.auto_agg_commit_min_files",
    valid_values: "non-negative integer (0 = disable)",
  },
  {
    key: "auto_agg_commit_min_lines",
    type: "number",
    messageKey: "config.keyDesc.auto_agg_commit_min_lines",
    valid_values: "non-negative integer (0 = disable)",
  },
  ```
- ゲッターを追加:
  ```ts
  export function getAutoAggCommitMinFiles(cwd?: string): number
  export function getAutoAggCommitMinLines(cwd?: string): number
  ```

### 2. `src/commands/config.ts` — 設定キーのバリデーション

- `ValidKey` 型に2キー追加
- `validateValue()` の switch に number パース処理を追加:
  ```ts
  case "auto_agg_commit_min_files":
  case "auto_agg_commit_min_lines":
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0) throw new Error(...);
    return num;
  ```

### 3. `src/i18n/messages.ts` — メッセージ追加

全キーを `en` / `ja` 両方に追加。

```ts
// ── config key descriptions
"config.keyDesc.auto_agg_commit_min_files":
  en: "Maximum changed files to trigger confirmation (0 = skip files check)"
  ja: "確認をトリガーする最大変更ファイル数（0 = ファイル数チェックなし）"
"config.keyDesc.auto_agg_commit_min_lines":
  en: "Maximum changed lines to trigger confirmation (0 = skip lines check)"
  ja: "確認をトリガーする最大変更行数（0 = 行数チェックなし）"

// ── confirm dialog
"autoCommit.confirmTitle":
  en: "Confirm Auto-Commit"
  ja: "自動コミットの確認"
"autoCommit.confirmBody":
  en: "{files} file(s) changed ({lines}). Commit this change?"
  ja: "{files}ファイル変更（{lines}）。この変更をコミットしますか？"
"autoCommit.confirmBodyLines":
  en: "{count} lines"
  ja: "{count}行"
"autoCommit.confirmBodyBinary":
  en: "binary"
  ja: "バイナリ"
"autoCommit.confirmYes":
  en: "Yes (Enter)"
  ja: "はい (Enter)"
"autoCommit.confirmNo":
  en: "No (Esc)"
  ja: "いいえ (Esc)"
"autoCommit.confirmMoreFiles":
  en: "...and {count} more files"
  ja: "...他{count}ファイル"
"autoCommit.confirmNewFile":
  en: "(new)"
  ja: "（新規）"
"autoCommit.confirmSkipped":
  en: "Auto-commit skipped"
  ja: "自動コミットをスキップしました"
"autoCommit.confirmTimedOut":
  en: "Auto-commit confirmation timed out — skipped"
  ja: "自動コミット確認がタイムアウトしました — スキップ"
```

### 4. `src/core/auto-commit.ts` — 確認フロー追加

`handleAutoCommit()` 内の変更:

```ts
// 変更前の既存コード:
//   changedFiles 取得
//   diff 取得
//   footerManager.setRunning(...)
//   commitMessage 生成
//   commit 実行

// 変更後:
//   changedFiles 取得（変更なし）
//   diff 取得（変更なし）
// === 新規: 変更行数カウント ===
//   changedLines = countChangedLines(pi, ctx, changedFiles)
// === 新規: 閾値チェック + 確認 ===
//   if (below threshold) {
//     confirmed = await showConfirmDialog(ctx, changedFiles, changedLines)
//     if (!confirmed) { notify + return }
//   }
//   footerManager.setRunning(...)   // ← 既存コード
//   commitMessage 生成
//   commit 実行
```

#### 追加ヘルパー関数

1. **`countChangedLines(pi, cwd, statusOutput)`**:
   - `git status --short` の出力（`statusOutput`）を**再利用**し、二重実行を避ける
   - `git diff --numstat HEAD -- <changedFiles>` で tracked changes の行数合計
     - `-- <files>` を付加し、`status --short` の結果と一貫性を保つ
     - 初回コミット（HEAD 不在）時は `git diff --numstat HEAD` がエラーになる → 空結果扱い
   - untracked ファイル（`??`）の行数: `wc -l` でカウント
     - `wc` が使えない環境では `fs.readFileSync` + `split("\n")` にフォールバック
   - バイナリファイル（`numstat` 出力が `-\t-`）は 0 扱い
   - 戻り値: `{ totalLines: number, untrackedFiles: string[], hasBinary: boolean }`

2. **`showConfirmDialog(ctx, changedFiles, untrackedFiles, totalLines, hasBinary, lang)`**:
   - `untrackedFiles` をパラメータで受け取り、UI 上で `(new)` / `（新規）` マークを付与
   - `ctx.ui.custom()` の overlay モードで Yes/No ダイアログ表示
   - 120 秒タイムアウト付き（`dispose()` で `clearTimeout()`）
   - 戻り値: `Promise<boolean>`（true=コミット続行, false=スキップ）
   - `t()` の数値パラメータは事前に `String()` で変換（`t()` は `Record<string, string>` のみ受け付ける）

### 5. 新規ファイル: `src/core/auto-commit-confirm.ts`

確認ダイアログの TUI コンポーネントを実装する新規ファイル。

パターン: `ctx.ui.custom()` overlay モード + シンプルな Yes/No 選択。
TUI ドキュメントの Pattern 1 (Selection Dialog) を参考にした Yes/No ダイアログ。

コンポーネント構造:
```
Container (render() 内で罫線を自前描画。DynamicBorder は pi-tui に存在しないため不使用)
  ├─ Text (title: "── Confirm Auto-Commit ──")
  ├─ Spacer
  ├─ Text (body: file count + line count)
  ├─ Spacer
  ├─ Text ("Files:" label)
  ├─ Text[] (file list, max 8, clipped with truncateToWidth)
  ├─ Text (more files indicator, if needed)
  ├─ Spacer
  ├─ Text ("Commit this change?")
  ├─ Text (yes/no hints)
```

キー操作:
- `Enter`, `y` → done(true)
- `Esc`, `n` → done(false)
  - `Ctrl+C` は TUI コンポーネントの `handleInput` まで到達しないため不使用（SIGINT がプロセスレベルで捕捉される）
- その他 → 無視

タイムアウト: `setTimeout(120000, () => done(false))`。
`dispose()` で `clearTimeout()` を呼び、早期決定時のタイマーリークを防止。

### 6. `src/index.ts` — 変更不要

## データフロー図

```
agent_end event
    │
    ▼
handleAutoCommit()
    │
    ├─ footerManager.isRunning()? → return (early exit)
    ├─ footerManager.refresh()     (update footer status)
    ├─ autoCommitEnabled? → return
    ├─ isGitRepository? → return
    ├─ hasChanges? → return
    ├─ [git status --short] → changedFiles
    ├─ [git diff HEAD -- <files>] → diff
    │
    ├─ NEW: countChangedLines()
    │   ├─ [git diff --numstat HEAD] → tracked lines
    │   ├─ untracked files? → [wc -l] → untracked lines
    │   └─ return { totalLines, untrackedFiles, hasBinary }
    │
    ├─ NEW: threshold check
    │   ├─ getAutoAggCommitMinFiles(), getAutoAggCommitMinLines()
    │   ├─ filesBelow || linesBelow ?
    │   │   ├─ showConfirmDialog() → confirmed?
    │   │   │   ├─ false → notify("skipped"), return
    │   │   │   └─ true → continue
    │   │   └─ continue (skip dialog for large changes)
    │
    ├─ footerManager.setRunning("auto-commit", "generateMessage")
    ├─ generateAutoCommitMessage()
    ├─ footerManager.setPhase("commit")
    ├─ stageFiles()
    ├─ [git commit -m ...]
    └─ notify("commit created" | "commit failed")
```

## レビュー観点（再レビュー用）

1. 閾値ロジック: 次元独立 OR 条件に修正されているか
2. footerManager のシーケンス: 確認ダイアログが setRunning の前にあるか
3. 後方互換性: オプトアウト方式の是非（デフォルト 2/10）
4. 変更行数カウント: `--numstat` + untracked wc -l 方式の堅牢性
5. 新規ファイル / バイナリファイルのエッジケース対応
6. 確認 UI: タイムアウト、キー操作、情報表示の十分性
7. i18n: en/ja 全メッセージの完全性
8. コード分割: auto-commit-confirm.ts への分離の適切さ
