# Implementation Plan: Intent-based Hunk Split Robustness for Cheap Models

**Date:** 2026-06-14
**Status:** Draft — Pending Review
**Based on:** Codebase analysis of `diff-analyzer.ts`, `batch-committer.ts`, `turn-log.ts`, `i18n/messages.ts`

---

## Problem Statement

### Current State

`/git-agg-commit` has two analysis paths:

| Path | Module | Granularity | Trigger Condition |
|------|--------|-------------|-------------------|
| **Intent-based** | `analyzeDiffIntent()` | Per-hunk (`@@` block level) — partial-file staging via `stageDiffHunks` | TurnLog available + AI returns parsable response |
| **Diff-based fallback** | `analyzeDiff()` | Per-file level — whole-file staging via `stageFiles` | TurnLog empty OR intent-based fails |

The intent-based path is architecturally correct — it parses diffs into individual `@@` hunks, numbers them `[H1]..[HN]`, sends them with conversation context to the AI, and groups hunks into commits. It even supports partial-file staging via `git apply --cached`.

**The problem**: The intent-based path almost always fails, causing the diff-based fallback to take over, which only produces 1-commit-per-file output. The root cause is a **severely under-specified AI prompt**.

### Why the Intent-Based Prompt Fails

The current `intentSystemPrompt` (i18n key `diffAnalyzer.intentSystemPrompt`):

```
Group numbered hunks [H1]..[HN] into commits.

Output tagged lines only, starting with OVERALL:, then COMMIT:/HUNKS:/CONF:
blocks separated by blank lines. No other text.
```

Issues:
1. **No few-shot examples** — cheap models need concrete examples to anchor behavior
2. **No Japanese localization** — `intentSystemPrompt` and `intentBuildPrompt` have no `ja` variants
3. **Custom tagged-line format** — not JSON, hard for cheap models; evidenced by 3 fallback parsers (tagged → JSON → heuristic) in `parseHunkGroupingResult`
4. **No decision rules** — doesn't explain how to use conversation context vs. diff structure
5. **No confidence guidance** — no explanation of when to assign `high`/`medium`/`low`
6. **No quality prohibitions** — diff-based prompt has explicit "NEVER generate" rules; intent-based has none
7. **Terse prompt** — 2 lines vs. 20+ lines for the diff-based prompt

### Empirical Evidence

- `parseHunkGroupingResult` has **three** parsing fallback strategies (tagged, JSON, heuristic) — the format is inherently fragile
- `batchCommit` falls through to `commitDiffBasedHunks` whenever `overallConfidence === "low"` — which is likely the common case with cheap models
- The E2E test (`analyze-diff-intent.e2e.ts`) only tests mock responses, not real AI output quality

---

## Proposed Solution

Strengthen the intent-based path at three levels:

### Level 1: Prompt Engineering (Core Fix)
Rewrite both `intentSystemPrompt` and `intentBuildPrompt` with few-shot examples, Japanese localization, explicit rules, and JSON output format.

### Level 2: TurnLog Heuristic Fallback (New Middle Layer)
When AI-based intent analysis fails or returns low confidence, use deterministic TurnLog data (file co-occurrence per turn) to group diff hunks before falling back to diff-based file-level analysis.

### Level 3: Cheap Model Detection (Optional Enhancement)
Detect cheap models by pattern matching and adjust strategy: skip AI grouping entirely, use TurnLog heuristics for grouping, and use AI only for commit message generation.

---

## Implementation Items

### P0-1: Rewrite `intentSystemPrompt` with Few-Shot Examples

**File:** `src/i18n/messages.ts`
**Keys affected:** `diffAnalyzer.intentSystemPrompt` (en), new `ja` variant

**Current (en, 2 lines):**
```
Group numbered hunks [H1]..[HN] into commits.

Output tagged lines only, starting with OVERALL:, then COMMIT:/HUNKS:/CONF: blocks separated by blank lines. No other text.
```

