# TurnLog プロンプト永続化拡張 実装プラン

## 1. 背景と目的

### 1.1 現状

- `TurnLog` は各 `agent_end` で `userMessage` / `assistantExcerpt` / `filesChanged` を記録している
- `/git-agg-commit` 実行時、これらを原料に **都度プロンプトを再構成** して AI に送信している
- 実際に AI コード生成に使われた「システムプロンプト」と「生のユーザープロンプト」は保持されていない

### 1.2 目的

- 各ターンで AI コード生成に使用された **システムプロンプト** と **生のユーザープロンプト** を TurnLog に保持する
- `/git-agg-commit` 実行時、これらの保存済みプロンプトと現在の diff を組み合わせて、より意図に忠実な Hunk 分割・コミットメッセージ生成を行う

---

## 2. 目標と非目標

### 2.1 目標（In Scope）

- `TurnEntry` スキーマに `systemPrompt` / `rawUserPrompt` を追加
- `agent_end` ハンドラからこれらのプロンプトを取得・保存する
- 保存済みプロンプトを `/git-agg-commit` の AI 分析に利用する
- 旧形式 `turn-log.json`（version 1）との後方互換性を維持
- 単体テスト・統合テストの追加

### 2.2 非目標（Out of Scope）

- pi-coding-agent 本体のイベント構造変更（利用可能なフィールド内で対応）
- プロンプトの暗号化・圧縮
- 複数セッション間でのプロンプト同期（引き続きローカルファイル永続化）
- UI 表示の大幅変更（footer / review は既存のまま）

---

## 3. 用語定義

| 用語 | 定義 |
|---|---|
| システムプロンプト | AI アシスタントに対する継続的な指示（セッション単位またはリポジトリ単位） |
| 生のユーザープロンプト | ユーザーがそのターンで AI に送信した実際の入力。`stripConversationalMarkers` 等の加工前の全文 |
| 保存済みプロンプト | TurnLog に永続化された上記プロンプト群 |
| 再構成プロンプト | 現状のように `messages.ts` + `turnLogText` + `diff` から動的に作るプロンプト |

---

## 4. 設計判断（レビュー後に確定）

| 未決定事項 | 決定 |
|---|---|
| 保存した system prompt を分析 AI の system prompt に置き換えるか | **置き換えない**。分析用 system prompt は固定の `diffAnalyzer.intentSystemPrompt` を維持し、保存 system prompt は user prompt 内の `=== ORIGINAL PROMPTS ===` セクションに含める |
| `rawUserPrompt` の定義 | 最新 user メッセージの **加工前全文**。既存 `userMessage` は加工済み要約版として維持 |
| プロンプトセクションの切り詰め優先順位 | ターン単位で統合。最も古いターンから drop。同一ターン内では `assistantExcerpt` → `userMessage` → `rawUserPrompt` → `systemPrompt` の順で切り詰めを検討するが、実装では単純に最新ターン優先でブロックごと drop |
| `formatForPrompt()` 内埋め込み or `buildIntentPrompt()` 引数追加 | **`formatForPrompt()` 内で統合**。`buildIntentPrompt()` のシグネチャは変更しない |

---

## 5. 実装詳細

### 5.1 スキーマ変更

#### `src/types.ts`

`AgentEndEvent` は pi-coding-agent ランタイムの型と一致させる（`messages` のみ）。
プロンプトは `TurnLog.append()` の個別引数として渡す。

```typescript
export interface AgentEndEvent {
  messages?: Array<{
    role: string;
    content: unknown;
  }>;
}
```

#### `src/core/turn-log.ts`

`TurnEntry` にプロンプトフィールドを追加。

```typescript
export interface TurnEntry {
  index: number;
  userMessage: string;
  assistantExcerpt: string;
  filesChanged: string[];
  /** そのターンで有効だったシステムプロンプト */
  systemPrompt?: string;
  /** ユーザーが送信した生のプロンプト（加工前） */
  rawUserPrompt?: string;
}
```

`PersistedTurnLog` の version を `2` に上げる。`loadFromDisk()` の version 判定を `version !== 1 && version !== 2` に変更する。

### 5.2 プロンプト取得

#### Phase 0 調査結果

`agent_end` イベントには `systemPrompt` / `rawUserPrompt` は **含まれない**。
代わりに `before_agent_start` イベントに `prompt`（テンプレート展開後の生の user prompt）と `systemPrompt` が含まれているため、これを FIFO キューに保存し、次の `agent_end` と紐付ける。

