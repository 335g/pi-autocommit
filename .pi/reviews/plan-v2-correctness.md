Now I have all the information needed. Let me compile the comprehensive review.

---

## Review: Plan v2 Correctness Re-Review

**Date:** 2026-06-12
**Reviewed plan:** `.pi/plans/commit-msg-small-model-fix.md` (v2)
**Basis:** Comparison against v1 plan review findings, source code tracing, and the actual call flow in `src/core/ai.ts` and `src/core/auto-commit-message.ts`.

---

### Question 1: P0-4 model gate — `getBudgetMultiplier(modelId)` + `result?.model?.id`

**Verdict:** 🔴 Blocker — `result?.model?.id` is not available at the call site.

The plan states:

> **Caller update:** `generateAutoCommitMessage` passes `result?.model?.id` (the actual model used).

But tracing the actual source (`src/core/auto-commit-message.ts` lines 383–391):

```typescript
const result = await aiComplete(ctx, {
  systemPrompt: getSystemPrompt(lang),
  userMessage: buildPrompt(             // ← buildPrompt evaluated FIRST
    userMessages,
    assistantMessages,
    changedFiles,
    diff,
    lang,
  ),
});
// result exists only AFTER the await completes
```

`buildPrompt(...)` is evaluated as an argument to `aiComplete(...)`. JavaScript evaluates arguments *before* the function call. `result` does not exist at the time `buildPrompt` needs `modelId`. This is a **temporal dependency error** — you cannot pass `result?.model?.id` into a function whose return value determines the arguments to the call that produces `result`.

**Correct fix:** Compute the model *before* the `aiComplete` call using `resolveModel(ctx)`, exactly as P1-3 already does. Since `aiComplete` internally calls `resolveModel(ctx)` (see `src/core/ai.ts` line 33), pre-computing it with the same function guarantees consistency:

```typescript
// Correct approach (consistent with P1-3):
const resolvedModel = resolveModel(ctx);
const result = await aiComplete(ctx, {
  systemPrompt: getSystemPrompt(lang),
  userMessage: buildPrompt(
    userMessages, assistantMessages, changedFiles, diff, lang,
    resolvedModel?.id,   // ← available before aiComplete runs
  ),
});
```

This requires importing `resolveModel` from `"./resolve-model.js"` in `auto-commit-message.ts` (same import path P1-3 already uses).

---

### Question 2: P1-3 model detection — `resolveModel(ctx)`

**Verdict:** ✅ Correct.

The plan's v2 code:
```typescript
import { resolveModel } from "./resolve-model.js";
// ...
const model = resolveModel(ctx);
if (model && isCheapModel(model.id)) { ... }
```

Tracing through `src/core/resolve-model.ts` lines 22–53: `resolveModel(ctx)` first checks the configured `analysis_model` setting, then falls back to `ctx.model`. This is the **exact same resolution path** that `aiComplete` uses internally (`src/core/ai.ts` line 33). The import path `"./resolve-model.js"` matches the file location (`src/core/resolve-model.ts`). ✅

---

### Question 3: P1-5 type hints — `inferTypeFromFiles` existence and behavior

**Verdict:** ✅ Correct, with one note.

`inferTypeFromFiles` exists at `src/core/commit-message.ts` lines 54–74. The plan imports it:
```typescript
import { inferTypeFromFiles } from "./commit-message.js";
```

The wrapper function `buildTypeHintForMessage` correctly returns `""` for `"chore"` type (generic, let the AI decide) and a hint string otherwise. Prepending via `return (typeHint + prompt)` in `buildPrompt()` is correct string concatenation.

**Note:** The plan says to "prepend to user prompt in `buildPrompt()`", but after P1-1, `{examples}` is removed from the template. The hint insertion is therefore `typeHint + structuredPrompt`, which is fine. However, the plan doesn't explicitly address ordering between P1-1 and P1-5 — if P1-5 is implemented before P1-1, `{examples}\n\n` would appear between the hint and the structured prompt sections. Low risk either way, but P1-1 should logically precede P1-5.

---

### Question 4: P0-1 expanded prefix patterns — edge cases from risk review

**Verdict:** ✅ All addressed.

The v1 risk review (`plan-risks.md`, Section 2d & 2e) identified these gaps:

