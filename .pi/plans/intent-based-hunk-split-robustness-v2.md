# Implementation Plan v2: Intent-based Hunk Split Robustness for Cheap Models

**Date:** 2026-06-14
**Status:** v2 — Pending Re-Review
**v1 Reviews:** Correctness ✅ | Risks ✅ | Prompt Engineering ✅ (3 reviewers, 6 blockers identified)
**v2 Changes:** All 6 blockers resolved. Added: input-size guard, secondary confidence check, hunk batching, CHEAP_MODEL_PATTERNS consolidation, diagnostic counters, full `intentBuildPrompt` design.

---

## Problem Statement

（v1 から変更なし。問題診断は全レビュワー一致で正確と評価された）

### Current State

`/git-agg-commit` has two analysis paths:

| Path | Module | Granularity | Trigger Condition |
|------|--------|-------------|-------------------|
| **Intent-based** | `analyzeDiffIntent()` | Per-hunk (`@@` block level) — partial-file staging via `stageDiffHunks` | TurnLog available + AI returns parsable response |
| **Diff-based fallback** | `analyzeDiff()` | Per-file level — whole-file staging via `stageFiles` | TurnLog empty OR intent-based fails |

The intent-based path is architecturally correct but **almost always fails** due to a 2-line AI prompt with no examples, no rules, and a fragile tagged-line output format. The diff-based fallback takes over, producing only 1-commit-per-file output.

---

## Proposed Solution (3-Level)

```
Level 1: Strengthened AI prompt (JSON format + few-shot examples + ja localization)
   ↓ AI が JSON を返せない / 低信頼度
Level 2: TurnLog deterministic heuristic (file co-occurrence → grouping)
   ↓ TurnLog も空
Level 3: Existing diff-based file-level analysis (unchanged)
```

---

## v2 Changes from v1

| v1 Blocker | v2 Resolution |
|------------|---------------|
| 🔴 `intentBuildPrompt` 未設計 | **P0-5 追加**: 完全な en/ja ユーザープロンプト設計 |
| 🔴 `generateAutoCommitMessage` 不在 | **P1-1 修正**: `generateFallbackMessage`(既存) + `sanitizeCommitMessage`(既存) を使用。AI不要の決定論的メッセージ生成に変更 |
| 🔴 "会話が主軸" が DIFF-IS-PRIMARY と矛盾 | **P0-1 修正**: Rule 1/2 の順序を「Diff が検証の主軸 → 会話がグループ化のヒント」に変更 |
| 🔴 日本語例がプレースホルダー | **P0-1 修正**: 完全な日本語 JSON 例を2つ追加（v2では3つに増加） |
| 🔴 `clusterByCooccurrence` 未定義 | **P1-1 修正**: Greedy Connected Components (threshold ≥2) の完全な疑似コードを追加 |
| 🔴 `commitHeuristicGroups` 未定義 | **P1-1 修正**: `commitIntentGroups` を再利用することを明記 |

### 追加された高優先度改善

| レビュー指摘 | v2 対応 |
|-------------|---------|
| Few-shot 例が2グループのみ | 3つ目の例（5 hunk → 1グループ）を追加 |
| Intent path に入力サイズガードなし | **P0-6 追加**: `MAX_HUNKS_PER_INTENT_BATCH = 50` の hunk バッチ分割 |
| "medium" 信頼度が警告のみ | **P0-7 追加**: 二次信頼度チェック（low グループの hunk 割合が50%超→"low"に格下げ） |
| `CHEAP_MODEL_PATTERNS` 重複 | **P1-2 修正**: `resolve-model.ts` に一本化し `export` |
| 移行モニタリングなし | **P2-3 追加**: `diagIncr` カウンターで JSON/Tagged 成功率追跡 |

---

## Implementation Items

### P0-1: Rewrite `intentSystemPrompt` with Few-Shot Examples

**File:** `src/i18n/messages.ts`
**Keys affected:** `diffAnalyzer.intentSystemPrompt` (en + ja 両方差し替え)

**設計方針（レビュー指摘反映）:**
- Rule 1 は Diff を主軸に（「Diff hunks are the source of truth」）
- Rule 2 で会話をグループ化ヒントに（「Conversation provides grouping hints」）
- 例を2つ→3つに増加（2グループ分割 + 1グループ統合 + 未説明hunk混在）
- `turnIndices` は常に含める（空配列 `[]` で「対応なし」を明示）
- 言語ルール: en→"Write commit messages in English", ja→"サブジェクトは必ず日本語"
- 禁止メッセージにグループ化の禁止事項も追加（"NEVER put all hunks in one group unless..."）