#### `src/index.ts` の変更

`before_agent_start` ハンドラを追加し、プロンプトをキューに保存する。

```typescript
const pendingPrompts: Array<{ prompt: string; systemPrompt: string }> = [];

pi.on("before_agent_start", (event) => {
  pendingPrompts.push({
    prompt: event.prompt,
    systemPrompt: event.systemPrompt,
  });
});
```

`agent_end` ハンドラではキュー先頭を取り出して `turnLog.append()` に渡す。

```typescript
pi.on("agent_end", async (event, ctx) => {
  if (!ctx.hasUI) return;
  // ... 既存の changedFiles 取得処理 ...

  const prompts = pendingPrompts.shift();
  turnLog.append(
    event as AgentEndEvent,
    changedFiles,
    prompts?.systemPrompt,
    prompts?.prompt,
  );

  // ... 残りの既存処理 ...
});
```

#### フォールバック

- `agent_end` 時にキューが空の場合: `systemPrompt` / `rawUserPrompt` は `undefined`
- `TurnLog.append()` 内で `rawUserPrompt` 引数が未定義なら、最新 user メッセージ原文を `rawUserPrompt` として使用
- `systemPrompt` 引数が未定義なら `undefined` のまま（分析時にプロンプトセクションを省略）

### 5.3 TurnLog.append の実装変更

```typescript
append(
  event: AgentEndEvent,
  changedFiles: string[],
  systemPrompt?: string,
  rawUserPrompt?: string,
): void {
  this.turnIndex++;

  const messages = (event.messages ?? []) as SimpleMessage[];
  const userMessages = collectMessagesByRole(messages, "user");
  const userMsg = userMessages[0] ?? "";
  const assistantMessages = collectMessagesByRole(messages, "assistant");
  const assistantMsg = assistantMessages[0] ?? "";

  // rawUserPrompt: 呼び出し側が提供しない場合は user メッセージ原文をフォールバック
  const finalRawUserPrompt = rawUserPrompt ?? userMsg;

  this.entries.push({
    index: this.turnIndex,
    userMessage: tailTruncate(stripConversationalMarkers(userMsg), 500),
    assistantExcerpt: stripConversationalMarkers(assistantMsg).slice(0, 500),
    filesChanged: changedFiles.slice(0, 20),
    systemPrompt: systemPrompt
      ? tailTruncate(systemPrompt, 1000)
      : undefined,
    rawUserPrompt: finalRawUserPrompt
      ? tailTruncate(finalRawUserPrompt, 1500)
      : undefined,
  });

  if (this.entries.length > TurnLog.MAX_ENTRIES) {
    this.entries = this.entries.slice(-TurnLog.MAX_ENTRIES);
  }

  this.saveToDisk();
}
```

### 5.4 プロンプトの永続化フォーマット

`PersistedTurnLog`:

```typescript
interface PersistedTurnLog {
  version: number; // 2
  turnIndex: number;
  warnNotified: boolean;
  entries: TurnEntry[];
}
```

`loadFromDisk()` で version 1/2 の両方を許容。version 1 エントリは `systemPrompt` / `rawUserPrompt` が `undefined` として読み込まれる。`saveToDisk()` は `version: 2` を書き出す。

### 5.5 `/git-agg-commit` 側の利用

#### `src/core/turn-log.ts` の `formatForPrompt()` 拡張

ターンごとにプロンプト情報を統合して出力する。

