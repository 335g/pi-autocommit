# Large Model Regression Analysis: deepseek-v4-pro

## Summary

deepseek-v4-pro previously produced specific, accurate commit messages. After P0-P2 changes targeting small-model improvements, it now produces abstract/generic messages. **The primary root cause is that type hints (P1-5) are applied to ALL models without gating, despite the code comment explicitly stating they are "for small models."** A secondary contributing factor is `maxTokens=200` (P0-related), which constrains reasoning-capable models.

---

## Finding 1 (BLOCKER): Type hints applied unconditionally to all models — no gating

**File:** `src/core/auto-commit-message.ts`, lines ~465-468

```ts
// Prepend type hints for small models (reuses inferTypeFromFiles from commit-message.ts)
const typeHint = buildTypeHintForMessage(changedFiles);
return typeHint + prompt;
```

The comment says *"for small models"* but the code has **zero gating** — `buildTypeHintForMessage` runs for every model, including deepseek-v4-pro. This is a clear intent-implementation mismatch.

**Mechanism of harm for large models:**

`inferTypeFromFiles` (in `commit-message.ts:53-66`) returns the **first** matching type. The checks run in this order: `test` → `docs` → `style` → `chore` → `ci` → `chore`. The `test` check uses:

```ts
if (/test|spec|\.test\.|\.spec\./.test(allPaths)) return "test";
```

This has **no word boundaries** — any file path containing "test" triggers it (e.g., `contest.tsx`, `latest.ts` are false positives).

**Concrete scenario:**

A commit modifies `src/auth/login.ts` (feature code) and `src/auth/login.test.ts` (tests). The hint becomes:

```
Hint: based on file paths, the likely commit type is "test".
=== USER REQUEST ===
...
=== GIT DIFF ===
[substantial feature code in login.ts + test assertions]
```

deepseek-v4-pro, a highly capable model that follows instructions meticulously, sees this "hint" as an authoritative instruction. The diff clearly shows feature work, but the hint says "test." The model must reconcile this contradiction:

- It may produce a "test" type message that ignores the feature work → **wrong type, misses intent**
- It may produce a hedging message like "chore: update auth module files" to avoid the contradiction → **generic/abstract output**

Either outcome degrades quality from the previously correct behavior.

**Evidence from tests:** The test file (`auto-commit-message.test.ts:290-305`) tests `buildTypeHintForMessage` but does NOT test gating. No test verifies "hints only for small models."

**Fix:**

```ts
// Before (broken — no gating):
const typeHint = buildTypeHintForMessage(changedFiles);
return typeHint + prompt;

// After (gated to small models only):
const isCheap = modelId && isCheapModel(modelId);
const typeHint = isCheap ? buildTypeHintForMessage(changedFiles) : "";
return typeHint + prompt;
```

Note: `isCheapModel` is already defined in the same file and importable. `modelId` is already passed to `buildPrompt`.

**Severity: Blocker** — This is the single most likely cause of the regression. The misleading hint directly contradicts what large models deduce from the diff, causing degraded output.

---

## Finding 2 (BLOCKER): maxTokens=200 constrains reasoning-capable large models

**File:** `src/core/auto-commit-message.ts`, line ~530

```ts
const result = await aiComplete(ctx, {
  systemPrompt: getSystemPrompt(lang),
  userMessage: buildPrompt(...),
  maxTokens: 200,  // ← NEW: was absent before, defaulted to 1024
});
```

**Before (v0.0.6 / 9b1ea40):** No `maxTokens` parameter → `aiComplete` defaulted to `1024` (see `src/core/ai.ts:50`: `maxTokens: options.maxTokens ?? 1024`).

**After:** Explicitly set to `200` — an 80% reduction for all models.

**Why this matters for reasoning models like deepseek-v4-pro:**

The `aiComplete` call passes `reasoning: "minimal"` (via `src/core/ai.ts:49`). For models that support reasoning/thinking tokens, the `maxTokens` budget may be **shared** between reasoning tokens and output tokens. If the model uses ~150 tokens for reasoning about the diff, only ~50 remain for the actual commit message. With such a tight budget, the model may:

1. Truncate reasoning → less accurate decision-making
2. Produce a shorter, less specific message to fit the remaining budget
3. Both

**Evidence:** The symptom is "generic output" not "truncated mid-sentence output." This suggests the model is *adapting* to the constraint by producing shorter messages, not being cut off. A 200-token budget is still sufficient for output (a CC message needs ~10-30 tokens), but only if reasoning doesn't consume most of it.

**Additionally:** There's a secondary concern: some model providers count `maxTokens` as a *completion* limit that includes reasoning_content. If deepseek's implementation includes thinking tokens in the completion budget, a 200-token hard cap is extremely tight.

**Fix options:**