**v2 Target (en):**
```
You are a commit decomposition engine. Group numbered diff hunks [H1]..[HN] into logical commits.

Each commit group represents ONE logical change. The number of groups in the examples is illustrative — output as many groups as the diff and conversation require.

GUIDING RULES:
1. **Diff hunks are the source of truth.** Only hunk numbers [H1]..[HN] that appear in the numbered list can be grouped. Never invent or skip hunks. Every hunk MUST be assigned to exactly one group.
2. **Conversation provides grouping hints.** When diff hunks clearly correspond to specific conversation turns, group them together. When conversation and diff structure conflict, the diff structure wins.
3. **File co-occurrence matters.** Files changed together in the same conversation turn are likely related and should be grouped together.
4. **One file can split across groups.** Different @@ hunks in the same file may belong to different logical changes — split them when the conversation context supports it (e.g., one hunk from turn 1, another from turn 2).
5. **Do NOT put all hunks in one group** unless the conversation clearly links them all to a single logical change. Do NOT create one group per hunk — look for logical clusters.

CONFIDENCE LEVELS:
- "high": All hunks in this group clearly correspond to specific conversation turns.
- "medium": Most hunks mapped; some grouping inferred from file proximity or diff structure.
- "low": This group contains primarily unexplained changes (catch-all for diff-only hunks that have no conversation context).

Always include "turnIndices" in every group. Use an empty array [] when no conversation turn matches.

MESSAGE FORMAT:
- Conventional Commits: type(scope): subject
- Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build, revert
- Subject: Write commit messages in English. Keep subject under 50 characters. Use imperative mood.
- Scope: include only if clearly inferable from file paths or conversation context

FORBIDDEN MESSAGES (NEVER generate):
- "chore: apply changes" / "chore: update files" / "chore: modify files"
- "feat: 機能を追加" / "fix: 修正しました" / "chore: 変更を適用"
- Any message using only generic verbs without specific references to what changed
- Any message using words that appear nowhere in the DIFF or the CONVERSATION

EXAMPLES:

Example 1 — Multi-turn grouping (split):
Turn 1: "Add login form and API" → login.ts (form component), api.ts (API client)
Turn 2: "Add validation" → validation.ts (new file), login.ts (added validation import)
Diff hunks: [H1] login.ts: form component, [H2] api.ts: API client, [H3] login.ts: validation import, [H4] validation.ts: new file
Output:
{
  "overallConfidence": "high",
  "groups": [
    {"hunks": [1, 2], "message": "feat(auth): add login form and API client", "confidence": "high", "turnIndices": [1]},
    {"hunks": [3, 4], "message": "feat(auth): add email validation", "confidence": "high", "turnIndices": [2]}
  ]
}

Example 2 — Single large group (merge):
Turn 1: "Refactor config module" → config.ts: renamed vars, extracted helper, updated types, added tests, updated imports (5 hunks, all related)
Diff hunks: [H1] config.ts: renamed vars, [H2] config.ts: extracted helper, [H3] config.ts: updated types, [H4] config.ts: added tests, [H5] config.ts: updated imports
Output:
{
  "overallConfidence": "high",
  "groups": [
    {"hunks": [1, 2, 3, 4, 5], "message": "refactor(config): extract helpers and update types", "confidence": "high", "turnIndices": [1]}
  ]
}

Example 3 — Unexplained changes (mixed confidence):
Turn 1: "Fix README typo" → README.md (typo fix)
Diff also shows package.json version bump (NOT mentioned in conversation)
Diff hunks: [H1] README.md: typo fix, [H2] package.json: version bump
Output:
{
  "overallConfidence": "medium",
  "groups": [
    {"hunks": [1], "message": "docs: fix typo in README", "confidence": "high", "turnIndices": [1]},
    {"hunks": [2], "message": "chore: bump version to 2.0.0", "confidence": "low", "turnIndices": [], "note": "No conversation context found for this change"}
  ]
}

Return ONLY a valid JSON object. No code fences, no explanations, no markdown.
```