```typescript
formatForPrompt(): string {
  if (this.entries.length === 0) return "";

  const seenFiles = new Set<string>();
  const increments: Array<{ newFiles: string[]; continuedFiles: string[] }> = [];

  for (const e of this.entries) {
    const newFiles: string[] = [];
    const continuedFiles: string[] = [];
    for (const f of e.filesChanged) {
      if (seenFiles.has(f)) continuedFiles.push(f);
      else { newFiles.push(f); seenFiles.add(f); }
    }
    increments.push({ newFiles, continuedFiles });
  }

  const lines: string[] = [];
  let totalChars = 0;
  const reversed = [...this.entries].reverse();
  const reversedInc = [...increments].reverse();

  for (let i = 0; i < reversed.length; i++) {
    const e = reversed[i];
    const inc = reversedInc[i];

    const parts: string[] = [
      `### Turn ${e.index} ━━━━━━━━━━━━━━━━━━━━━━`,
      `【依頼】${e.userMessage}`,
      `【応答】${e.assistantExcerpt}`,
    ];

    if (e.systemPrompt || e.rawUserPrompt) {
      const promptParts: string[] = [];
      if (e.systemPrompt) promptParts.push(`System: ${e.systemPrompt}`);
      if (e.rawUserPrompt) promptParts.push(`User: ${e.rawUserPrompt}`);
      parts.push(`【プロンプト】${promptParts.join(" | ")}`);
    }

    const fileParts: string[] = [];
    if (inc.newFiles.length > 0) fileParts.push(`新規: ${inc.newFiles.join(", ")}`);
    if (inc.continuedFiles.length > 0) fileParts.push(`継続: ${inc.continuedFiles.join(", ")}`);
    if (fileParts.length > 0) {
      parts.push(`【ファイル】${fileParts.join(" | ")}`);
    } else if (e.filesChanged.length > 0) {
      parts.push(`【ファイル】${e.filesChanged.join(", ")}`);
    }

    const block = parts.join("\n");
    if (totalChars + block.length > TurnLog.MAX_CHARS) break;
    lines.push(block);
    totalChars += block.length + 1;
  }

  return lines.join("\n\n");
}
```

#### `src/core/diff-analyzer.ts`

`analyzeDiffIntent()` は `turnLogText` 1 本を受け取るため、`formatForPrompt()` 内でプロンプトセクションが統合されていれば追加変更は不要。

ただし、user prompt に「保存プロンプトセクションがあること」を AI に示すために、`diffAnalyzer.intentBuildPrompt` のテンプレートを微修正する。

```
=== CONVERSATION HISTORY (SUPPLEMENTARY — includes original system/user prompts when available) ===
{turnLogText}
```

#### `src/core/batch-committer.ts`

`analyzeDiffIntent()` 呼び出し前に、保存プロンプトの使用状況を診断カウンターに記録する。

```typescript
const entries = turnLog.getEntries();
let hasSystemPrompt = false;
let hasUserPrompt = false;
for (const e of entries) {
  if (e.systemPrompt) hasSystemPrompt = true;
  if (e.rawUserPrompt) hasUserPrompt = true;
}
if (hasSystemPrompt) diagIncr("intentPath_storedSystemPromptUsed");
if (hasUserPrompt) diagIncr("intentPath_storedUserPromptUsed");
if (!hasSystemPrompt && !hasUserPrompt) diagIncr("intentPath_storedPromptsMissing");
```

### 5.6 サイズ・予算制御

| 項目 | 現状 | 変更後 |
|---|---|---|
| エントリあたり userMessage | 500 chars | 500 chars |
| エントリあたり assistantExcerpt | 500 chars | 500 chars |
| エントリあたり systemPrompt | なし | 最大 1,000 chars（truncated） |
| エントリあたり rawUserPrompt | なし | 最大 1,500 chars（truncated） |
| MAX_ENTRIES | 20 | 20（維持） |
| MAX_CHARS | 8,000 | **12,000** |
| MAX_INTENT_PROMPT_CHARS | 20,000 | **24,000** |
| MAX_OUTPUT_TOKENS_INTENT | 4,096 | 維持 |

### 5.7 診断カウンター追加

`src/utils/diagnostics.ts` に以下を追加する。

```typescript
/** Stored system prompt was available in TurnLog */
intentPath_storedSystemPromptUsed: number;
/** Stored raw user prompt was available in TurnLog */
intentPath_storedUserPromptUsed: number;
/** No stored prompts were available in TurnLog */
intentPath_storedPromptsMissing: number;
```

`src/commands/diagnostics.ts` の `formatSnapshot()` も更新して表示する。

### 5.8 後方互換性

- `version: 1` の `turn-log.json` はそのまま読み込み可能
- version 1 から読み込んだエントリは `systemPrompt` / `rawUserPrompt` が `undefined`
- 次回 `append` 時に `version: 2` 形式で保存される

---

## 6. テスト計画

### 6.1 単体テスト

#### `src/core/turn-log.test.ts`

1. `systemPrompt` / `rawUserPrompt` を含むエントリの保存・読み込み
2. `version: 2` の `turn-log.json` の書き込み・再読み込み
3. `version: 1` → `version: 2` のマイグレーション（旧ファイル読み込み後、append して version 2 で保存されること）
4. プロンプトが切り詰めサイズを超えた場合の `tailTruncate`
5. `formatForPrompt()` 出力に `【プロンプト】` セクションが含まれること
6. `formatForPrompt()` で `MAX_CHARS` 超過時に古いターンから drop すること
7. 破損ファイル・欠落フィールドのグレースフル処理

#### `src/core/diff-analyzer.test.ts`

1. `formatForPrompt()` 出力（プロンプトセクション付き）を `buildIntentPrompt()` に渡したとき、出力に `=== CONVERSATION HISTORY` と prompt マーカーが含まれること
2. `analyzeDiffIntent()` の `aiComplete` モック呼び出しで、userMessage に `【プロンプト】` セクションが含まれること

`buildIntentPrompt` / `getIntentSystemPrompt` は非 export なので、間接的に `analyzeDiffIntent` をモックで検証する。

### 6.2 統合テスト

- 実際の git リポジトリで `/git-agg-commit` 実行時に保存済みプロンプトが AI 入力に含まれることを、`aiComplete` モックで検証

### 6.3 E2E テスト

- `src/core/analyze-diff-intent.e2e.ts` を拡張し、`makeTurnEvent()` に `systemPrompt` / `rawUserPrompt` を追加したシナリオを作成
- 本番 `t(lang, "diffAnalyzer.intentBuildPrompt")` を使うようリファクタリング

---

## 7. 影響範囲

| ファイル | 変更内容 | 影響度 |
|---|---|---|
| `src/types.ts` | `AgentEndEvent` は pi-coding-agent ランタイム型と一致（変更なし） | 小 |
| `src/core/turn-log.ts` | `TurnEntry` / `PersistedTurnLog` 拡張、`append` / `formatForPrompt` / `loadFromDisk` / `saveToDisk` 変更 | 大 |
| `src/core/diff-analyzer.ts` | `diffAnalyzer.intentBuildPrompt` テンプレート微修正 | 小 |
| `src/core/batch-committer.ts` | 診断カウンター追加 | 小 |
| `src/utils/diagnostics.ts` | 新カウンター追加 | 小 |
| `src/commands/diagnostics.ts` | 新カウンター表示追加 | 小 |
| `src/index.ts` | `before_agent_start` ハンドラ追加、`agent_end` ハンドラで `pendingPrompts` キューからプロンプト取得 | 中 |
| `src/core/turn-log.test.ts` | テスト追加 | 中 |
| `src/core/diff-analyzer.test.ts` | テスト追加 | 小 |
| `src/core/analyze-diff-intent.e2e.ts` | シナリオ追加・本番テンプレート使用 | 小 |
| `docs/accumulate-mode.md` | ドキュメント更新 | 小 |

---

## 8. リスクと軽減策

| リスク | 内容 | 軽減策 |
|---|---|---|
| **イベントフィールド不在** | pi-coding-agent の `agent_end` イベントに `systemPrompt` / `rawUserPrompt` が含まれていない | `before_agent_start` イベントで取得し、FIFO キューで `agent_end` に紐付ける。キュー空の場合は `messages` からの `rawUserPrompt` フォールバック |
| **ファイルサイズ肥大** | プロンプト保存で `.pi-git/turn-log.json` が大きくなる | エントリあたり 1,000/1,500 chars 制限、MAX_CHARS=12,000 で全体を抑制 |
| **コンテキストウィンドウ圧迫** | TurnLog 増大により diff 分析用予算が削られる | `MAX_INTENT_PROMPT_CHARS` を 24,000 に拡張。diff 優先の切り詰め維持 |
| **後方互換破損** | version 1 ファイルの読み込みに失敗する | `loadFromDisk()` を `version !== 1 && version !== 2` に変更。厳密なエントリ検証は必須フィールドのみ維持 |
| **プライバシー** | 機密情報を含むプロンプトがディスクに保存される | 既存 TurnLog と同じローカル保存方針。`.git/info/exclude` による誤コミット防止を維持 |

---

## 9. 実装フェーズ

### Phase 0: 調査（0.5 ターン）

- pi-coding-agent の `agent_end` イベント構造を確認
- `systemPrompt` / `rawUserPrompt` が取得可能か調査
- 取得できない場合の代替設計を決定

### Phase 1: スキーマ・永続化（1 ターン）

- `src/types.ts` の型拡張
- `src/core/turn-log.ts` の `TurnEntry` / `PersistedTurnLog` 拡張
- `append()` にプロンプト保存を追加
- `loadFromDisk()` の version 1/2 両許可
- `saveToDisk()` の version 2 対応
- `formatForPrompt()` のプロンプトセクション統合

### Phase 2: 分析側統合（0.5 ターン）

- `src/core/diff-analyzer.ts` のプロンプトテンプレート微修正
- `src/utils/diagnostics.ts` カウンター追加
- `src/core/batch-committer.ts` でカウンターインクリメント
- `src/commands/diagnostics.ts` 表示更新

### Phase 3: テスト・ドキュメント（1 ターン）

- `src/core/turn-log.test.ts` 拡張
- `src/core/diff-analyzer.test.ts` 拡張
- `src/core/analyze-diff-intent.e2e.ts` 拡張
- `docs/accumulate-mode.md` 更新
- 手動動作確認

---

## 10. レビュー指摘への対応

### 10.1 version 2 読み込み対応

指摘: `loadFromDisk()` の `obj.version !== 1` が version 2 ファイルを拒否する。

対応: `if (obj.version !== 1 && obj.version !== 2)` に変更。save 側は `version: 2` を書き出す。

### 10.2 `formatForPrompt()` 設計の統一

指摘: 計画 4.5 節で `formatForPrompt()` 内埋め込みと `buildIntentPrompt()` 引数追加が混在していた。

対応: **`formatForPrompt()` 内で統一**。`buildIntentPrompt()` のシグネチャは変更しない。

### 10.3 診断カウンター名の統一

指摘: 計画 4.5 節の `intentPath_usedStoredPrompts` と 4.7 節の `intentPath_usedStoredSystemPrompt` / `intentPath_usedStoredUserPrompt` が不一致。

対応: 以下の 3 つに統一。

```typescript
intentPath_storedSystemPromptUsed
intentPath_storedUserPromptUsed
intentPath_storedPromptsMissing
```

### 10.4 system prompt の扱い

指摘: 保存 system prompt をそのまま分析 AI の system prompt に使うと、分析用命令が欠落する。

対応: **分析用 system prompt は固定維持**。保存 system prompt は user prompt 内の `【プロンプト】` セクションに含める。

### 10.5 `rawUserPrompt` と `userMessage` の重複

指摘: 同じ user メッセージが 2 重に保存される可能性がある。

対応: `userMessage` は加工済み要約版（既存）、`rawUserPrompt` は加工前全文として明確に用途を分離。重複は許容し、サイズ制限で抑制する。

### 10.6 テスト計画の具体化

指摘: version 2 ロード、helper 修正、`diff-analyzer` 側 prompt 検証、カウンター検証が具体化されていない。

対応: 6.1 / 6.2 / 6.3 節に具体的なテストケースを追加。

### 10.7 予算数値の整合性

指摘: MAX_ENTRIES / MAX_CHARS / MAX_INTENT_PROMPT_CHARS の数値に整合性が欠けていた。

対応: MAX_ENTRIES=20、MAX_CHARS=12,000、MAX_INTENT_PROMPT_CHARS=24,000 に確定。実装後に実測で微調整可能。

### 10.8 プロンプト取得パスの変更（Phase 0 調査結果）

調査結果: `agent_end` イベントには `systemPrompt` / `rawUserPrompt` が含まれない。`before_agent_start` イベントに `prompt` / `systemPrompt` がある。

対応:
- `src/index.ts` に `before_agent_start` ハンドラを追加し、FIFO キュー `pendingPrompts` に保存
- `agent_end` ハンドラでキュー先頭を取り出し、`turnLog.append()` に個別引数として渡す
- `TurnLog.append()` のシグネチャを `(event, changedFiles, systemPrompt?, rawUserPrompt?)` に変更
- `src/types.ts` の `AgentEndEvent` は pi-coding-agent ランタイム型と一致させる（拡張しない）

---

## 11. 承認待ち項目

実装に進む前に、以下を確認・承認いただきたい。

1. **system prompt の扱い**: 分析用 system prompt は固定維持し、保存 system prompt は user prompt セクションに含める方針
2. **`rawUserPrompt` の定義**: 最新 user メッセージの加工前全文とする方針
3. **サイズ制限**: エントリあたり systemPrompt 1,000 / rawUserPrompt 1,500、MAX_CHARS 12,000、MAX_INTENT_PROMPT_CHARS 24,000
4. **プロンプト取得パス**: `before_agent_start` → FIFO キュー → `agent_end` 紐付けの方針
