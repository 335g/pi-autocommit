# Implementation Plan v3 (Final): Intent-based Hunk Split Robustness for Cheap Models

**Date:** 2026-06-14
**Status:** v3 — Final, Ready for Implementation
**v1 Reviews:** 3 reviewers → 6 blockers identified
**v2 Reviews:** 3 reviewers → 6 blockers resolved, 2 new blockers + minor improvements identified
**v3 Changes:** 2 new blockers resolved. Rule 5 rewritten (positive form). `note` field documented. 3-group example added. Prompt cross-reference added. JSON constraint strengthened.

---

## Problem Statement

（v1/v2 から変更なし。問題診断は全レビュワー一致で正確と評価された）

`/git-agg-commit` has two analysis paths:

| Path | Module | Granularity | Trigger Condition |
|------|--------|-------------|-------------------|
| **Intent-based** | `analyzeDiffIntent()` | Per-hunk (`@@` block level) | TurnLog available + AI returns parsable response |
| **Diff-based fallback** | `analyzeDiff()` | Per-file level | TurnLog empty OR intent-based fails |

The intent-based path is architecturally correct but **almost always fails** due to a 2-line AI prompt with no examples, no rules, and a fragile tagged-line output format.

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

## v3 Changes from v2

| v2 Blocker | v3 Resolution |
|------------|---------------|
| 🔴 en プロンプトに日本語禁止メッセージ混在 | 英語プロンプトから日本語禁止メッセージを削除。「Write commit messages in English」のみに統一 |
| 🔴 `note` フィールドがスキーマ未記載 | 出力形式セクションに `"note"` を optional フィールドとして明示。例と同じ位置に「Optional」注記を追加 |

### v3 での追加改善

| 指摘 | v3 対応 |
|------|---------|
| Rule 5 の二重否定 | 肯定文に書き換え（"Group hunks into logical clusters... avoid both extremes"） |
| 3 グループの例がない | 例4 を追加（3 つの独立した変更 → 3 グループ） |
| ユーザープロンプトに cross-reference なし | 最初の IMPORTANT 行に "Follow all rules from the system instructions" を追加 |
| "Return ONLY JSON" が弱い | "Your entire response must be a single valid JSON object that can be parsed by JSON.parse()" に強化 |
| `verifyConfidence` の呼び出し順序 | `validateHunkCoverage` → `verifyConfidence` の順序を明記 |
| en Rule 5 と ja Rule 5 の不一致 | en も ja と同じ「分割を検討」スタイルに統一 |

---

## Implementation Items

### P0-1: Rewrite `intentSystemPrompt` with Few-Shot Examples

**File:** `src/i18n/messages.ts`
**Keys affected:** `diffAnalyzer.intentSystemPrompt` (en + ja 両方差し替え)

**v3 Target (en):**
```
You are a commit decomposition engine. Group numbered diff hunks [H1]..[HN] into logical commits.

Each commit group represents ONE logical change. The number of groups in the examples is illustrative — output as many groups as the diff and conversation require.

GUIDING RULES:
1. **Diff hunks are the source of truth.** Only hunk numbers [H1]..[HN] that appear in the numbered list can be grouped. Never invent or skip hunks. Every hunk MUST be assigned to exactly one group.
2. **Conversation provides grouping hints.** When diff hunks clearly correspond to specific conversation turns, group them together. When conversation and diff structure conflict, the diff structure wins.
3. **File co-occurrence matters.** Files changed together in the same conversation turn are likely related and should be grouped together.
4. **One file can split across groups.** Different @@ hunks in the same file may belong to different logical changes — split them when the conversation context supports it (e.g., one hunk from turn 1, another from turn 2).
5. **Group hunks into logical clusters.** Avoid both extremes: putting all hunks into a single mega-group (unless the conversation clearly links them all), and creating one group per hunk (look for meaningful clusters).

CONFIDENCE LEVELS:
- "high": All hunks in this group clearly correspond to specific conversation turns.
- "medium": Most hunks mapped; some grouping inferred from file proximity or diff structure.
- "low": This group contains primarily unexplained changes (catch-all for diff-only hunks that have no conversation context).

OUTPUT FIELDS (every group MUST include all fields):
- "hunks": array of hunk numbers [1, 2, ...]
- "message": Conventional Commits format — type(scope): subject
- "confidence": "high" | "medium" | "low"
- "turnIndices": array of turn numbers. Always include — use empty array [] when no conversation turn matches. May contain multiple turns for changes spanning conversations.
- "note": (OPTIONAL) explanation when confidence is "low". Omit for high/medium confidence groups.

MESSAGE FORMAT:
- Conventional Commits: type(scope): subject
- Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build, revert
- Subject: Write commit messages in English. Keep subject under 50 characters. Use imperative mood.
- Scope: include only if clearly inferable from file paths or conversation context

FORBIDDEN MESSAGES (NEVER generate):
- "chore: apply changes" / "chore: update files" / "chore: modify files"
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

Example 4 — Multiple independent changes (3+ groups):
Turn 1: "Add auth module" → login.ts, api.ts
Turn 2: "Fix README typo" → README.md
Turn 3: "Bump dependencies" → package.json
Diff hunks: [H1] login.ts: new form, [H2] api.ts: new client, [H3] README.md: typo fix, [H4] package.json: version bump
Output:
{
  "overallConfidence": "high",
  "groups": [
    {"hunks": [1, 2], "message": "feat(auth): add login form and API client", "confidence": "high", "turnIndices": [1]},
    {"hunks": [3], "message": "docs: fix typo in README", "confidence": "high", "turnIndices": [2]},
    {"hunks": [4], "message": "chore: bump version to 2.0.0", "confidence": "high", "turnIndices": [3]}
  ]
}

Return ONLY a valid JSON object that can be parsed by JSON.parse(). No code fences, no markdown, no explanations.
```