**v2 Target (ja):**
```
あなたはコミット分解エンジンです。会話履歴とdiff構造に基づいて、番号付きdiff hunk [H1]..[HN] を論理的なコミットにグループ化してください。

各コミットグループは1つの論理的な変更を表します。例に示すグループ数は参考であり、実際のdiffと会話に応じて必要な数だけグループを出力してください。

グルーピングルール:
1. **Diff hunkが真実の情報源です。** 番号付きリストにある [H1]..[HN] のみをグループ化の対象とし、hunkを捏造したりスキップしたりしないでください。すべてのhunkを必ずいずれかのグループに割り当ててください。
2. **会話履歴はグループ化のヒントです。** diff hunkが特定の会話ターンに明確に対応する場合はグループ化し、会話とdiff構造が矛盾する場合はdiff構造を優先してください。
3. **ファイルの共起関係を重視。** 同じ会話ターンで一緒に変更されたファイルは関連性が高いため、同じグループにまとめてください。
4. **1ファイルを複数グループに分割できます。** 同じファイル内の異なる@@ hunkが異なる会話ターンに対応する場合は分割してください。
5. **全hunkを1グループにまとめないでください。** 会話が明らかに1つの論理的変更を示している場合を除き、分割を検討してください。また、1 hunk = 1グループの過分割も避け、論理的なまとまりを探してください。

信頼度:
- "high": グループの全hunkが特定の会話ターンに明確に対応。
- "medium": 大部分のhunkがマッピング済み。一部はファイル近接性やdiff構造から推論。
- "low": 主に説明不能な変更の寄せ集め（会話文脈のないdiff-onlyのhunk用）。

"turnIndices" は全グループに必ず含めてください。該当する会話ターンがない場合は空配列 [] を指定してください。

メッセージ形式:
- Conventional Commits: type(scope): subject
- type: feat, fix, docs, style, refactor, test, chore, perf, ci, build, revert から選択
- サブジェクトは必ず日本語で記述。50文字以内、命令形。
- スコープはファイルパスか会話文脈から明確に推測できる場合のみ含める。

禁止メッセージ（絶対に生成しない）:
- 「変更を適用」「ファイルを更新」「修正しました」「機能を追加」「更新しました」
- 汎用動詞のみで具体的な変更内容に言及していないメッセージ
- GIT DIFF や会話ログに現れていない単語だけを使ったメッセージ

例:

例1 — 複数ターンに跨る分割:
ターン1: 「ログインフォームとAPIを追加して」→ login.ts（フォーム部品）, api.ts（APIクライアント）
ターン2: 「バリデーションも追加して」→ validation.ts（新規）, login.ts（バリデーションimport追加）
Diff hunks: [H1] login.ts: フォーム部品, [H2] api.ts: APIクライアント, [H3] login.ts: バリデーションimport, [H4] validation.ts: 新規ファイル
出力:
{
  "overallConfidence": "high",
  "groups": [
    {"hunks": [1, 2], "message": "feat(auth): ログインフォームとAPIクライアントを追加", "confidence": "high", "turnIndices": [1]},
    {"hunks": [3, 4], "message": "feat(auth): メールアドレス検証を追加", "confidence": "high", "turnIndices": [2]}
  ]
}

例2 — 1つの大きなグループ（統合）:
ターン1: 「configモジュールをリファクタリングして」→ config.ts: 変数名変更, ヘルパー抽出, 型更新, テスト追加, import更新（5 hunkすべて関連）
Diff hunks: [H1] config.ts: 変数名変更, [H2] config.ts: ヘルパー抽出, [H3] config.ts: 型更新, [H4] config.ts: テスト追加, [H5] config.ts: import更新
出力:
{
  "overallConfidence": "high",
  "groups": [
    {"hunks": [1, 2, 3, 4, 5], "message": "refactor(config): ヘルパー抽出と型定義を整理", "confidence": "high", "turnIndices": [1]}
  ]
}

例3 — 説明不能な変更の混在:
ターン1: 「READMEの誤字を修正して」→ README.md（誤字修正）
diffにはpackage.jsonのバージョン更新も含まれる（会話で言及なし）
Diff hunks: [H1] README.md: 誤字修正, [H2] package.json: バージョン更新
出力:
{
  "overallConfidence": "medium",
  "groups": [
    {"hunks": [1], "message": "docs: READMEの誤字を修正", "confidence": "high", "turnIndices": [1]},
    {"hunks": [2], "message": "chore: バージョンを2.0.0に更新", "confidence": "low", "turnIndices": [], "note": "この変更に対応する会話履歴がありません"}
  ]
}

有効なJSONオブジェクトのみを返してください。コードフェンスや説明、マークダウンは一切不要です。
```

### P0-2: Change Output Format to JSON-First Parser

**File:** `src/core/diff-analyzer.ts`

**Changes in `parseHunkGroupingResult`:**