| Gap | v1 Plan | v2 Plan | Status |
|-----|---------|---------|--------|
| Backtick-wrapped output (`` `feat: add login` ``) | Missing | Layer 2.5: `text.replace(/^`([^`]+)`$/, "$1")` | ✅ Added |
| `今回のコミット:` preamble | Missing | `/^(?:今回のコミット[:\s]*)/` | ✅ Added |
| `以下のコミットメッセージを提案します` preamble | Missing | `/^(?:以下のコミットメッセージを提案します[:\s]*)/` | ✅ Added |
| `コミットメッセージを[作成/生成]しました` variants | Missing | `/^(?:コミットメッセージを[作成生成]しました[:\s]*)/` | ✅ Added |
| `はい、承知しました。` acknowledgment | Missing | `/^(?:はい[,、]\s*承知しました[。.]?\s*)/` | ✅ Added |

All five edge cases from the risk review are now covered. The backtick stripping uses `$1` capture group (not a `g` flag replacement of both `^``` and `` `$``, which is more precise). ✅

---

### Question 5: P1 ordering — P1-2 before P1-3

**Verdict:** ✅ Correctly reordered.

The v2 plan explicitly states:
> P1-2: Balance `specificityScore` weights for Japanese. This is intentionally placed before P1-3 because P1-3's heuristic fallback depends on these scores.

The v1 plan correctness review had flagged: "P1-2 (specificityScore) should be implemented before P1-3 (skip AI comparison), since P1-3's heuristic fallback depends on the scoring that P1-2 fixes." This feedback has been incorporated. ✅

---

### Question 6: Contradictions between P0-4's `result?.model?.id` and P1-3's `resolveModel(ctx)`

**Verdict:** 🔴 Contradiction exists. P1-3 is correct; P0-4 is not.

| Aspect | P0-4 (v2 plan) | P1-3 (v2 plan) | Consistency? |
|--------|----------------|-----------------|--------------|
| Model source | `result?.model?.id` from `aiComplete` return value | `resolveModel(ctx)` | ❌ Inconsistent |
| Availability | NOT available at call site (see Q1) | Always available (ctx parameter) | ❌ P0-4 broken |
| Resolution logic | Implicitly same as aiComplete (via return value) | Same as aiComplete (calls same function) | ✅ Logic-consistent in theory |

The plan's risk table claims this is consistent:
> P0-4 passes the actual model ID from `aiComplete`'s return value (not `ctx.model`). P1-3 uses `resolveModel(ctx)` which is the same resolution path `aiComplete` uses.

This statement is **factually correct about the resolution logic**, but it ignores the temporal problem. `resolveModel(ctx)` is available before `aiComplete` runs; `result?.model?.id` is only available after. Both P0-4 and P1-3 should use the **same** mechanism: `resolveModel(ctx)?.id`.

**Resolution:** P0-4's caller update should be changed from `result?.model?.id` to `resolveModel(ctx)?.id`, computed before the `aiComplete` call. This unifies the model detection pattern and eliminates the temporal dependency bug.

---

### Question 7: `buildPrompt` function signature change — all call sites

**Verdict:** ✅ Only one call site, correctly identified.