**v3 Target (ja):**
```
あなたはコミット分解エンジンです。会話履歴とdiff構造に基づいて、番号付きdiff hunk [H1]..[HN] を論理的なコミットにグループ化してください。

各コミットグループは1つの論理的な変更を表します。例に示すグループ数は参考であり、実際のdiffと会話に応じて必要な数だけグループを出力してください。

グルーピングルール:
1. **Diff hunkが真実の情報源です。** 番号付きリストにある [H1]..[HN] のみをグループ化の対象とし、hunkを捏造したりスキップしたりしないでください。すべてのhunkを必ずいずれかのグループに割り当ててください。
2. **会話履歴はグループ化のヒントです。** diff hunkが特定の会話ターンに明確に対応する場合はグループ化し、会話とdiff構造が矛盾する場合はdiff構造を優先してください。
3. **ファイルの共起関係を重視。** 同じ会話ターンで一緒に変更されたファイルは関連性が高いため、同じグループにまとめてください。
4. **1ファイルを複数グループに分割できます。** 同じファイル内の異なる@@ hunkが異なる会話ターンに対応する場合は分割してください。
5. **論理的なまとまりでグループ化してください。** 全hunkの単一巨大グループ化（会話が明確に1つの変更を示す場合を除く）と、1 hunk = 1グループの過分割の両極端を避け、意味のあるまとまりを探してください。

信頼度:
- "high": グループの全hunkが特定の会話ターンに明確に対応。
- "medium": 大部分のhunkがマッピング済み。一部はファイル近接性やdiff構造から推論。
- "low": 主に説明不能な変更の寄せ集め（会話文脈のないdiff-onlyのhunk用）。

出力フィールド（全グループに以下の全フィールドを含めてください）:
- "hunks": hunk番号の配列 [1, 2, ...]
- "message": Conventional Commits形式 — type(scope): subject
- "confidence": "high" | "medium" | "low"
- "turnIndices": ターン番号の配列。必ず含める — 該当する会話ターンがない場合は空配列 [] を指定。複数ターンに跨る変更では複数の番号を含めてもよい。
- "note": （任意）信頼度が "low" の場合の説明。"high"/"medium" では省略可。

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

例4 — 複数の独立した変更（3グループ以上）:
ターン1: 「認証モジュールを追加して」→ login.ts, api.ts
ターン2: 「READMEの誤字を修正して」→ README.md
ターン3: 「依存関係を更新して」→ package.json
Diff hunks: [H1] login.ts: 新規フォーム, [H2] api.ts: 新規クライアント, [H3] README.md: 誤字修正, [H4] package.json: バージョン更新
出力:
{
  "overallConfidence": "high",
  "groups": [
    {"hunks": [1, 2], "message": "feat(auth): ログインフォームとAPIクライアントを追加", "confidence": "high", "turnIndices": [1]},
    {"hunks": [3], "message": "docs: READMEの誤字を修正", "confidence": "high", "turnIndices": [2]},
    {"hunks": [4], "message": "chore: 依存関係を更新", "confidence": "high", "turnIndices": [3]}
  ]
}

有効なJSONオブジェクトのみを返してください。コードフェンスやマークダウン、説明は一切不要です。応答全体がJSONとしてパース可能でなければなりません。
```