```typescript
export function parseHunkGroupingResult(text: string): HunkGroupingResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Layer 1 (PRIMARY): JSON format
  const json = tryParseJSONFormat(trimmed);
  if (json) { diagIncr("parseLayer1_jsonPrimary"); return json; }

  // Layer 2 (FALLBACK): tagged-line format (backward compat)
  const tagged = tryParseTaggedFormat(trimmed);
  if (tagged) { diagIncr("parseLayer2_taggedFallback"); return tagged; }

  // Layer 3 (LAST RESORT): heuristic extraction
  const heuristic = tryParseHeuristic(trimmed);
  if (heuristic) { diagIncr("parseLayer3_heuristicFallback"); return heuristic; }

  diagIncr("parseFailure_allLayers");
  return null;
}
```

**No type changes needed.** `HunkGroupingResult` and `CommitGroup` in `types.ts` are already JSON-compatible.

### P0-3: Add Japanese Localization for Intent Prompts

**File:** `src/i18n/messages.ts`

P0-1 の en/ja 両方のプロンプトで既にカバーされている。既存キー `diffAnalyzer.intentSystemPrompt` と `diffAnalyzer.intentBuildPrompt` を両方差し替える。

### P0-4: Separate `MAX_OUTPUT_TOKENS` for Intent Path

**File:** `src/core/diff-analyzer.ts`

```typescript
// Module-scope constants
const MAX_OUTPUT_TOKENS = 2048;        // For diff-based path (unchanged)
const MAX_OUTPUT_TOKENS_INTENT = 4096; // NEW: For intent-based path (richer JSON output)
```

**Change in `analyzeDiffIntent`:**
```diff
  const result = await aiComplete(ctx, {
    systemPrompt,
    userMessage,
-   maxTokens: MAX_OUTPUT_TOKENS,
+   maxTokens: MAX_OUTPUT_TOKENS_INTENT,
    temperature: 0,
  });
```

### P0-5: Rewrite `intentBuildPrompt` (User Prompt) — NEW in v2

**File:** `src/i18n/messages.ts`
**Keys affected:** `diffAnalyzer.intentBuildPrompt` (en + ja 両方差し替え)

**設計方針:**
- セクションラベルに優先度を明示（`PRIMARY` / `SUPPLEMENTARY`）
- diff が先、会話が後（プライマシーバイアスを diff 側に）
- 出力形式を再掲（JSONオブジェクトのみ）
- システムプロンプトの重要ルールを再掲（cross-reference）
- `{examples}` プレースホルダーは削除（例はシステムプロンプトに移動済みのため）

**v2 Target (en):**
```
=== NUMBERED DIFF HUNKS (PRIMARY — these are the only hunks you can group) ===
{numberedHunksText}

=== CONVERSATION HISTORY (SUPPLEMENTARY — use only to infer grouping intent) ===
{turnLogText}

IMPORTANT:
- Every hunk [H1]..[HN] MUST appear in exactly one group. Do not skip or duplicate hunks.
- If the conversation mentions a change not in the diff, ignore it.
- If the diff contains changes not in the conversation, group them separately (confidence: "low").
- The number of groups in the examples is illustrative — output as many as needed.

Return ONLY a valid JSON object. No code fences, no explanations.
```

**v2 Target (ja):**
```
=== 番号付きDIFF HUNK（最優先 — グループ化できるのはこれらのみ） ===
{numberedHunksText}

=== 会話履歴（補助 — グループ化の意図推測にのみ使用） ===
{turnLogText}

重要:
- すべてのhunk [H1]..[HN] を必ずいずれかのグループに割り当ててください。スキップや重複は禁止です。
- 会話で言及されていてもdiffにない変更は無視してください。
- diffにあるが会話で説明できない変更は別グループにしてください（confidence: "low"）。
- 例に示すグループ数は参考であり、必要に応じて増減してください。

有効なJSONオブジェクトのみを返してください。コードフェンスや説明は一切不要です。
```

### P0-6: Add Hunk-Level Batching for Intent Path — NEW in v2

**File:** `src/core/diff-analyzer.ts`

**Rationale:** 500+ hunk の巨大 diff で context window 超過を防ぐ。

```typescript
/** Maximum hunks per intent analysis batch (prevents context window overflow) */
const MAX_HUNKS_PER_INTENT_BATCH = 50;

/** Maximum prompt chars before batching is triggered */
const MAX_INTENT_PROMPT_CHARS = 20_000;
```

**Change in `analyzeDiffIntent`:**

