# auto_agg_commit への git diff 追加 & analysis_model 改善 実装プラン

## 背景

1. `auto_agg_commit` は会話履歴のみからコミットメッセージを生成する。git diff を AI に送っていないため、弱いモデルでは会話の意図を読み取れず `chore: apply changes` のような抽象的なメッセージになりやすい。
2. `analysis_model` に `"gpt-5.4"` のような `/` 区切りなしのモデル名を指定しても、`resolveModel()` がサイレントにスキップし、セッションモデルにフォールバックする。

---

## 実装項目

### A. `auto_agg_commit` に git diff を送信する

#### A-1. `auto-commit.ts`: git diff の取得

`handleAutoCommit()` 内で、`git status --short` の後に `git diff HEAD -- <files>` で差分を取得する。

```typescript
// 追加: 変更ファイルの diff を取得
// git diff HEAD は staged + unstaged の全変更を表示する（git diff 単体は unstaged のみ）
const { stdout: diffOutput, code: diffCode } = await pi.exec(
  "git",
  ["diff", "HEAD", "--", ...changedFiles],
  { cwd: ctx.cwd },
);
const diff = diffCode === 0 ? diffOutput : "";
```

- `git diff HEAD` は staged + unstaged の全変更をカバーする（`git diff` 単体では staged 変更を見逃す）
- 新規ファイル（untracked）は diff に出ないが、ファイル名はすでにプロンプトに含まれている
- exit code をチェックし、失敗時は空文字列でフォールバック
- 全ファイルが untracked で diff が空の場合は、フォールバックテキストをプロンプトに含める（後述）

`generateAutoCommitMessage()` のシグネチャ変更:
```typescript
export async function generateAutoCommitMessage(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  messages: SimpleMessage[],
  changedFiles: string[],
  diff: string,  // 追加
): Promise<string>
```

#### A-2. `auto-commit-message.ts`: プロンプトへの diff 組み込み

**バジェット再配分:**

| セクション | 変更前 | 変更後 |
|---|---|---|
| User messages | 2000 | 1500 |
| Assistant messages | 800 | 600 |
| Files | 800 | 500 |
| **Git diff (新規)** | - | **5000** |
| 合計 | ~3600 | ~7600 |

**`buildPrompt()` のシグネチャ変更:**

```typescript
function buildPrompt(
  userMessages: string[],
  assistantMessages: string[],
  changedFiles: string[],
  diff: string,        // 追加
  lang: string,
): string
```

**diff の処理パイプライン（buildPrompt 内）:**

```typescript
const MAX_DIFF_CHARS = 5000;

let diffSection: string;
if (diff && diff.trim()) {
  const cleaned = stripDiffNoise(diff);   // 1. ノイズ除去（index lines, binary payload）
  diffSection = truncate(cleaned, MAX_DIFF_CHARS);  // 2. トランケート
} else {
  diffSection = t(lang, "autoCommitMsg.noDiffAvailable");  // 3. フォールバック
}
```

**`stripDiffNoise()` の共通化:**
- `diff-analyzer.ts` の `stripDiffNoise()` に `export` を付与し、`auto-commit-message.ts` から import する
- 新ファイルの作成は不要（1関数のため過剰）

#### A-3. `i18n/messages.ts`: プロンプト文言の更新

**`autoCommitMsg.systemPrompt` (en):**
```
"You are a commit message generator. From the following information, understand
what the user requested and what changes were made as a result, then generate a
single Conventional Commit message.

The GIT DIFF is the most reliable source of what actually changed. Use it as the
primary driver for the commit message. The user's request provides intent, and
the assistant's response and changed files list are supplementary.

Rules:
- Choose type from: feat, fix, docs, style, refactor, test, chore
- Write the subject in English
- Keep subject under 50 characters
- Use imperative mood
- Include scope only if clearly inferable from the diff

Return ONLY the commit message string. No explanations or code fences."
```

**`autoCommitMsg.buildPrompt` (en):**
```
{examples}

=== USER REQUEST (primary) ===
{userSection}

=== ASSISTANT RESPONSE (reference) ===
{assistantSection}

=== CHANGED FILES ===
{filesSection}

=== GIT DIFF ===
{diffSection}

Based on the GIT DIFF and USER REQUEST above, generate a single Conventional
Commit message in English that best captures the intent of the changes.
```

日本語版も同様に更新。

---

### B. `analysis_model` 解決の堅牢化

#### B-1. `/` なしモデル名のフォールバック検索 (`resolve-model.ts`)

現在:
```typescript
const slashIndex = configuredModel.indexOf("/");
if (slashIndex > 0) {
  // provider/model-id 形式のみ処理
}
// slashIndex <= 0 の場合は何もせずフォールバック
```