*Option A (conservative):* Restore the previous default by removing the explicit `maxTokens: 200`:
```ts
const result = await aiComplete(ctx, {
  systemPrompt: getSystemPrompt(lang),
  userMessage: buildPrompt(...),
  // maxTokens omitted → defaults to 1024
});
```

*Option B (targeted):* Model-dependent budget:
```ts
const isCheap = modelId && isCheapModel(modelId);
const result = await aiComplete(ctx, {
  systemPrompt: getSystemPrompt(lang),
  userMessage: buildPrompt(...),
  maxTokens: isCheap ? 200 : 1024,
});
```

*Option C (minimal):* Raise to 512, which is tight enough to prevent runaway output but leaves room for reasoning + specific message.

**Recommendation:** Option B — gate the token constraint to small models where it's most needed, while preserving the 1024 budget for large models.

**Severity: Blocker** — Reduces output budget by 80%, potentially starving reasoning models of token capacity.

---

## Finding 3 (Note): System prompt inline examples may anchor large model output style

**File:** `src/i18n/messages.ts`, both `en` and `ja` `autoCommitMsg.systemPrompt`

**Before:**
System prompt: no examples. Examples were in the user prompt (`buildPrompt` started with `{examples}`).

**After:**
System prompt now includes inline examples:
```
Examples:
User: "Add a login form..." | Files: src/auth/login.tsx, src/auth/api.ts
→ feat(auth): add login form

User: "Fix the null pointer error..." | Files: src/payment/processor.ts
→ fix(payment): add null check in processor
```

The `{examples}` placeholder was removed from `buildPrompt` templates (both en and ja). The `examples` variable is still computed and passed to `t()`, but the template no longer contains `{examples}`, making it a no-op.

**Impact:** Few-shot examples moved from user prompt (high-attention position) to system prompt (potentially lower-attention for some models). More importantly, the examples show only TWO patterns — both "feat(scope): add X" and "fix(scope): add Y". A large model may over-anchor to this narrow distribution and produce messages that always follow the "add X" or "add Y" pattern, even when other descriptions (e.g., "refactor", "remove", "optimize") are more appropriate. This could contribute to the perception of "generic" output, especially for changes that don't match the two example patterns.

**Severity: Note** — Contributes to output homogenization but is not the primary cause of generic output. The examples are reasonable for guidance; the bigger issue is the type hint (Finding 1) wrongly steering the model.

---

## Finding 4 (Note): `inferTypeFromFiles` has "test" false-positive matching

**File:** `src/core/commit-message.ts`, line 55

```ts
if (/test|spec|\.test\.|\.spec\./.test(allPaths)) return "test";
```

The bare `test` alternative (without `\b`) matches ANY substring containing "test":
- `src/components/contest.tsx` → **false positive**: matches "test" in "contest"
- `src/utils/latest.ts` → **false positive**: matches "test" in "latest"
- `src/config/protest.ts` → **false positive**

This is a **pre-existing bug** (present before P0-P2), but it amplifies the harm of Finding 1 because the type hint becomes wrong more often than intended. The fix would be to use word boundaries:

```ts
if (/\btest\b|spec|\.test\.|\.spec\./.test(allPaths)) return "test";
```

**Severity: Note** — Pre-existing. Not introduced by P0-P2 changes, but directly amplifies the Finding 1 bug.

---

## Finding 5 (Correct): cleanCommitOutput is safe for large models

**File:** `src/core/auto-commit-message.ts`, lines 67-113

For a model like deepseek-v4-pro that previously produced clean output (e.g., `feat(auth): implement JWT auth`), `cleanCommitOutput` is a passthrough:

- **Layer 1** (markdown fences): No match → passthrough
- **Layer 2** (chat prefixes): No match → passthrough  
- **Layer 2.5** (backtick stripping): Strips `` ` `` wrapping if present, otherwise passthrough
- **Layer 3** (CC line extraction): Finds the CC line → returns it directly

No edge cases found that would mangle a valid large-model output.

The one edge case to be aware of: if maxTokens=200 causes the model to produce output LIKE `Sure! Here is the commit message: feat(auth): implement...` and the message body gets truncated mid-word before the CC line, Layer 3 won't find a valid CC → Layer 4 returns "Sure! Here is the commit message:" → `sanitizeCommitMessage` would produce something based on the first line, which might be awkward but `isGenericMessage` would then flag it for refinement. This edge case is a consequence of Finding 2 (maxTokens), not a bug in `cleanCommitOutput` itself.

**Severity: Correct** — No issues found.

---

## Finding 6 (Correct): Budget gating correctly classifies deepseek-v4-pro as "large"

**File:** `src/core/auto-commit-message.ts`, lines 59-63

```ts
export function getBudgetMultiplier(modelId: string | undefined): "small" | "large" {
  if (!modelId) return "small";
  return isCheapModel(modelId) ? "small" : "large";
}
```

`isCheapModel("deepseek-v4-pro")` returns `false` (verified against `CHEAP_MODEL_PATTERNS`: no match for `mini`, `flash`, `nano`, `lite`, `small`, `haiku`). So `getBudgetMultiplier("deepseek-v4-pro")` returns `"large"`.

**Resolution chain:**
1. `resolveModel(ctx)` — if user has `analysis_model` configured, uses that; otherwise returns `ctx.model` (session model)
2. For a deepseek-v4-pro user, either path resolves to a model with id `"deepseek-v4-pro"`
3. `getBudgetMultiplier("deepseek-v4-pro")` → `"large"` → correct budget allocation (MAX_ASSISTANT_CHARS=600, MAX_DIFF_CHARS=5000)

**Only risk:** If `resolveModel(ctx)` returns `undefined` (no configured model AND no session model), `getBudgetMultiplier(undefined)` returns `"small"`. In this case the model wouldn't be used at all (aiComplete returns null when model is undefined), so the budget path is never reached.

**Severity: Correct** — No issues found.

---

## Finding 7 (Correct): Newest-first ordering produces same display as before

**File:** `src/core/auto-commit-message.ts`, `buildPrompt()`

**Before (v0.0.6):**
```ts
for (const msg of userMessages.reverse()) {  // oldest-to-newest iteration
  userLines.push(truncated);
}
const userStr = userLines.reverse().join("\n---\n");  // reverse back → newest-first display
```

**After:**
```ts
for (const msg of userMessages) {  // newest-to-newest iteration
  userLines.push(truncated);
}
const userStr = userLines.join("\n---\n");  // no reverse → newest-first display
```

Both produce the same display order (newest-first). The old code effectively reversed twice (once for processing order, once for display). The new code skips the unnecessary double-reverse. No behavioral change for the model.

**Severity: Correct** — No change in prompt structure.

---

## Finding 8 (Correct): P2 `\b` boundaries and `.{0,10}` → `[a-zA-Z0-9\s]{0,10}` change

**File:** `src/core/auto-commit-message.ts`, line 44

```diff
- /^(feat|fix|chore|docs|style|refactor|test):\s*.{0,10}$/i,
+ /^(feat|fix|chore|docs|style|refactor|test):\s*[a-zA-Z0-9\s]{0,10}$/i,
```

This narrows the "body too short" generic detection to only ASCII alphanumeric + space characters. Japanese body text (containing kanji/kana) no longer matches this pattern. This makes generic detection **more lenient** for Japanese messages — they're less likely to be flagged as generic.

**Impact on large models:** This doesn't affect model output; it affects the downstream `isGenericMessage` check which triggers refinement. For deepseek-v4-pro, this is irrelevant because:
1. If the message isn't generic → no refinement needed
2. If the message IS generic (caught by other patterns) → refinement uses AI comparison (since deepseek-v4-pro is not a cheap model)

**Severity: Correct** — No negative impact on large models. Actually slightly better for Japanese messages (fewer false-positive generic detections).

---

## Root Cause Determination

### Most Likely Single Cause: **Finding 1 — Type hints without model gating**

**Confidence: High**

The evidence chain:

1. The code comment explicitly states type hints are "for small models" — confirming intent
2. No gating exists — confirming implementation error  
3. `inferTypeFromFiles` returns the first match (`test` before `feat`), so mixed commits get the wrong hint
4. The hint is prepended to the user prompt as a directive, not a suggestion
5. deepseek-v4-pro is known to follow instructions carefully — a misleading "hint" is effectively a misinstruction
6. The symptom ("generic/abstract" rather than "wrong type") is consistent with a model hedging when the hint contradicts the diff

### Secondary Contributor: **Finding 2 — maxTokens=200**

**Confidence: Medium-High**

If reasoning tokens count against the 200-token budget, the model operates under severe token pressure. Combined with the misleading type hint, the model has less "token runway" to resolve the contradiction and produce specific output.

---

## Recommended Fix Strategy

### Must-fix (Blocker):
1. **Gate type hints to small models** in `buildPrompt()`:
   ```ts
   const isCheap = modelId && isCheapModel(modelId);
   const typeHint = isCheap ? buildTypeHintForMessage(changedFiles) : "";
   return typeHint + prompt;
   ```

2. **Restore reasonable maxTokens for large models** in `generateAutoCommitMessage()`:
   ```ts
   const isCheap = modelId && isCheapModel(modelId);
   maxTokens: isCheap ? 200 : 1024,
   ```

### Should-fix (Note):
3. **Add `\b` word boundary** to the `test` alternative in `inferTypeFromFiles`:
   ```ts
   if (/\btest\b|spec|\.test\.|\.spec\./.test(allPaths)) return "test";
   ```

4. **Add tests** for the gating behavior (type hints only for cheap models, maxTokens budget per model tier).

### Further investigation:
- Verify with the deepseek API whether reasoning tokens count against `maxTokens`. If they do, consider using a higher budget (1024+) or making the reasoning mode `"high"` only for large models with sufficient token budget.