```typescript
export async function analyzeDiffIntent(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  diff: string,
  turnLogText: string,
  langOverride?: string,
): Promise<HunkGroupingResult | null> {
  const lang = langOverride ?? getLanguage(ctx.cwd);
  const diffHunks = parseDiffHunks(diff);
  if (diffHunks.length === 0) return null;

  // Guard: if too many hunks, batch them
  if (diffHunks.length > MAX_HUNKS_PER_INTENT_BATCH) {
    return await analyzeDiffIntentBatched(
      pi, ctx, diffHunks, turnLogText, lang, MAX_HUNKS_PER_INTENT_BATCH,
    );
  }

  // Guard: if prompt is too large, truncate turnLogText
  const numberedHunksText = formatNumberedHunks(diffHunks);
  const estimatedPromptSize = numberedHunksText.length + turnLogText.length + 3000;
  if (estimatedPromptSize > MAX_INTENT_PROMPT_CHARS) {
    turnLogText = turnLogText.substring(0, MAX_INTENT_PROMPT_CHARS - numberedHunksText.length - 3000);
  }

  // ... existing single-batch analysis
}
```

**Batch merge logic:**

```typescript
async function analyzeDiffIntentBatched(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  allHunks: DiffHunk[],
  turnLogText: string,
  lang: string,
  batchSize: number,
): Promise<HunkGroupingResult | null> {
  const allGroups: CommitGroup[] = [];
  let overallConfidence: "high" | "medium" | "low" = "high";

  for (let i = 0; i < allHunks.length; i += batchSize) {
    const batch = allHunks.slice(i, i + batchSize);
    const numberedText = formatNumberedHunks(batch);

    const result = await aiComplete(ctx, {
      systemPrompt: getIntentSystemPrompt(lang),
      userMessage: buildIntentPrompt(turnLogText, numberedText, lang),
      maxTokens: MAX_OUTPUT_TOKENS_INTENT,
      temperature: 0,
    });

    if (!result) return null;

    const grouping = parseHunkGroupingResult(result.text);
    if (!grouping) return null;

    allGroups.push(...grouping.groups);
    if (grouping.overallConfidence === "low") overallConfidence = "low";
    else if (grouping.overallConfidence === "medium" && overallConfidence !== "low") {
      overallConfidence = "medium";
    }
  }

  return { overallConfidence, groups: allGroups };
}
```

### P0-7: Add Secondary Confidence Check — NEW in v2

**File:** `src/core/batch-committer.ts`

**Rationale:** 安価モデルは自己の不確実性を過小評価する傾向がある。AI の自己申告信頼度を鵜呑みにせず、実際の low-confidence グループの割合から検証する。

```typescript
/**
 * Cross-check AI-reported confidence against actual group composition.
 * If >50% of hunks are in low-confidence groups but overallConfidence says otherwise,
 * the model is likely overconfident — downgrade.
 */
function verifyConfidence(result: HunkGroupingResult, totalHunks: number): HunkGroupingResult {
  const lowHunkCount = result.groups
    .filter((g) => g.confidence === "low")
    .reduce((sum, g) => sum + g.hunks.length, 0);

  const lowFraction = lowHunkCount / totalHunks;

  if (lowFraction > 0.5 && result.overallConfidence !== "low") {
    diagIncr("confidenceDowngrade_overconfidentModel");
    return { ...result, overallConfidence: "low" };
  }

  if (lowFraction > 0.3 && result.overallConfidence === "high") {
    diagIncr("confidenceDowngrade_highToMedium");
    return { ...result, overallConfidence: "medium" };
  }

  return result;
}
```

**Integration point in `batchCommit`:** `analyzeDiffIntent` の戻り値を受け取った直後に適用。

### P1-1: Add TurnLog Heuristic Fallback Layer (Revised)

**File:** `src/core/batch-committer.ts`

**v2 変更点:**
- `generateAutoCommitMessage`（不在）の代わりに `generateFallbackMessage` + `sanitizeCommitMessage`（両方とも既存）を使用
- `commitHeuristicGroups` を新設せず、既存の `commitIntentGroups` を再利用
- `clusterByCooccurrence` の完全なアルゴリズムを定義
- `DiffHunkRef.file` のマッピングを明示

**`buildGroupsFromTurnLog` (完全版):**