### P0-2: Change Output Format to JSON-First Parser

（v2 から変更なし）

**File:** `src/core/diff-analyzer.ts`

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

### P0-3: Add Japanese Localization for Intent Prompts

（v2 から変更なし。P0-1 の en/ja でカバー済み）

### P0-4: Separate `MAX_OUTPUT_TOKENS` for Intent Path

（v2 から変更なし）

```typescript
const MAX_OUTPUT_TOKENS = 2048;        // For diff-based path (unchanged)
const MAX_OUTPUT_TOKENS_INTENT = 4096; // For intent-based path
```

### P0-5: Rewrite `intentBuildPrompt` (User Prompt)

**File:** `src/i18n/messages.ts`
**Keys affected:** `diffAnalyzer.intentBuildPrompt` (en + ja 両方差し替え)

**v3 Target (en):**
```
=== NUMBERED DIFF HUNKS (PRIMARY — these are the only hunks you can group) ===
{numberedHunksText}

=== CONVERSATION HISTORY (SUPPLEMENTARY — use only to infer grouping intent) ===
{turnLogText}

IMPORTANT:
- Follow all rules from the system instructions (grouping, confidence levels, forbidden messages, message format).
- Every hunk [H1]..[HN] MUST appear in exactly one group. Do not skip or duplicate hunks.
- If the conversation mentions a change not in the diff, ignore it.
- If the diff contains changes not in the conversation, group them separately with confidence: "low" and turnIndices: [].
- The number of groups in the examples is illustrative — output as many as needed.

Your entire response must be a single valid JSON object that can be parsed by JSON.parse(). No code fences, no markdown, no explanations.
```

**v3 Target (ja):**
```
=== 番号付きDIFF HUNK（最優先 — グループ化できるのはこれらのみ） ===
{numberedHunksText}

=== 会話履歴（補助 — グループ化の意図推測にのみ使用） ===
{turnLogText}

重要:
- システム指示の全ルール（グループ化、信頼度、禁止メッセージ、メッセージ形式）に従ってください。
- すべてのhunk [H1]..[HN] を必ずいずれかのグループに割り当ててください。スキップや重複は禁止です。
- 会話で言及されていてもdiffにない変更は無視してください。
- diffにあるが会話で説明できない変更は別グループにし、confidence: "low"、turnIndices: [] を設定してください。
- 例に示すグループ数は参考であり、必要に応じて増減してください。

応答全体がJSONとしてパース可能な単一の有効なJSONオブジェクトでなければなりません。コードフェンス、マークダウン、説明は一切不要です。
```

### P0-6: Add Hunk-Level Batching for Intent Path

（v2 から変更なし）

```typescript
const MAX_HUNKS_PER_INTENT_BATCH = 50;
const MAX_INTENT_PROMPT_CHARS = 20_000;
```

### P0-7: Add Secondary Confidence Check

**File:** `src/core/batch-committer.ts`

**v3 明確化:** `validateHunkCoverage` → `verifyConfidence` の順序を明記。

```typescript
/**
 * Cross-check AI-reported confidence against actual group composition.
 * Called AFTER validateHunkCoverage (so catch-all low-confidence groups
 * from unassigned hunks are included in the calculation).
 */
function verifyConfidence(result: HunkGroupingResult, totalHunks: number): HunkGroupingResult {
  if (totalHunks === 0) return result;

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

**Integration ordering in `batchCommit`:**
```typescript
// 1. Parse + validate coverage (adds catch-all groups for unassigned hunks)
const validated = validateHunkCoverage(intentResult.groups, diffHunks.length);

// 2. Verify self-reported confidence (uses catch-all groups from step 1)
const verified = verifyConfidence(
  { ...intentResult, groups: validated },
  diffHunks.length,
);

