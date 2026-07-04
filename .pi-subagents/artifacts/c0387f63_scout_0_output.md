# pi-git ソースアーキテクチャ調査：/codebase-design 観点

## 調査対象

`/Users/335g/dev/other/pi-git/src/*.ts`（テスト除く）全 15 ファイルを読了。既存テスト 5 ファイルも読了し、カバレッジを確認。

## 1. 主要モジュールとインターフェース

| ファイル | 責務 | 主要インターフェース |
|---|---|---|
| `src/index.ts` | pi 拡張のエントリポイント。`/git-commit`, `/git-review`, `/git-status` コマンドと `turn_end`/`agent_end` イベント登録 | `default function (pi: ExtensionAPI)` |
| `src/pipeline.ts` | **commit pipeline** の本体。stage → file selection → message generation → commit の一連を実行 | `runCommitPipeline(pi, ctx, config, options)`、`CommitPipelineHooks`、`PipelineContext` |
| `src/git-operations.ts` | Git 操作のラッパー。`pi.exec` 経由で git コマンドを実行 | `GitOperations` クラス |
| `src/llm-commit.ts` | LLM による commit message 生成。失敗時は `commit-message.ts` のヒューリスティックに fallback | `generateCommitMessageWithLLM(pi, ctx, ...)` |
| `src/commit-message.ts` | ヒューリスティックな Conventional Commits メッセージ生成 | `generateCommitMessage(nameStatus, stat, diff, config)`、`CommitMessage` |
| `src/commit-organizer.ts` | `turn_end` 戦略の **commit reorganiser**。WIP checkpoint commit をソフトリセットし、LLM で論理的な commit に再分割 | `organizeWipCommits(pi, ctx, config, event)`、`CommitGroup`、`parseCommitGroups(text)` |
| `src/file-selector.ts` | **File selection** UI（TUI マルチセレクト + diff preview） | `selectFiles(ctx, nameStatusRaw, options)` |
| `src/confirmation.ts` | 生成メッセージの確認・編集 UI | `confirmCommitMessage(ctx, message, widgetId, dryRun)` |
| `src/reviewer.ts` | **Crit review** 統合。crit CLI を起動し、未解決コメントを処理 | `runReviewFlow(pi, ctx, input)`、`checkCritAvailable(pi)` |
| `src/status-viewer.ts` | `/git-status` のスクロール可能 TUI ビューアー | `showStatusViewer(ctx, statusOutput)` |
| `src/config.ts` | `.pi/pi-git.json` 読み込みと正規化 | `loadConfig(cwd)`、`resolveCommitEveryTurnConfig(value)`、`PiGitConfig` |
| `src/args.ts` | `/git-commit` `/git-review` の引数パース | `parseCommitArgs(raw)` |
| `src/commit-decider.ts` | **auto-commit** の判定。どの tool 呼び出しが checkpoint を発生させるか判定 | `shouldCreateWipCommit(toolResults)` |
| `src/git-parser.ts` | `git diff --cached --name-status` のパース | `parseNameStatus(raw)`、`ParsedNameStatus` |
| `src/commit-types.ts` | Conventional Commits 型の定義 | `COMMIT_TYPES`、`CommitType` |

## 2. 浅いモジュール・シームを越えた複雑性の漏出

### `src/pipeline.ts` — 浅く広いコーディネーター

- 1 ファイルに「git 検証、コンフリクト検出、stage、file selection、unstage、diff 収集、hook 呼び出し、LLM/fallback メッセージ生成、確認、commit、footer 更新、エラー時 cleanup」が詰まっている。
- `PipelineContext` は「pi API・selectedFiles・fileDetails・staged diff/stat/name-status」をすべて乗せ、hook にそのまま渡すため、hook 実装者が pipeline の内部状態を熟知する必要がある。
- UI 通知が pipeline 内部に埋め込まれている（例: `ctx.ui.notify("Generating commit message via LLM...", "info")`、lines 305, 313）。
- エラーハンドリングで `git.unstageAll()` と footer 更新を兼任し、失敗時に再 throw。責務が pipeline と git/UI の両方にまたがっている。

### `src/file-selector.ts` — 巨大な TUI ロジックと選択ロジックの混在

- 約 430 行。`selectFiles` のインターフェースは小さいが、実装がほぼ TUI レンダリング（`renderDiffOverlay`、`estimateVisibleHeight`、キー入力処理）。
- 「選択」というドメイン概念と「描画」というプレゼンテーション概念が分離されていない。
- `FileDetail` / `FileItem` / `FileSelectorOptions` は export されているが、`selectFiles` 内部で `ctx.ui.custom` のクロージャーにすべて閉じ込められており、テストで挙動を差し替えるシームがない。