```typescript
/**
 * Build commit groups deterministically from TurnLog file co-occurrence data.
 *
 * Algorithm:
 * 1. Map each hunk file to its most recent TurnLog turn
 * 2. Group hunks by turn
 * 3. Within each turn, sub-group by file co-occurrence clusters
 * 4. Unassigned hunks → catch-all group
 *
 * Used when AI-based intent analysis fails (parse error, null response).
 */
function buildGroupsFromTurnLog(
  diffHunks: DiffHunk[],
  turnLog: TurnLog,
): CommitGroup[] {
  // 1. Build file → most-recent-turn-index mapping
  const fileToTurn = new Map<string, number>();
  const entries = turnLog.getEntries(); // NEW method — returns entries array
  for (const entry of [...entries].reverse()) {
    for (const file of entry.filesChanged) {
      if (!fileToTurn.has(file)) fileToTurn.set(file, entry.index);
    }
  }

  // 2. Group diff hunks by their turn assignment
  const turnGroups = new Map<number, DiffHunk[]>();
  const unassigned: DiffHunk[] = [];

  for (const hunk of diffHunks) {
    const turn = fileToTurn.get(hunk.file);
    if (turn !== undefined) {
      if (!turnGroups.has(turn)) turnGroups.set(turn, []);
      turnGroups.get(turn)!.push(hunk);
    } else {
      unassigned.push(hunk);
    }
  }

  // 3. For turns with many hunks, sub-group by file co-occurrence
  const cooccurrence = turnLog.getFileCooccurrence();
  const groups: CommitGroup[] = [];

  for (const [, hunks] of turnGroups) {
    if (hunks.length <= 3) {
      // Small enough to keep as one group
      groups.push(makeHeuristicGroup(hunks, "medium"));
    } else {
      // Sub-group: cluster files that co-occur frequently across ALL turns
      const clusters = clusterByCooccurrence(hunks, cooccurrence);
      for (const cluster of clusters) {
        groups.push(makeHeuristicGroup(cluster, "low"));
      }
    }
  }

  // 4. Unassigned hunks → catch-all
  if (unassigned.length > 0) {
    groups.push({
      hunks: unassigned.map((h) => ({ globalIndex: h.globalIndex, file: h.file })),
      message: generateFallbackMessage(
        unassigned.map((h) => h.file),
      ), // ← 既存関数を使用
      confidence: "low",
      note: "TurnLogに記録のない変更（人手編集の可能性）",
    });
  }

  return groups;
}
```

**`clusterByCooccurrence` (新規定義):**

```typescript
/**
 * Cluster hunks by file co-occurrence using greedy connected components.
 *
 * Algorithm:
 * 1. Build a graph where nodes = unique files in hunks
 * 2. Add edges between files that co-occur ≥ MIN_COOCCURRENCE times across TurnLog
 * 3. Extract connected components as clusters
 * 4. Map clusters back to hunks
 *
 * MIN_COOCCURRENCE = 2: files must appear together in ≥2 turns to be considered "related".
 */
const MIN_COOCCURRENCE = 2;

function clusterByCooccurrence(
  hunks: DiffHunk[],
  cooccurrence: Map<string, number>,
): DiffHunk[][] {
  const uniqueFiles = [...new Set(hunks.map((h) => h.file))];
  if (uniqueFiles.length <= 1) return [hunks];

  // Build adjacency: file → related files
  const adjacency = new Map<string, Set<string>>();
  for (const file of uniqueFiles) {
    adjacency.set(file, new Set());
  }

  const fileSet = new Set(uniqueFiles);
  for (const [pairKey, count] of cooccurrence) {
    if (count < MIN_COOCCURRENCE) continue;
    const [a, b] = pairKey.split("::");
    if (a && b && fileSet.has(a) && fileSet.has(b)) {
      adjacency.get(a)!.add(b);
      adjacency.get(b)!.add(a);
    }
  }

  // Greedy connected components (BFS from each unvisited node)
  const visited = new Set<string>();
  const componentFiles: string[][] = [];

  for (const file of uniqueFiles) {
    if (visited.has(file)) continue;
    const component: string[] = [];
    const queue = [file];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of adjacency.get(current) || []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    componentFiles.push(component);
  }

  // Map components back to hunks
  return componentFiles.map((files) => {
    const fileSet = new Set(files);
    return hunks.filter((h) => fileSet.has(h.file));
  });
}
```

**`makeHeuristicGroup` (ヘルパー):**

```typescript
function makeHeuristicGroup(
  hunks: DiffHunk[],
  confidence: "medium" | "low",
): CommitGroup {
  const files = [...new Set(hunks.map((h) => h.file))];
  // Use existing commit-message.ts utilities (no AI call)
  const message = generateFallbackMessage(files);
  return {
    hunks: hunks.map((h) => ({ globalIndex: h.globalIndex, file: h.file })),
    message: sanitizeCommitMessage(message, files),
    confidence,
    note:
      confidence === "low"
        ? "TurnLogヒューリスティックによるグループ化（AI未使用）"
        : undefined,
  };
}
```

**Integration in `batchCommit`:**

