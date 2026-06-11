# Implementation Plan: Small Model Commit Message Quality Fix

**Date:** 2026-06-11
**Status:** Final (v3) — Ready for Implementation
**Review rounds:** 2 (3 source reviews → plan v1 → 2 plan reviews → plan v2 → 2 plan re-reviews → plan v3)
**Based on:** 3 source reviews + 4 plan reviews (v1 correctness/risks, v2 correctness/risks)

---

## Goal

Make `generateAutoCommitMessage` produce specific, useful Conventional Commit messages even when using small/cheap models (e.g., `gpt-5.4-mini`), not just large models (e.g., `deepseek-v4-pro`).

## Root Cause Summary

The current code relies on large-model capabilities (raw diff parsing, instruction following, no output chatter). Small models need: output cleanup, tighter constraints, better budget allocation, language-aware generic detection, and balanced heuristics.

---

## Phase 1: P0 Fixes (Critical — ~70 lines total)

### P0-1: Add `cleanCommitOutput()` before sanitization

**File:** `src/core/auto-commit-message.ts`
**Where:** New function, called in `generateAutoCommitMessage` before `sanitizeCommitMessage`

**What:**
- Extract from markdown fences (`` ```...``` ``, including non-ASCII info strings like `` ```コミットメッセージ ``)
- Strip common chat prefixes (English + Japanese — expanded set from plan v1)
- Strip wrapping backtick pairs (e.g., `` `feat: add login` ``)
- Take first line that matches Conventional Commit pattern
- Fall back to first non-empty line

```typescript
function cleanCommitOutput(raw: string): string {
  let text = raw.trim();

  // Layer 1: Extract from markdown fences (handles non-ASCII info strings)
  const fenceMatch = text.match(/```(?:\w*)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Layer 2: Strip common chat prefixes (English + Japanese)
  const prefixPatterns = [
    /^(?:here\s+is\s+(?:the\s+)?(?:commit\s+)?message[:\s]*)/i,
    /^(?:commit\s+message[:\s]*)/i,
    /^(?:the\s+commit\s+message\s+(?:is|should\s+be)[:\s]*)/i,
    /^(?:sure!?\s*(?:here\s+is\s+)?[:\s]*)/i,
    /^(?:提案するコミットメッセージ[:\s]*)/,
    /^(?:コミットメッセージ[:\s]*)/,
    /^(?:以下がコミットメッセージです[:\s]*)/,
    /^(?:今回のコミット[:\s]*)/,
    /^(?:以下のコミットメッセージを提案します[:\s]*)/,
    /^(?:コミットメッセージを[作成生成]しました[:\s]*)/,
    /^(?:はい[,、]\s*承知しました[。.]?\s*)/,
  ];
  for (const pat of prefixPatterns) {
    text = text.replace(pat, "").trim();
  }

  // Layer 2.5: Strip wrapping backtick pairs (e.g., `feat: add login`)
  text = text.replace(/^`([^`]+)`$/, "$1").trim();

  // Layer 3: Find first line matching Conventional Commit
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const ccLine = lines.find(l =>
    /^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\(.+?\))?!?:\s/.test(l)
  );
  if (ccLine) return ccLine;

  // Layer 4: Fall back to first non-empty line
  return lines[0] || text;
}
```

### P0-2: Reduce maxTokens from 1024 to 200

**File:** `src/core/auto-commit-message.ts`
**Where:** `generateAutoCommitMessage` → `aiComplete` call

**What:** Add `maxTokens: 200` to the `aiComplete` options. A single-line commit message needs ~30 tokens.

```diff
  const result = await aiComplete(ctx, {
    systemPrompt: getSystemPrompt(lang),
    userMessage: buildPrompt(...),
+   maxTokens: 200,
  });
```

### P0-3: Add Japanese generic message patterns

**File:** `src/core/auto-commit-message.ts`
**Where:** `GENERIC_MESSAGE_PATTERNS` array

**What:** Add Japanese patterns that detect generic messages like `fix: 修正しました`, `chore: ファイルを更新`, `feat: 機能を追加`

```typescript
const GENERIC_MESSAGE_PATTERNS: RegExp[] = [
  // English patterns (existing)
  /^chore:\s*apply\s*changes?\s*$/i,
  /^chore:\s*update\s*(files?)?\s*$/i,
  /^chore:\s*commit\s*changes?\s*$/i,
  /^chore:\s*modify\s*(files?)?\s*$/i,
  /^chore:\s*update\s+\S+\s*$/i,
  /^(feat|fix|chore|docs|style|refactor|test):\s*.{0,10}$/i,

  // Japanese patterns
  /^(feat|fix|chore|docs|style|refactor|test):\s*(変更|修正|更新|対応|追加|削除|改善|実装|作成|適用|反映|編集)(\s*(を|しました|しました。|を行いました|を実施|を反映|いたしました))?$/i,
  /^chore:\s*(変更を適用|ファイルを更新|更新しました|修正しました)\s*$/i,
];
```

### P0-4: Rebalance assistant vs diff budget (gated on model capability)

**File:** `src/core/auto-commit-message.ts`
**Where:** `buildPrompt` function, budget constants

**What:** Increase assistant budget (the most valuable signal for small models), decrease diff budget — **only for small models**. Large models retain the original diff-heavy allocation.

**Shared module-scope constant** (consolidated — also used by P1-3):
```typescript
// Module-scope: single source of truth for cheap model detection
const CHEAP_MODEL_PATTERNS = [
  /mini/i, /flash/i, /nano/i, /lite/i, /small/i, /haiku/i,
];
```

```typescript
function getBudgetMultiplier(modelId: string | undefined): "small" | "large" {
  if (!modelId) return "small"; // unknown model → conservative
  return CHEAP_MODEL_PATTERNS.some((p) => p.test(modelId)) ? "small" : "large";
}
```

Then in `buildPrompt`:
```typescript
function buildPrompt(
  userMessages: string[],
  assistantMessages: string[],
  changedFiles: string[],
  diff: string,
  lang: string,
  modelId?: string,  // NEW parameter
): string {
  const budget = getBudgetMultiplier(modelId);
  const MAX_USER_CHARS = 1500;
  const MAX_ASSISTANT_CHARS = budget === "small" ? 2500 : 600;
  const MAX_FILES_CHARS = 500;
  const MAX_DIFF_CHARS = budget === "small" ? 3000 : 5000;
  // ... rest unchanged
```

**Caller update:** `generateAutoCommitMessage` imports `resolveModel` from `"./resolve-model.js"`, resolves the model **before** the `aiComplete` call, and passes `resolveModel(ctx)?.id` to `buildPrompt`. This uses the same resolution path as `aiComplete` (consistent with P1-3):

```typescript
// In generateAutoCommitMessage, BEFORE aiComplete:
const modelId = resolveModel(ctx)?.id;

const result = await aiComplete(ctx, {
  systemPrompt: getSystemPrompt(lang),
  userMessage: buildPrompt(
    userMessages, assistantMessages, changedFiles, diff, lang,
    modelId,  // resolved synchronously, same model aiComplete will use
  ),
  maxTokens: 200,
});
```

### P0-5: Fix newest-first budget consumption

**File:** `src/core/auto-commit-message.ts`
**Where:** `buildPrompt` function, user/assistant section loops

**What:** Remove `reverse()` calls. Process `userMessages` and `assistantMessages` newest-first so the most recent (most relevant) messages survive truncation.

```diff
- for (const msg of userMessages.reverse()) {
+ for (const msg of userMessages) {
      if (userBudget <= 0) break;
      const truncated = truncate(msg, userBudget);
      userLines.push(truncated);
      userBudget -= truncated.length;
  }
- const userStr = userLines.reverse().join("\n---\n");
+ const userStr = userLines.join("\n---\n");
```

Same pattern for assistant section.

---

## Phase 2: P1 Fixes (High Impact — ~95 lines total)

### P1-1: Move few-shot examples into system prompt

**Files:** `src/i18n/messages.ts`, `src/core/auto-commit-message.ts`

**What:** Embed examples directly in `autoCommitMsg.systemPrompt` for both `en` and `ja`. Remove `{examples}` from `buildPrompt` template. This gives small models behavioral anchors before processing the noisy user content.

**English system prompt (new):**
```
You are a commit message generator. From the following information, understand what changes were made and generate a single Conventional Commit message.

The GIT DIFF is the most reliable source of what actually changed. Use it as the primary driver for the commit message. The user's request provides intent, and the assistant's response and changed files list are supplementary.

Rules:
- Choose type from: feat, fix, docs, style, refactor, test, chore
- Write the subject in English
- Keep subject under 50 characters
- Use imperative mood
- Include scope only if clearly inferable from the diff

Examples:
User: "Add a login form to the auth page" | Files: src/auth/login.tsx, src/auth/api.ts
→ feat(auth): add login form

User: "Fix the null pointer error in the payment flow" | Files: src/payment/processor.ts
→ fix(payment): add null check in processor

Return ONLY the commit message string. No explanations or code fences.
```

**Japanese system prompt (new):**
```
あなたはコミットメッセージ生成ツールです。以下の情報から、どのような変更が行われたかを読み取り、Conventional Commit メッセージを1つ生成してください。

GIT DIFF は実際に何が変更されたかを示す最も信頼できる情報源です。これを主軸にコミットメッセージを決定してください。ユーザーのリクエストは変更の意図を、アシスタントの応答と変更ファイル一覧は補完情報です。

ルール:
- type は feat, fix, docs, style, refactor, test, chore から選択
- サブジェクトは必ず日本語で記述する
- サブジェクトは50文字以内
- 命令形を使用する
- スコープは推測できる場合のみ含める

例:
ユーザーの依頼: 「認証ページにログインフォームを追加して」 | 変更ファイル: src/auth/login.tsx, src/auth/api.ts
→ feat(auth): ログインフォームを追加

ユーザーの依頼: 「支払いフローのnullポインタエラーを修正して」 | 変更ファイル: src/payment/processor.ts
→ fix(payment): nullチェックを追加

返答はメッセージ文字列のみ。説明やコードフェンスは不要。
```

**`buildPrompt` change:** Remove `{examples}` placeholder from `autoCommitMsg.buildPrompt` templates in both en and ja. Remove the `examples` variable and `t(lang, "autoCommitMsg.examples", ...)` call from `buildPrompt()`.

### P1-2: Balance `specificityScore` weights for Japanese

**File:** `src/core/auto-commit-message.ts`
**Where:** `specificityScore` function

**What:** Increase Japanese scoring weights to parity with English scoring. This is intentionally placed before P1-3 because P1-3's heuristic fallback depends on these scores.

```diff
  if (lang === "ja") {
    const kanjiCount = (m.match(/[\u4e00-\u9faf]/g) || []).length;
-   score += Math.min(kanjiCount, 10) * 0.5;
+   score += Math.min(kanjiCount, 15) * 1.0;

    const katakanaTerms = m.match(/[\u30a0-\u30ff]{2,}/g) || [];
-   score += katakanaTerms.length * 2;
+   score += katakanaTerms.length * 3;

+   // Reward Japanese concrete verbs (parallel to English concreteVerbs)
+   const japaneseConcreteVerbs = /(追加|実装|作成|削除|修正|改善|整理|統合|分割|移行|更新|導入|廃止|対応|設定|構成|接続)/g;
+   score += (m.match(japaneseConcreteVerbs) || []).length * 2;

+   // Penalize Japanese generic filler (only at word boundaries)
+   const japaneseGenericWords = /(変更|修正|更新|対応|適用|反映)(?!\S)/g;
+   const jpGenericCount = (m.match(japaneseGenericWords) || []).length;
+   score -= jpGenericCount * 2;

-   if (/^(変更|修正|更新|対応|追加|削除|改善|実装|作成)$/.test(m.trim())) {
+   if (/^(変更|修正|更新|対応|追加|削除|改善|実装|作成|適用|反映)$/.test(m.trim())) {
      score -= 4;
    }
  }
```

### P1-3: Skip AI comparison for known-weak models

**File:** `src/core/auto-commit-message.ts`
**Where:** `refineMessageIfGeneric` function

**What:** After heuristic quick-guard fails, check if the **actual AI model** (resolved via `resolveModel`) is known-weak. If so, skip the AI comparison call and use the higher heuristic score (which was balanced in P1-2).

Uses the **consolidated module-scope `CHEAP_MODEL_PATTERNS`** (same as P0-4):

```typescript
// Top of file: import resolveModel (also used by P0-4)
import { resolveModel } from "./resolve-model.js";

// CHEAP_MODEL_PATTERNS defined at module scope (shared with P0-4)

function isCheapModel(modelId: string): boolean {
  return CHEAP_MODEL_PATTERNS.some((p) => p.test(modelId));
}
```

Then in `refineMessageIfGeneric`, after heuristic quick-guard:
```typescript
// Skip AI comparison for known-weak models — their judgment is unreliable
const model = resolveModel(ctx);
if (model && isCheapModel(model.id)) {
  return userScore > genScore ? userCandidate : generatedMessage;
}
```

### P1-4: Robust vote parsing with last-wins tiebreaker

**File:** `src/core/auto-commit-message.ts`
**Where:** `refineMessageIfGeneric` function, vote parsing section

**What:** When the model outputs both "A" and "B" (e.g., "Both A and B are good, but B is better"), pick the one that appears last.

```diff
  const voteA = /\bA\b/i.test(text) && !/\bB\b/i.test(text);
  const voteB = /\bB\b/i.test(text) && !/\bA\b/i.test(text);
  if (voteA) return generatedMessage;
  if (voteB) return userCandidate;

+ // Both appear — pick the one mentioned last ("Both are good, but B wins")
+ const aPos = text.search(/\bA\b/i);
+ const bPos = text.search(/\bB\b/i);
+ if (aPos >= 0 && bPos >= 0) {
+   return bPos > aPos ? userCandidate : generatedMessage;
+ }
```

### P1-5: Add file-path-based type hints (NEW — from plan review feedback)

**File:** `src/core/auto-commit-message.ts`
**Where:** `buildPrompt` function

**What:** Reuse `inferTypeFromFiles` from `commit-message.ts` to generate type hints, similar to `buildTypeHint()` in `diff-analyzer.ts`. This gives small models explicit guidance about the likely commit type.

```typescript
import { inferTypeFromFiles } from "./commit-message.js";

function buildTypeHintForMessage(files: string[]): string {
  const type = inferTypeFromFiles(files);
  if (type === "chore") return ""; // skip if generic — let the AI decide
  return `Hint: based on file paths, the likely commit type is "${type}".\n`;
}
```

Prepend to user prompt in `buildPrompt()`:
```typescript
const typeHint = buildTypeHintForMessage(changedFiles);
const prompt = t(lang, "autoCommitMsg.buildPrompt", { ... });
return (typeHint + prompt);
```

---

## Phase 3: P2 Follow-ups (Lower Priority)

### P2-1: Newline-boundary diff truncation
Align auto-commit-message's diff truncation with diff-analyzer's approach (cut at line boundaries, not space boundaries). Currently `truncate()` uses space-boundary which can break diff syntax mid-line. Reuse or replicate `truncateDiff()` from diff-analyzer.

### P2-2: English conversational markers in `isValidCommitSubject`
Add English guard patterns (e.g., `can you`, `could you`, `I'd like`). Currently the function always returns `true` for non-Japanese languages.

### P2-3: Unit tests
Add tests for `isGenericMessage` (including Japanese patterns), `sanitizeCommitMessage`, `specificityScore` (Japanese vs English parity), `userMessageToCandidate`, `isValidCommitSubject`, and `cleanCommitOutput`.

### P2-4: Defense-in-depth first-line extraction in `sanitizeCommitMessage`
Add `const firstLine = message.split("\n")[0].trim()` at the top of `sanitizeCommitMessage` to protect future callers from multi-line input. Not needed for current callers (all go through `cleanCommitOutput` first) but low-cost safety net.

---

## Files Changed

| File | Phase | Changes |
|------|-------|---------|
| `src/core/auto-commit-message.ts` | P0+P1 | ~130 lines added/modified |
| `src/i18n/messages.ts` | P1 | ~30 lines (system prompt rewrite for en + ja; remove {examples} from buildPrompt) |
| `src/core/commit-message.ts` | P2-4 (optional) | 1 line |

## Risks

| Risk | Mitigation | Status |
|------|-----------|--------|
| Budget rebalance reduces diff context for large models | P0-4 now gated on `getBudgetMultiplier()` — large models keep original 5000-char diff budget | ✅ Mitigated |
| Japanese generic patterns may false-positive on specific messages | Patterns require exact body match on short generic phrases + optional polite endings. Compound phrases like `削除機能を追加` do NOT match because `機能を追加` doesn't equal the pattern's optional group. | ✅ Low risk |
| `cleanCommitOutput` may strip valid content | Layer 3 (find CC line by regex) is the primary extractor; prefix patterns are anchored at `^` and conservative. Layer 2.5 backtick stripping only removes wrapping pairs. | ✅ Low risk |
| `isCheapModel` heuristic misses some small models (7-9B without marketing names) | Consequence is mild: AI comparison is still attempted (not skipped). If the comparison fails, the existing heuristic fallback handles it. Future: use model metadata when available. | ✅ Acceptable |
| `resolveModel(ctx)` in P1-3 may not match P0-4's `result?.model?.id` | P0-4 and P1-3 both use `resolveModel(ctx)?.id` — same resolution path as `aiComplete`. `CHEAP_MODEL_PATTERNS` consolidated at module scope. | ✅ Consistent |
| Removing `reverse()` changes display order | Newest-first is actually better — most recent context displayed first, with older context trailing off at budget limit. | ✅ Improvement |

## Validation

After implementation, test with:
1. **English + deepseek-v4-pro**: Should produce same or better messages (no regression — keeps original budget)
2. **English + gpt-5.4-mini**: Should produce specific messages instead of "chore: apply changes"
3. **Japanese + deepseek-v4-pro**: Should produce same or better (no regression)
4. **Japanese + gpt-5.4-mini**: Should produce specific Japanese messages; generic ones caught and refined
5. **Chatty output simulation**: Add "Here is the commit message:" prefix or ``` ``` fences to AI output, verify `cleanCommitOutput` strips them
6. **Backtick-wrapped output**: Verify `` `feat: add login` `` is properly unwrapped
7. **Japanese fence output**: Verify `` ```コミットメッセージ\nfeat: ログインを追加\n``` `` is properly extracted
8. **Non-cheap model budget**: Verify deepseek-v4-pro still gets original 600/5000 budget