// 3. Decision based on verified confidence
if (verified.overallConfidence === "low") {
  // fall through to heuristic
} else {
  result = await commitIntentGroups(pi, ctx, verified.groups, diffHunks, diff, lang, isReview);
}
```

### P1-1: Add TurnLog Heuristic Fallback Layer

（v2 から変更なし。`generateFallbackMessage` + `sanitizeCommitMessage` を使用、`commitIntentGroups` を再利用）

完全な `buildGroupsFromTurnLog`、`clusterByCooccurrence`、`makeHeuristicGroup` の各定義は v2 の通り。

### P1-2: Add Cheap Model Detection

（v2 から変更なし。`CHEAP_MODEL_PATTERNS` + `isCheapModel` を `resolve-model.ts` に一本化）

### P1-3: Add File Co-occurrence Analysis to TurnLog

（v2 から変更なし。`getEntries()` + `getFileCooccurrence()` を追加）

### P2-1: Add Diagnostic Counters

（v2 から変更なし）

### P2-2: Add E2E Test with Real AI Responses

（v2 から変更なし）

### P2-3: Remove Tagged-Line Parser (deferred with criteria)

（v2 から変更なし）

---

## Updated Files Changed

| File | Changes | Priority |
|------|---------|----------|
| `src/i18n/messages.ts` | Rewrite `intentSystemPrompt` (en/ja), rewrite `intentBuildPrompt` (en/ja) | P0 |
| `src/core/diff-analyzer.ts` | JSON-first parser, `MAX_OUTPUT_TOKENS_INTENT`, hunk batching, diagnostic counters | P0 |
| `src/core/batch-committer.ts` | TurnLog heuristic fallback, secondary confidence check, cheap model strategy, `diagIncr` import | P1 |
| `src/core/resolve-model.ts` | Export `CHEAP_MODEL_PATTERNS` + `isCheapModel()` | P1 |
| `src/core/turn-log.ts` | `getEntries()`, `getFileCooccurrence()` | P1 |
| `src/core/analyze-diff-intent.e2e.ts` | Update E2E test for v3 prompt + JSON validation | P2 |

---

## Fallback Chain (Complete)

```
/git-agg-commit
  │
  ├─ TurnLog available?
  │   ├─ YES → isCheapModel?
  │   │         ├─ YES → Skip AI, go straight to TurnLog Heuristic
  │   │         └─ NO  → Intent-based AI (JSON prompt + few-shot)
  │   │                    │
  │   │                    ├─ SUCCESS → validateHunkCoverage() → verifyConfidence()
  │   │                    │   ├─ high   → commitIntentGroups()
  │   │                    │   ├─ medium → commitIntentGroups() + warning notify
  │   │                    │   └─ low    → fall through to heuristic
  │   │                    │
  │   │                    └─ FAIL (parse error / null) →
  │   │
  │   └─ TurnLog Heuristic (deterministic grouping)
  │              │
  │              ├─ SUCCESS → validateHunkCoverage() → commitIntentGroups()
  │              └─ FAIL (no TurnLog entries match diff) →
  │
  └─ Diff-based AI (file-level) [existing, unchanged]
            │
            ├─ SUCCESS → commitHunks()
            └─ FAIL → fallbackFileBasedHunks()
```

---

## Risk Matrix (Final)

| Risk | Likelihood | Impact | v3 Mitigation |
|------|-----------|--------|---------------|
| AI fails to follow JSON format | Medium | Medium | JSON-first with tagged-line fallback; `"Your entire response must be a single valid JSON object"` constraint; diagnostic counters |
| Few-shot examples bias model toward 1/2/3/4 groups | Low | Low | 4 diverse examples (split, merge, mixed, multi); explicit "number in examples is illustrative" + "output as many as needed" |
| TurnLog heuristic groups incorrectly | Medium | Low | Only activates when AI fails; `MIN_COOCCURRENCE=2`; all groups marked `confidence: low` |
| Heuristic produces too many commits | Medium | Low | ≤3 hunks per turn stay as one group; co-occurrence clustering reduces fragmentation |
| Intent path exceeds context window | Low | Medium | `MAX_HUNKS_PER_INTENT_BATCH=50`; cheap models skip AI entirely (P1-2) |
| "medium" confidence silently commits wrong groups | Low | Medium | `verifyConfidence()` downgrades; called AFTER `validateHunkCoverage` |
| CHEAP_MODEL_PATTERNS duplication | Low | Low | Defined once in `resolve-model.ts`, exported |
| Renamed files break heuristic matching | Low | Low | Accepted limitation; renamed files fall to catch-all |
| JSON truncation loses metadata | Low | Low | `validateHunkCoverage` catches unassigned hunks |
| Japanese prompt tokens exceed budget | Low | Low | Batching at 50 hunks prevents overflow; cheap models skip AI |

---

## Success Criteria

1. `/git-agg-commit` with cheap model produces **hunk-level commits** (not file-level)
2. AI-generated groups with `confidence: "high"` pass coverage validation
3. TurnLog heuristic fallback activates when AI fails
4. `verifyConfidence()` catches overconfident models
5. No regression for capable models
6. Japanese-language prompts produce Japanese commit messages
7. `parseLayer1_jsonPrimary` diagnostic counter shows ≥80% success rate in first release