```typescript
// After intent analysis fails:
if (!intentResult && turnLogText) {
  const diffHunks = parseDiffHunks(diff);
  const heuristicGroups = buildGroupsFromTurnLog(diffHunks, turnLog);
  if (heuristicGroups.length > 0) {
    const validated = validateHunkCoverage(heuristicGroups, diffHunks.length);
    // Reuse existing commitIntentGroups (handles review + commitCommitGroups)
    result = await commitIntentGroups(
      pi, ctx, validated, diffHunks, diff, lang, isReview,
    );
  }
}
```

### P1-2: Add Cheap Model Detection (Revised)

**Files:** `src/core/resolve-model.ts` (定数定義を一本化), `src/core/batch-committer.ts` (import + 使用)

**v2 変更点:** `CHEAP_MODEL_PATTERNS` を `resolve-model.ts` に定義し `export`。両プランから import する一本化された共有定数にする。

```typescript
// src/core/resolve-model.ts — NEW export

/** Model name patterns indicating cheap/small models */
export const CHEAP_MODEL_PATTERNS: RegExp[] = [
  /mini/i, /flash/i, /nano/i, /lite/i, /small/i, /haiku/i,
];

/** Check if a model ID matches known cheap/small model patterns */
export function isCheapModel(modelId: string | undefined): boolean {
  if (!modelId) return true; // unknown → conservative
  return CHEAP_MODEL_PATTERNS.some((p) => p.test(modelId));
}
```

**Import in `batch-committer.ts`:**
```typescript
import { resolveModel, isCheapModel } from "./resolve-model.js";
```

**Strategy adjustment:**
```typescript
const model = resolveModel(ctx);
if (isCheapModel(model?.id) && turnLogText) {
  // Skip AI grouping entirely → use TurnLog heuristics
  const diffHunks = parseDiffHunks(diff);
  const groups = buildGroupsFromTurnLog(diffHunks, turnLog);
  const validated = validateHunkCoverage(groups, diffHunks.length);
  result = await commitIntentGroups(pi, ctx, validated, diffHunks, diff, lang, isReview);
} else {
  // Full pipeline for capable models
  // ... existing intent-based → heuristic → diff-based flow
}
```

### P1-3: Add File Co-occurrence Analysis to TurnLog

**File:** `src/core/turn-log.ts`

**v2 変更点:** `getEntries()` getter を追加（P1-1 の `buildGroupsFromTurnLog` からアクセスするため）。

```typescript
/** Get entries for external consumers (e.g., heuristic grouping) */
getEntries(): TurnEntry[] {
  return this.entries;
}

/**
 * Compute file co-occurrence scores from TurnLog entries.
 * Returns a Map of "fileA::fileB" → co-occurrence count.
 *
 * Key format uses "::" as separator (file paths rarely contain "::").
 * Files in each pair are sorted alphabetically for stable keys.
 */
getFileCooccurrence(): Map<string, number> {
  const scores = new Map<string, number>();

  for (const entry of this.entries) {
    const files = entry.filesChanged;
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = [files[i], files[j]].sort().join("::");
        scores.set(key, (scores.get(key) || 0) + 1);
      }
    }
  }

  return scores;
}
```

### P2-1: Add Diagnostic Counters for Migration Monitoring — NEW in v2

**File:** `src/core/diff-analyzer.ts`

```typescript
// In parseHunkGroupingResult, already added via P0-2:
//   diagIncr("parseLayer1_jsonPrimary")
//   diagIncr("parseLayer2_taggedFallback")
//   diagIncr("parseLayer3_heuristicFallback")
//   diagIncr("parseFailure_allLayers")

// In batchCommit, add:
//   diagIncr("intentPath_success")       — intent-based succeeded
//   diagIncr("intentPath_fallback")      — intent-based failed, used heuristic
//   diagIncr("intentPath_diffBased")     — both failed, used diff-based
//   diagIncr("confidenceDowngrade_*")    — P0-7 confidence corrections
```

これらのカウンターにより、JSON-first 移行の成功率と信頼度補正の発生頻度を追跡可能にする。

### P2-2: Add E2E Test with Real AI Responses (from v1)

**File:** `src/core/analyze-diff-intent.e2e.ts`

Update to validate:
1. JSON format parsing with v2 prompt
2. All hunks assigned (validateHunkCoverage)
3. Confidence levels present and valid
4. turnIndices present in every group (empty arrays allowed)
5. Comparison with diff-based output

### P2-3: Remove Tagged-Line Parser (from v1, deferred with criteria)

**File:** `src/core/diff-analyzer.ts`