`buildPrompt` is called in exactly one place: `generateAutoCommitMessage` at line 386 of `src/core/auto-commit-message.ts`. The new `modelId?: string` parameter is optional (trailing, with `?`), so:
- If the caller passes `undefined` (or doesn't pass it), `getBudgetMultiplier(undefined)` returns `"small"` (conservative default). Safe default.
- With the corrected approach (passing `resolveModel(ctx)?.id`), the model ID is properly passed.

No other call sites exist. ✅

---

### Question 8: Japanese system prompt rewrite — example structure

**Verdict:** ✅ Correct structure.

The plan's v2 Japanese system prompt examples:

```
例:
ユーザーの依頼: 「認証ページにログインフォームを追加して」 | 変更ファイル: src/auth/login.tsx, src/auth/api.ts
→ feat(auth): ログインフォームを追加

ユーザーの依頼: 「支払いフローのnullポインタエラーを修正して」 | 変更ファイル: src/payment/processor.ts
→ fix(payment): nullチェックを追加
```

Compared to the existing separate `autoCommitMsg.examples` (ja) key at messages.ts line ~241, the system-prompt examples:
- Remove the "アシスタントの応答:" line (not available in system prompt context)
- Use `|` as a compact separator instead of separate lines
- Keep the `→` output indicator for clarity
- Both examples demonstrate scope inference (`auth`, `payment`), imperative mood, and under-50-char subjects

These examples are appropriate for a system prompt: they're concise, demonstrate the expected format, and include scope inference examples that small models often miss. The `|` separator is a common convention in few-shot prompts that the AI should parse naturally. ✅

---

### Additional Finding: P0-1 Fence Regex and Non-ASCII Info Strings

The plan's fence regex is `` /```(?:\w*)?\s*\n?([\s\S]*?)\n?```/ ``. The risk review (Section 2b) verified this handles Japanese info strings correctly because `\w` doesn't match Japanese characters, so `(?:\w*)?` matches zero for non-ASCII info strings, and `\s*\n?` also matches zero for directly adjacent Japanese text. The capture then correctly extracts the content.

However, there's a subtle edge case: if a fence has **no info string but Content-Type headers** (unlikely for commit messages, but possible for chat models that emit true markdown), the capture would include them. Not a practical concern.

---

### Additional Finding: P0-4 `getBudgetMultiplier` Fallback

```typescript
function getBudgetMultiplier(modelId: string | undefined): "small" | "large" {
  if (!modelId) return "small"; // unknown model → conservative
  ...
}
```

When `modelId` is `undefined` (uncallable model or no model configured), the default is `"small"` (assistant: 2500, diff: 3000). This is the **right** conservative choice: the system prompt says "GIT DIFF is the most reliable source," but for unknown models, err on giving more assistant context. ✅

However, if `resolveModel(ctx)` returns a model but the model doesn't match any cheap patterns, the function returns `"large"` — which keeps the original 600/5000 budget. This includes models like `gpt-4o` or `deepseek-v4-pro`. The risk table correctly identifies this. ✅

---

### Additional Finding: P1-2 `japaneseGenericWords` Regex Lookahead

```typescript
const japaneseGenericWords = /(変更|修正|更新|対応|適用|反映)(?!\S)/g;
```

The `(?!\S)` negative lookahead ensures this only matches at the end of text or before whitespace. This prevents `修正機能` from being penalized (because `修` `正` are separate kanji characters that could appear in compound words like `修正機能を追加`). This is a well-designed guard against false positives. ✅

---

### Additional Finding: P1-1 Missing Paired Change in Plan

The plan says to "Remove `{examples}` from `autoCommitMsg.buildPrompt` templates in both en and ja" and "Remove the `examples` variable and `t(lang, "autoCommitMsg.examples", ...)` call from `buildPrompt()`." But the plan doesn't explicitly say to **remove** the `autoCommitMsg.examples` keys from `messages.ts`. While keeping unused keys is harmless, they become dead code. This is a minor cleanup note, not a bug.

---

## Summary

| # | Finding | Severity | Question |
|---|---------|----------|----------|
| 1 | P0-4 `result?.model?.id` unavailable at call site — must use `resolveModel(ctx)?.id` | 🔴 Blocker | Q1, Q6 |
| 2 | P1-3 `resolveModel(ctx)` correctly matches `aiComplete`'s resolution path | ✅ | Q2 |
| 3 | P1-5 `inferTypeFromFiles` exists and wrapper is correct | ✅ (minor: P1-1 should precede P1-5) | Q3 |
| 4 | P0-1 expanded patterns cover all risk review edge cases (backticks, 今回のコミット, etc.) | ✅ | Q4 |
| 5 | P1-2 precedes P1-3 with explicit justification in plan | ✅ | Q5 |
| 6 | Contradiction: P0-4 uses `result?.model?.id`, P1-3 uses `resolveModel(ctx)` — P1-3 is correct | 🔴 Blocker | Q6 |
| 7 | `buildPrompt` has single call site; new `modelId?` parameter is safe | ✅ | Q7 |
| 8 | Japanese system prompt examples are structurally correct and concise | ✅ | Q8 |
| 9 | `getBudgetMultiplier` conservative default is correct | ✅ | — |
| 10 | `japaneseGenericWords` lookahead prevents false positives | ✅ | — |
| 11 | `autoCommitMsg.examples` keys become dead code after P1-1 (cleanup note) | 🔵 Note | — |

---

## Required Fix

**One change needed in P0-4 "Caller update":** Replace `result?.model?.id` with `resolveModel(ctx)?.id` and compute it before the `aiComplete` call:

```diff
- **Caller update:** `generateAutoCommitMessage` passes `result?.model?.id` (the actual model used).
+ **Caller update:** `generateAutoCommitMessage` imports `resolveModel`, resolves the model before
+ `aiComplete`, and passes `resolveModel(ctx)?.id` to `buildPrompt`. This uses the same resolution
+ path as `aiComplete` (consistent with P1-3).
```

This eliminates both the temporal dependency bug and the inconsistency between P0-4 and P1-3.

---

## Overall Assessment

The v2 plan correctly incorporates all five v1 feedback items (P1-3 model detection, P1-5 type hints, P1-2/P1-3 ordering, expanded prefix patterns, Japanese system prompt). The one remaining issue is P0-4's `result?.model?.id` which is a straightforward fix — replace with `resolveModel(ctx)?.id` as P1-3 already uses. The plan's logic and code are otherwise sound.