**Target (en, ~40 lines):**
```
You are a commit decomposition engine. Group numbered diff hunks [H1]..[HN] into logical commits based on conversation history AND diff structure.

Each commit group represents ONE logical change (e.g., "add validation", "fix typo"). A single file can be split across multiple commits if different hunks serve different purposes.

GUIDING RULES:
1. **Conversation intent is primary for grouping.** Hunks created by the same user request → same group.
2. **Diff structure is primary for verification.** If the conversation mentions a change not in the diff, ignore it. If the diff contains changes not in the conversation, group them separately.
3. **File co-occurrence matters.** Files changed together in the same conversation turn are likely related.
4. **One file can split.** Different @@ hunks in the same file may belong to different logical changes — split them when the conversation context supports it.

CONFIDENCE LEVELS:
- "high": All hunks in this group clearly correspond to specific conversation turns.
- "medium": Most hunks mapped; some grouping inferred from file proximity or diff structure.
- "low": This group contains primarily unexplained changes (catch-all for diff-only hunks).

MESSAGE FORMAT:
- Conventional Commits: type(scope): subject
- Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build, revert
- Subject: imperative mood, ≤50 characters
- Language: match the conversation's primary language (Japanese if the user requests are in Japanese)
- Scope: include only if clearly inferable from file paths or conversation context

FORBIDDEN MESSAGES (NEVER generate):
- "chore: apply changes" / "chore: update files" / "chore: modify files"
- "feat: 機能を追加" / "fix: 修正しました" / "chore: 変更を適用"
- Any message consisting only of generic verbs without specific references to what changed
- Any message using words that appear nowhere in the DIFF or the CONVERSATION

EXAMPLES:
Input: Turn 1 added login.ts+api.ts. Turn 2 added validation.ts and updated login.ts.
Diff hunks: [H1] login.ts: added form component, [H2] api.ts: added API client, [H3] login.ts: added validation import, [H4] validation.ts: new file
Output:
{
  "overallConfidence": "high",
  "groups": [
    {"hunks": [1, 2], "message": "feat(auth): add login form and API client", "confidence": "high", "turnIndices": [1]},
    {"hunks": [3, 4], "message": "feat(auth): add email validation", "confidence": "high", "turnIndices": [2]}
  ]
}

Input: User asked to fix README typo. Diff shows README.md (typo fix) AND package.json (version bump, not mentioned).
Diff hunks: [H1] README.md: typo fix, [H2] package.json: version bump
Output:
{
  "overallConfidence": "medium",
  "groups": [
    {"hunks": [1], "message": "docs: fix typo in README", "confidence": "high", "turnIndices": [1]},
    {"hunks": [2], "message": "chore: bump version to 2.0.0", "confidence": "low", "note": "No conversation context found for this change"}
  ]
}

Return ONLY a valid JSON object. No code fences, no explanations.
```

**Japanese variant (new, ~35 lines):**
```
あなたはコミット分解エンジンです。会話履歴とdiff構造に基づいて、番号付きdiff hunk [H1]..[HN] を論理的なコミットにグループ化してください。

各コミットグループは1つの論理的な変更を表します（例：「バリデーションを追加」「誤字を修正」）。1つのファイルが異なる目的のhunkを含む場合、複数のコミットに分割できます。

グルーピングルール:
1. **会話の意図がグループ化の主軸。** 同じユーザー依頼から生まれたhunk → 同じグループ。
2. **diff構造が検証の主軸。** 会話で言及されたがdiffにない変更は無視。diffにあるが会話で説明できない変更は別グループに。
3. **ファイルの共起関係を重視。** 同じ会話ターンで一緒に変更されたファイルは関連性が高い。
4. **1ファイルの分割を許容。** 同じファイル内の異なる@@ hunkが異なる論理的変更に属する場合は分割する。

信頼度:
- "high": グループの全hunkが特定の会話ターンに明確に対応。
- "medium": 大部分のhunkがマッピング済み。一部はファイル近接性やdiff構造から推論。
- "low": 主に説明不能な変更の寄せ集め（diff-onlyのhunk用）。

メッセージ形式:
- Conventional Commits: type(scope): subject
- サブジェクトは必ず日本語で、50文字以内、命令形。
- スコープはファイルパスか会話文脈から明確に推測できる場合のみ含める。

禁止メッセージ（絶対に生成しない）:
- 「変更を適用」「ファイルを更新」「修正しました」「機能を追加」
- 汎用動詞のみで具体的な変更内容に言及していないメッセージ
- GIT DIFF や会話ログに現れていない単語だけを使ったメッセージ

例:
[日本語の例: Turn1でlogin.ts+api.ts追加、Turn2でvalidation.ts追加とlogin.ts更新 → 2グループに分割]

有効なJSONオブジェクトのみを返してください。コードフェンスや説明は不要です。
```