**削除基準（v2 で明確化）:**
- `parseLayer1_jsonPrimary` の成功率が ≥95% を 2 リリース連続で達成
- `parseFailure_allLayers` が 0 に近い
- hunk カバレッジのリグレッションなし

基準を満たした後、`tryParseTaggedFormat` と `tryParseHeuristic` を削除。

---

## Updated Files Changed

| File | Changes | Priority |
|------|---------|----------|
| `src/i18n/messages.ts` | Rewrite `intentSystemPrompt` (en/ja), rewrite `intentBuildPrompt` (en/ja) | P0 |
| `src/core/diff-analyzer.ts` | JSON-first parser, `MAX_OUTPUT_TOKENS_INTENT`, hunk batching, diagnostic counters | P0 |
| `src/core/batch-committer.ts` | TurnLog heuristic fallback, secondary confidence check, cheap model strategy | P1 |
| `src/core/resolve-model.ts` | Export `CHEAP_MODEL_PATTERNS` + `isCheapModel()` | P1 |
| `src/core/turn-log.ts` | `getEntries()`, `getFileCooccurrence()` | P1 |
| `src/core/analyze-diff-intent.e2e.ts` | Update E2E test for v2 prompt + JSON validation | P2 |

---

## Fallback Chain (Complete)

```
/git-agg-commit
  │
  ├─ TurnLog available?
  │   ├─ YES → Intent-based AI (JSON prompt + few-shot)
  │   │         │
  │   │         ├─ SUCCESS → verifyConfidence()
  │   │         │   ├─ high   → commitIntentGroups()
  │   │         │   ├─ medium → commitIntentGroups() + warning notify
  │   │         │   └─ low    → fall through to heuristic
  │   │         │
  │   │         └─ FAIL (parse error / null) →
  │   │
  │   ├─ TurnLog Heuristic (deterministic grouping)
  │   │         │
  │   │         ├─ SUCCESS → commitIntentGroups()
  │   │         └─ FAIL (no TurnLog entries match diff) →
  │   │
  │   └─ (cheap model shortcut: skip AI, go straight to heuristic)
  │
  └─ Diff-based AI (file-level) [existing, unchanged]
            │
            ├─ SUCCESS → commitHunks()
            └─ FAIL → fallbackFileBasedHunks()
```

---

## Risk Matrix (Updated v2)

| Risk | Likelihood | Impact | v2 Mitigation |
|------|-----------|--------|---------------|
| AI fails to follow JSON format | Medium | Medium | JSON-first with tagged-line fallback; diagnostic counters track success rate |
| Few-shot examples bias model toward 1/2/3 groups | Low | Low | 3 diverse examples (split, merge, mixed); explicit "the number in examples is illustrative" |
| TurnLog heuristic groups incorrectly | Medium | Low | Only activates when AI fails; uses conservative `MIN_COOCCURRENCE=2`; all groups marked `confidence: low` |
| Heuristic produces too many commits | Medium | Low | ≤3 hunks per turn stay as one group; co-occurrence clustering reduces fragmentation |
| Intent path exceeds context window (500+ hunks) | Low | Medium | `MAX_HUNKS_PER_INTENT_BATCH=50` with batch merge; `MAX_INTENT_PROMPT_CHARS=20K` guard |
| "medium" confidence silently commits wrong groups | Low | Medium | `verifyConfidence()` downgrades to "low" if >50% hunks in low-confidence groups |
| CHEAP_MODEL_PATTERNS duplication | Low | Low | Defined once in `resolve-model.ts`, exported for both plans |
| Renamed files break heuristic matching | Low | Low | Accepted limitation; renamed files fall to catch-all group with `generateFallbackMessage` |
| Concurrent session TurnLog race | Low | Low | Existing limitation (not new); P1-1 only activates when AI fails |
| JSON truncation loses metadata | Low | Low | `validateHunkCoverage` catches unassigned hunks; `overallConfidence` downgraded in `tryParseJSONFormat` when truncation detected |

---

## Success Criteria (Updated)

1. `/git-agg-commit` with cheap model produces **hunk-level commits** (not file-level) for multi-hunk-per-file scenarios
2. AI-generated groups with `confidence: "high"` pass coverage validation (no hunk overlap, no missing hunks)
3. TurnLog heuristic fallback activates when AI fails and produces reasonable groupings
4. `verifyConfidence()` catches overconfident models (diag counter confirms downgrades)
5. No regression for capable models
6. Japanese-language prompts produce Japanese commit messages
7. `parseLayer1_jsonPrimary` diagnostic counter shows ≥80% success rate in first release