### `src/commit-message.ts` — 言語分岐が実装の大部分を占める

- `extractSubject` 内で日本語/英語の 2 つの巨大 `switch(type)` が並列（lines 112–241）。
- 型ごとの文言ルールが密に詰まっており、interface（`generateCommitMessage`）より実装が支配的。新しい言語や新しい type を追加する際、同一関数内の 2 箇所を同時に修正する必要がある。
- `determineType` も diff 文字列のキーワードマッチングルールが羅列されており、本質的には巨大な条件テーブル。

### `src/commit-organizer.ts` — LLM プロンプト構築がモジュールに食い込んでいる

- `buildOrganizerSystemPrompt` / `buildOrganizerUserContent` が 80 行以上の文字列組み立てを担う。
- このプロンプト構築ロジックは `llm-commit.ts` のプロンプト構築と重複（言語設定、noBody 分岐、type テーブル）。ドメイン知識（`COMMIT_TYPES`）は共通化されているが、プロンプト組み立ての詳細は各モジュールで重複。

### `src/reviewer.ts` — crit 出力解析が深く浅い

- `parseCritOutput` は stdout から JSON を探索・正規化する複雑な処理だが、テストは存在。一方、crit CLI そのものへのアダプタ境界（`runCritReview`）は `pi.exec` と tempfile 操作が直結しており、テストは tempfile 読み取りに到達している。

## 3. 複数モジュールを行き来しないと理解できない箇所

### commit pipeline の全体像

`/git-commit` 1 つの動作を理解するには、最低でも以下を同時に読む必要がある：

1. `src/index.ts` — コマンド登録と引数パース
2. `src/pipeline.ts` — 全体の流れと hook
3. `src/git-operations.ts` — 各 git コマンドの意味
4. `src/file-selector.ts` — ファイル選択の UX と返り値の扱い
5. `src/llm-commit.ts` または `src/commit-message.ts` — メッセージ生成
6. `src/confirmation.ts` — 確認ダイアログ

特に `/git-review` はさらに `src/reviewer.ts` も必要。locality が低い。

### checkpoint → reorganiser の流れ

`turn_end` 戦略を理解するには：

1. `src/index.ts` `turn_end` ハンドラ
2. `src/commit-decider.ts` で checkpoint 判定
3. `src/pipeline.ts` で WIP commit 作成
4. `src/index.ts` `agent_end` ハンドラ
5. `src/commit-organizer.ts` で reset-soft + 再分割
6. `src/llm-commit.ts` が fallback で使われる

分散した 6 ファイルに状態遷移が跨る。

### `config.ts` のユーティリティ関数が全域に広がる

- `isJapanese(config)` / `hasNoBody(config)` は `commit-message.ts`、`llm-commit.ts`、`commit-organizer.ts` など複数ファイルに import されている。
- 言語判定や body 有無は小さな判定だが、各ファイルで個別に呼び出されるため、一貫性を確認するには全 import 元を追う必要がある。

## 4. テストが不足している、またはインターフェースを越えてリーチする必要がある箇所

### テスト未カバーのファイル（主要ビジネスロジック中心）

| ファイル | 未テストの理由/リスク |
|---|---|
| `src/pipeline.ts` | **commit pipeline** 本体がまるごと未テスト。git 操作、UI、LLM が絡むため、単体テストが難しい構造になっている。 |
| `src/git-operations.ts` | `GitOperations` 全メソッド未テスト。テストするには `pi.exec` をモックするか、実際の git リポジトリを用意する必要がある。 |
| `src/file-selector.ts` | TUI レンダリングとキー入力が `ctx.ui.custom` に閉じ込められており、テストが書きにくい。 |
| `src/confirmation.ts` | UI 分岐（TUI / non-TUI / dryRun）が未テスト。 |
| `src/status-viewer.ts` | TUI ビューアーが未テスト。 |
| `src/llm-commit.ts` | LLM 呼び出し + fallback ロジックが未テスト。`@earendil-works/pi-ai/compat` を dynamic import している。 |
| `src/commit-message.ts` | ヒューリスティック生成が未テスト。言語・type 分岐の網羅が難しい。 |
| `src/index.ts` | エントリポイント全体が未テスト。 |

### インターフェースを越えてリーチしている既存テスト