変更後:
```typescript
let found: Model<Api> | undefined;

const slashIndex = configuredModel.indexOf("/");
if (slashIndex > 0) {
  // 既存: provider/model-id 形式
  const provider = configuredModel.substring(0, slashIndex);
  const modelId = configuredModel.substring(slashIndex + 1);
  found = ctx.modelRegistry.find(provider, modelId);
} else {
  // 追加: "/" なしの場合、全プロバイダーから modelId に一致するものを検索
  const available = ctx.modelRegistry.getAvailable();
  found = available.find((m) => m.id === configuredModel);
}

if (found) {
  console.log(`[pi-git] Using analysis_model: ${found.provider}/${found.id}`);
  return found;
}

// 設定されているが見つからなかった場合、警告を出力
if (configuredModel) {
  console.warn(
    `[pi-git] Configured analysis_model "${configuredModel}" not found. ` +
    `Falling back to session model.`
  );
}
```

注意: `/` なしの場合は `m.id === configuredModel` のみで検索する。`${m.provider}/${m.id}` との比較は `configuredModel` に `/` が含まれないため常に false であり不要。

#### B-2. デバッグ用ログ出力

上記 B-1 に統合。解決成功時は `console.log`、設定されているが見つからない場合は `console.warn` を出力する。`ctx.ui.notify` は使用しない（auto-commit のバックグラウンド実行時にノイズになるため）。

---

## `stripDiffNoise` のエクスポート対応

`src/core/diff-analyzer.ts` の `stripDiffNoise` 関数（現在はモジュール内関数）に `export` を追加する。新ファイルの作成は不要。

```typescript
// Before:
function stripDiffNoise(diff: string): string {

// After:
export function stripDiffNoise(diff: string): string {
```

`src/core/auto-commit-message.ts` での import:
```typescript
import { stripDiffNoise } from "./diff-analyzer.js";
```

---

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `src/core/auto-commit.ts` | `git diff` 取得と `generateAutoCommitMessage` への引き渡し |
| `src/core/auto-commit-message.ts` | シグネチャ変更、プロンプトに diff セクション追加、バジェット調整 |
| `src/core/resolve-model.ts` | `/` なしモデル名のフォールバック検索、デバッグログ追加 |
| `src/i18n/messages.ts` | `autoCommitMsg.systemPrompt`, `autoCommitMsg.buildPrompt` (en/ja) 更新、`autoCommitMsg.noDiffAvailable` 追加、`config.keyDesc.analysis_model` の説明更新 |

---

## レビュー指摘反映済み項目

以下の項目はレビューで指摘され、プランに反映済み:

| # | 指摘 | 重大度 | 対応 |
|---|---|---|---|
| 1 | `stripDiffNoise` が未エクスポート | 🔴 Blocker | `export` を追加して `auto-commit-message.ts` から import |
| 2 | `git diff` が staged 変更を見逃す | 🔴 Major | `git diff HEAD` に変更 |
| 3 | diff トランケート機構の欠落 | 🔴 Major | `MAX_DIFF_CHARS=5000` と `truncate()` 適用を明記 |
| 4 | 空 diff 時の `{diffSection}` 未定義 | 🟡 Major | `autoCommitMsg.noDiffAvailable` フォールバックを追加 |
| 5 | `analysis_model` 未発見時の警告なし | 🟡 Major | `console.warn` を追加 |
| 6 | `git diff` の exit code 未チェック | 🟢 Minor | `diffCode === 0` チェックを追加 |
| 7 | `/` なし検索の冗長な条件 | 🟢 Minor | `m.id === configuredModel` のみに簡略化 |
| 8 | `config.keyDesc.analysis_model` の説明が古い | 🟢 Minor | `model-id or provider/model-id` に更新 |

## リスク・検討事項

1. **diff が巨大な場合**: `stripDiffNoise` → `truncate(5000)` の順で処理。バイナリファイルのペイロードはノイズ除去で取り除かれる
2. **untracked ファイルのみの場合**: diff が空文字列になる。`buildPrompt` 内で `autoCommitMsg.noDiffAvailable` のフォールバックテキストを使用
3. **プロンプト長の増加**: ~3600 → ~7600 文字に増えるが、ほとんどのモデルで問題ない範囲
4. **`auto_agg_commit` の応答時間**: diff 取得は `git diff HEAD` の同期的な呼び出しで、通常 1 秒未満。AI 呼び出しのレイテンシへの影響は軽微
5. **rename ファイルのパス解決（既存バグ・別対応）**: `git status --short` の `R  old -> new` 形式は `changedFiles` で `"old -> new"` という不正なパスになる。本プランでは修正しないが、`git diff HEAD` はファイル名が不正でも全ファイルの diff を返すため実害は限定的