### P0-2: Change Output Format from Tagged-Line to JSON

**Files:** `src/core/diff-analyzer.ts` (prompt + parser), `src/types.ts`

**Rationale:**
- Tagged-line format requires 3 fallback parsers → fragile
- JSON is natively supported by cheap models (they're fine-tuned on it)
- `parseHunkGroupingResult` already has a JSON fallback parser — just make it primary

**Changes:**

1. **Types** (`src/types.ts`): No changes needed — `HunkGroupingResult` already uses JSON-compatible structure

2. **System prompt** (P0-1 above): Output format changed from tagged-line to JSON

3. **Parser** (`parseHunkGroupingResult` in `diff-analyzer.ts`): 
   - Make `tryParseJSONFormat` the **primary** parser (swap with `tryParseTaggedFormat`)
   - Keep `tryParseTaggedFormat` as **fallback** for backward compatibility
   - Simplify `tryParseHeuristic` to be a last resort

4. **User prompt** (`intentBuildPrompt` / `diffAnalyzer.intentBuildPrompt`): 
   - Add explicit JSON format instruction
   - Include a minimal JSON schema hint in the prompt

**Prompt additions:**
```json
// Expected JSON structure:
{
  "overallConfidence": "high" | "medium" | "low",
  "groups": [
    {
      "hunks": [1, 2],           // DiffHunk globalIndex values
      "message": "feat(scope): subject",
      "confidence": "high" | "medium" | "low",
      "turnIndices": [1, 2],     // Optional: corresponding TurnLog turn indices
      "note": "explanation"      // Optional: reason for low confidence
    }
  ]
}
```

### P0-3: Add Japanese Localization for Intent Prompts

**File:** `src/i18n/messages.ts`

Add `ja` entries for:
- `diffAnalyzer.intentSystemPrompt` (currently only `en`)
- `diffAnalyzer.intentBuildPrompt` (currently only `en`)

### P0-4: Increase `MAX_OUTPUT_TOKENS` for Intent Analysis

**File:** `src/core/diff-analyzer.ts`

**Current:** `const MAX_OUTPUT_TOKENS = 2048;`

**Change:** Increase to `4096` for the intent analysis path only. JSON with multiple groups, confidence levels, turn indices, and notes can easily exceed 2048 tokens for large diffs. The diff-based path stays at 2048 (simpler output).

```typescript
const MAX_OUTPUT_TOKENS_INTENT = 4096; // For intent-based analysis (richer output)
```

Used in `analyzeDiffIntent` → `aiComplete` call.

### P1-1: Add TurnLog Heuristic Fallback Layer

**File:** `src/core/batch-committer.ts` (or new `src/core/turnlog-heuristic.ts`)

**What:** When `analyzeDiffIntent` returns null (AI parsing failed), before falling back to `analyzeDiff` (file-based), try a deterministic grouping using TurnLog data.

**Algorithm:**
```typescript
function buildGroupsFromTurnLog(
  diffHunks: DiffHunk[],
  turnLog: TurnEntry[],
): CommitGroup[] {
  // 1. Build file → turn-index mapping from TurnLog entries
  //    (most recent turn wins for files modified multiple times)
  const fileToTurn = new Map<string, number>();
  for (const entry of [...turnLog].reverse()) {
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

  // 3. Split same-turn hunks further by file co-occurrence
  //    (files changed together across ALL turns are likely related)
  const filePairs = computeFileCooccurrence(turnLog);
  
  const groups: CommitGroup[] = [];
  for (const [, hunks] of turnGroups) {
    if (hunks.length <= 3) {
      // Small enough to keep as one group
      groups.push(makeGroup(hunks, "medium"));
    } else {
      // Sub-group by file co-occurrence clusters
      const subGroups = clusterByCooccurrence(hunks, filePairs);
      groups.push(...subGroups.map(h => makeGroup(h, "low")));
    }
  }

  // 4. Unassigned hunks get their own catch-all group
  if (unassigned.length > 0) {
    groups.push({
      hunks: unassigned.map(h => ({ globalIndex: h.globalIndex, file: h.file })),
      message: "chore: 会話ログ未対応の変更を適用",
      confidence: "low",
      note: "TurnLogに記録のない変更（人手編集の可能性）",
    });
  }

  return groups;
}
```

**Integration point in `batchCommit`:**
```typescript
// After intent analysis fails:
if (!intentResult) {
  // Try TurnLog heuristic before falling back to diff-based
  if (turnLogText) {
    const diffHunks = parseDiffHunks(diff);
    const heuristicGroups = buildGroupsFromTurnLog(diffHunks, turnLog.entries);
    if (heuristicGroups.length > 0) {
      const validated = validateHunkCoverage(heuristicGroups, diffHunks.length);
      // Use heuristic groups + cheap-model commit message generation
      result = await commitHeuristicGroups(pi, ctx, validated, diffHunks, diff, lang, isReview);
    }
  }
}
// Only then fall back to diff-based:
if (!result) {
  result = await commitDiffBasedHunks(...);
}
```

**Commit message generation for heuristic groups:** Each group gets a message generated by the existing `generateAutoCommitMessage` (which already has P0 cheap-model improvements per the `commit-msg-small-model-fix` plan). This is cheaper than the full `analyzeDiff` call because:
- Grouping is deterministic → no AI call for splitting
- Only message generation uses AI → 1 call per group (vs. 1 call for all files in `analyzeDiff`)
- Message generation is the path that already has cheap-model fixes

### P1-2: Add Cheap Model Detection

**Files:** `src/core/batch-committer.ts`, `src/core/resolve-model.ts`

Use the same `CHEAP_MODEL_PATTERNS` approach from the `commit-msg-small-model-fix` plan:

```typescript
const CHEAP_MODEL_PATTERNS = [
  /mini/i, /flash/i, /nano/i, /lite/i, /small/i, /haiku/i,
];

function isCheapModel(modelId: string | undefined): boolean {
  if (!modelId) return true; // unknown → conservative
  return CHEAP_MODEL_PATTERNS.some((p) => p.test(modelId));
}
```

**Strategy adjustment for cheap models:**
```typescript
const model = resolveModel(ctx);
if (isCheapModel(model?.id) && turnLogText) {
  // Skip intent-based AI grouping entirely — use TurnLog heuristics
  // Use AI only for per-group commit message generation
  const groups = buildGroupsFromTurnLog(parseDiffHunks(diff), turnLog.entries);
  result = await commitHeuristicGroups(pi, ctx, groups, ...);
} else {
  // Full pipeline for capable models
  // ... existing intent-based → fallback → diff-based flow
}
```

### P1-3: Add File Co-occurrence Analysis to TurnLog

**File:** `src/core/turn-log.ts`

Add a utility method to compute file co-occurrence scores from TurnLog data:

```typescript
/**
 * Compute file co-occurrence scores from TurnLog entries.
 * Returns a Map of file pair → co-occurrence count.
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

This is used by P1-1's `clusterByCooccurrence` to sub-group hunks within a turn.

### P2-1: Remove Deprecated Tagged-Line Parser (After Stabilization)

**File:** `src/core/diff-analyzer.ts`

After JSON-first parsing is proven stable in production, remove `tryParseTaggedFormat` and `tryParseHeuristic` to simplify the codebase. Keep the JSON parser only. This is a cleanup item — not for initial implementation.

### P2-2: Add E2E Test with Real AI Responses

**File:** `src/core/analyze-diff-intent.e2e.ts`

Update the E2E test to:
1. Call a real AI model (if available) with the new prompt
2. Validate that the response is valid JSON
3. Validate that all hunks are assigned
4. Validate that confidence levels are assigned
5. Compare intent-based output with diff-based output

---

## Files Changed

| File | Changes | Priority |
|------|---------|----------|
| `src/i18n/messages.ts` | Rewrite `intentSystemPrompt` (en), add `ja`; rewrite `intentBuildPrompt` (en), add `ja` | P0 |
| `src/core/diff-analyzer.ts` | Swap parser priority (JSON → primary), increase `MAX_OUTPUT_TOKENS` for intent path, simplify fallback parsers | P0 |
| `src/core/batch-committer.ts` | Add TurnLog heuristic fallback layer, cheap model detection + strategy adjustment | P1 |
| `src/core/turn-log.ts` | Add `getFileCooccurrence()` method | P1 |
| `src/core/analyze-diff-intent.e2e.ts` | Update E2E test with real AI response validation | P2 |

**No new files needed.** All changes are modifications to existing files.

---

## Migration & Compatibility

| Concern | Handling |
|---------|----------|
| Tagged-line format responses from existing AI models | `tryParseTaggedFormat` kept as fallback in Phase 1; removed in P2-1 cleanup |
| Diff-based path still exists | Unchanged — it's the last-resort fallback |
| No TurnLog data | `buildGroupsFromTurnLog` returns empty → falls through to existing diff-based path |
| Large diffs (>FILES_PER_BATCH) | Intent-based path already processes whole diff; batching only applies to diff-based fallback |
| Existing tests | `parseHunkGroupingResult` test coverage needs update for JSON-first; rest unchanged |

---

## Validation Plan

### Unit Tests
1. `parseHunkGroupingResult` with valid JSON input → returns correct `HunkGroupingResult`
2. `parseHunkGroupingResult` with tagged-line input (backward compat) → still works
3. `buildGroupsFromTurnLog` with sample TurnLog entries → correct turn grouping
4. `getFileCooccurrence` → correct pair counts
5. `isCheapModel` → correctly identifies cheap/expensive models

### Integration Tests
1. E2E test with mock TurnLog + mock diff → validates JSON format parsing
2. (Optional) E2E test with real AI → validates prompt quality

### Manual Testing
1. Run `/git-agg-commit` with cheap model (e.g., `gpt-5.4-mini`) → verify hunks are properly split
2. Run `/git-agg-commit` with capable model → verify no regression
3. Run with empty TurnLog → verify falls through to diff-based correctly
4. Run with `--review` → verify review UI works with intent-based groups
5. Run with Japanese language → verify Japanese commit messages

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| AI fails to follow JSON format (same as tagged-line) | Medium | Medium | JSON is more widely supported; keep tagged-line as fallback during transition |
| Few-shot examples bias AI toward example patterns | Low | Low | Examples cover diverse scenarios (multi-turn, unexplained hunks, mixed confidence) |
| TurnLog heuristic grouping is too aggressive (splits too much) | Medium | Low | Only activates when AI fails; uses conservative thresholds |
| Cheap model message generation still produces generic messages | Medium | Medium | The P0 cheap-model fixes from `commit-msg-small-model-fix` plan already address this |
| `MAX_OUTPUT_TOKENS` increase causes longer response time | Low | Low | 4096 is reasonable; intent analysis runs once, not per-turn |
| Japanese prompt causes worse output for English-only models | Low | Low | Language-selection follows `getLanguage(ctx.cwd)`; user can override with `--lang` |

---

## Success Criteria

1. `/git-agg-commit` with cheap model (e.g., `gpt-5.4-mini`) produces **hunk-level commits** (not file-level) for multi-hunk-per-file scenarios
2. AI-generated groups with `confidence: "high"` are valid (no hunk overlap, no missing hunks)
3. TurnLog heuristic fallback activates when AI fails and produces reasonable groupings
4. No regression for capable models (e.g., `claude-sonnet-4`)
5. Japanese-language prompts produce Japanese commit messages