- `src/reviewer.test.ts` は `runReviewFlow` をテストする際、`createMockPi` で `pi.exec` を模倣し、tmpdir に書き出された crit 用 Markdown ファイルを `readFileSync` で読み取っている（`buildReviewDocument` の検証）。
- これは内部実装（tempfile パスとフォーマット）に依存しており、crit 用ドキュメント構築のインターフェースが分離されていないため、テストが実装詳細に結びついている。

## 5. 密結合の具体例

### `GitOperations` が至る所でインライン構築される

```ts
// src/index.ts
async function updateFooterStatus(ctx: ExtensionContext) {
  const git = new GitOperations(pi);  // line 39
}

pi.registerCommand("git-commit", { handler: async (args, ctx) => {
  // ...
  await runCommitPipeline(pi, ctx, config, { ... });
}});

pi.on("turn_end", async (event, ctx) => {
  const git = new GitOperations(pi);  // line 137
});
```

```ts
// src/pipeline.ts
export async function runCommitPipeline(...) {
  const git = new GitOperations(pi);  // line 145
}
```

```ts
// src/commit-organizer.ts
export async function organizeWipCommits(...) {
  const git = new GitOperations(pi);  // line 44
}

async function proposeCommitGroups(...) {
  const git = new GitOperations(pi);  // line 83
}

async function updateFooterStatus(...) {
  const git = new GitOperations(pi);  // line 299
}
```

- 結果として `ExtensionAPI` 型が各所に引き回され、ビジネスロジックが pi の実行環境に強く結合。

### `ExtensionAPI` / `ExtensionContext` がビジネスロジックに_threaded_される

- `runCommitPipeline(pi, ctx, ...)`、`generateCommitMessageWithLLM(pi, ctx, ...)`、`organizeWipCommits(pi, ctx, ...)`、`runReviewFlow(pi, ctx, ...)` など、ほぼすべての非純粋関数が `pi` と `ctx` を先頭に持つ。
- `pi.exec` は git 操作と crit 操作の両方に使われるが、これらは異なるアダプタ境界（git 実行環境 vs crit CLI 呼び出し）であり、同じ `ExtensionAPI` を共有している。

### UI 呼び出しがロジックに混在

- `src/pipeline.ts` 内で `ctx.ui.notify(...)` が 8 箇所以上出現（例: lines 181, 219, 236, 264, 305, 313, 325, 332）。
- `src/commit-organizer.ts` 内で `ctx.ui.notify(...)` が 2 箇所（lines 68, 77）。
- `src/reviewer.ts` 内で `ctx.ui.notify(...)` / `ctx.ui.select(...)` が複数箇所。
- これにより、ビジネスロジックの単体テストは UI モックを inject する必要があり、テストしにくさにつながっている。

### `llm-commit.ts` が `ctx.model` と pi-ai dynamic import に依存

```ts
// src/llm-commit.ts
const { completeSimple } = await import("@earendil-works/pi-ai/compat");
const result = await completeSimple(ctx.model, { ... });
```

- これは commit message 生成というドメイン機能が、pi 専用の AI 呼び出し方式に直接結合している。adapter や seam がない。

### `index.ts` が各種ロジックを直接呼び出し・結合

- `index.ts` はコマンド登録にとどまらず、`loadConfig`、各種エラーハンドリング、`pi.sendUserMessage`（reviewer からのコメント転送）、footer 更新まで行っている。
- 特に `/git-review` のエラーハンドラで `ReviewSendToAgentError` をキャッチして `pi.sendUserMessage` で LLM に転送する処理（lines 100–114）は、reviewer と main agent 間の制御フローが index.ts に固まっている。

## 6. その他の設計上の注意点

- `PipelineContext` の `pi` フィールドは「crit review などで必要」というコメントだが、実際には `onBeforeGenerate` hook で reviewer 側が使うため、pipeline と reviewer の間で `ExtensionAPI` が素通しされている。
- `commit-organizer.ts` の `fallbackSingleCommit` は `llm-commit.ts` の `generateCommitMessageWithLLM` を呼ぶが、これにより **commit pipeline** 外からも LLM メッセージ生成が呼ばれる。reorganiser と pipeline の責務境界が曖昧。
- `args.ts` は純粋関数で浅く明快。`git-parser.ts`、`commit-types.ts`、`commit-decider.ts` も比較的小さく、/codebase-design 的には好ましい。

## Start Here

次の作業をする場合、まず `src/pipeline.ts` を開くこと。commit pipeline が全体の結合点であり、ここで GitOperations の注入、UI 通知の分離、hook インターフェースの見直しを検討するのが最も影響が大きい。