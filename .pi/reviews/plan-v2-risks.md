# Plan v2 Risk & Implementation Readiness Review

**Date:** 2026-06-12
**Reviewer:** review subagent (impl readiness, blocker detection, edge-case coverage)
**Sources inspected:** plan `.pi/plans/commit-msg-small-model-fix.md`, `src/core/auto-commit-message.ts`, `src/core/resolve-model.ts`, `src/core/ai.ts`, `src/core/commit-message.ts`, `src/core/diff-analyzer.ts` (partial), `src/i18n/messages.ts`, v1 risk review `.pi/reviews/plan-risks.md`

---

## Review Angle: Risk Re-Assessment & Implementation Readiness

---

### 1. P0-4 Model Gate Correctness — ORDERING BUG (BLOCKER)

**The plan states (section P0-4, Caller update):**
> `generateAutoCommitMessage` passes `result?.model?.id` (the actual model used).

**This is architecturally impossible.** The actual code flow in `auto-commit-message.ts:363-372`:

```typescript
const result = await aiComplete(ctx, {
    systemPrompt: getSystemPrompt(lang),
    userMessage: buildPrompt(          // ← buildPrompt is called HERE
      userMessages,                     //   as part of constructing
      assistantMessages,                //   the argument to aiComplete
      changedFiles,
      diff,
      lang,
    ),                                 //   BEFORE aiComplete executes
});
// result?.model?.id is only available HERE, after the await
```

`buildPrompt` constructs the `userMessage` that gets passed into `aiComplete`. The `result` from `aiComplete` does not exist until after the `await` resolves. There is no way to pass `result?.model?.id` to `buildPrompt` before the call.

**The correct fix:**

Since `aiComplete` internally calls `resolveModel(ctx)` synchronously (see `ai.ts:40`), the caller can obtain the same model ID before the call:

```typescript
// In generateAutoCommitMessage, BEFORE aiComplete:
const modelId = resolveModel(ctx)?.id;

const result = await aiComplete(ctx, {
    systemPrompt: getSystemPrompt(lang),
    userMessage: buildPrompt(
      userMessages, assistantMessages, changedFiles, diff, lang,
      modelId,   // ← resolved synchronously, same model aiComplete uses
    ),
    maxTokens: 200,
});
```

`resolveModel` is a synchronous function — no await needed. The model it returns is the same one `aiComplete` will use (source: `ai.ts:40-41`). No circular dependency is introduced — `resolve-model.ts` imports nothing from `auto-commit-message.ts` or `ai.ts`.

**Verdict: 🛑 BLOCKER. Plan must be corrected before implementation begins.** The import `import { resolveModel } from "./resolve-model.js";` must be added to `auto-commit-message.ts`.

---

### 2. P0-4 vs P1-1 Interaction — Compatible

P0-4 changes `buildPrompt` signature: adds `modelId?: string` parameter, adds conditional budget logic inside.

P1-1 changes `buildPrompt`: removes `const examples = t(...)` line, removes `{examples}` from the template-instantiation call.

**These never touch the same lines.**

| Aspect | P0-4 | P1-1 |
|--------|------|------|
| Signature | Adds `modelId?: string` | No change |
| Early body | Adds `const budget = getBudgetMultiplier(modelId)` | — |
| Budget constants | `MAX_ASSISTANT_CHARS`, `MAX_DIFF_CHARS` become dynamic | No change |
| Lines after budget section | Unchanged | Removes `const examples = ...` and removes `examples` from `t(...)` call |
| Return statement | Unchanged | The `examples` key disappears from the template values object |

**Verdict: ✅ Compatible.** The diffs are on non-overlapping regions of the same function. Both can coexist without conflict.

---

### 3. v1 Risk Review Edge Cases — All Covered

The v1 risk review (`plan-risks.md`) identified four specific edge-case gaps. Here's how v2 addresses each:

#### 3a. Backtick-wrapped messages in prose — ✅ COVERED

v2 plan P0-1 adds **Layer 2.5**:
```typescript
text = text.replace(/^`([^`]+)`$/, "$1").trim();
```
This strips wrapping single-backtick pairs like `` `feat: add login` ``. The v1 review's example (`The commit message is: \`feat: add message broker\``) would now work:
1. Layer 2 strips `The commit message is: ` → `` `feat: add message broker` ``
2. Layer 2.5 strips wrappers → `feat: add message broker`
3. Layer 3 finds CC line → ✅

#### 3b. Unrecognized Japanese preamble patterns — ✅ COVERED

v2 plan P0-1 expands prefix patterns to include:
```
/^(?:今回のコミット[:\s]*)/,
/^(?:以下のコミットメッセージを提案します[:\s]*)/,
/^(?:コミットメッセージを[作成生成]しました[:\s]*)/,
/^(?:はい[,、]\s*承知しました[。.]?\s*)/,
```
These directly close the four gaps the v1 review identified: `今回のコミット`, `以下のコミットメッセージを提案します`, `作成しました` variants, and `はい、承知しました。`.

#### 3c. Fence handling with non-ASCII info strings — ✅ COVERED (functional through layering)

The v1 review analyzed the regex `` /```(?:\w*)?\s*\n?([\s\S]*?)\n?```/ `` against `` ```コミットメッセージ\nfeat: ログインを追加\n``` `` and found it works — the `(?:\w*)?` matches zero characters for non-ASCII, the info string ends up in the capture group, but the subsequent JP prefix patterns strip it. The multi-layer approach (Layer 1 fence extraction → Layer 2 prefix stripping → Layer 3 CC line finder) makes this robust despite the imperfect fence regex.

#### 3d. Empty input — ✅ SAFE (unchanged)

v1 review confirmed this cascades correctly to `sanitizeCommitMessage`'s fallback. No changes needed in v2.

**Verdict: ✅ All four v1 review edge cases are addressed in v2.**

---

### 4. `isCheapModel` Gaps — Acceptable, Acknowledged

The pattern set is identical to v1: `/mini/i, /flash/i, /nano/i, /lite/i, /small/i, /haiku/i`.

Models still **not** caught (7-9B without marketing size names):
| Model | Parameter size | Risk |
|-------|---------------|------|
| `gemma-2-9b` | 9B | Medium — might produce weak output |
| `llama-3.1-8b` | 8B | Medium |
| `qwen-2.5-7b` | 7B | Medium |
| `deepseek-coder-6.7b` | 6.7B | Medium |

**The plan's risk table addresses this explicitly:** "Consequence is mild: AI comparison is still attempted (not skipped). If the comparison fails, the existing heuristic fallback handles it. Future: use model metadata when available. ✅ Acceptable"

**Assessment:** This is a pragmatic, honest assessment. The cost of false negatives is extra AI calls (which may produce noise), but the overall pipeline has defense layers. Adding a blanket `/\b\d{1,2}b\b/i` pattern would catch these at the risk of false-positiving on capable models (e.g., `llama-3.1-70b`). Without model metadata from the SDK, the regex heuristic is the best available approach.

**Verdict: ✅ Acceptable. Not a blocker.**

---

### 5. P0-4 and P1-3 Pattern Duplication — DRY Violation

Both P0-4's `getBudgetMultiplier` and P1-3's `isCheapModel` define an **identical** `CHEAP_MODEL_PATTERNS` array:

```typescript
// P0-4:
const CHEAP_MODEL_PATTERNS = [
  /mini/i, /flash/i, /nano/i, /lite/i, /small/i, /haiku/i,
];

// P1-3 (same constant, same patterns):
const CHEAP_MODEL_PATTERNS = [
  /mini/i, /flash/i, /nano/i, /lite/i, /small/i, /haiku/i,
];
```

Additionally, `getBudgetMultiplier` is just a boolean check wrapped in a string return:
```typescript
// P0-4:
function getBudgetMultiplier(modelId: string | undefined): "small" | "large" {
  if (!modelId) return "small";
  return CHEAP_MODEL_PATTERNS.some((p) => p.test(modelId)) ? "small" : "large";
}

// P1-3:
function isCheapModel(modelId: string): boolean {
  return CHEAP_MODEL_PATTERNS.some((p) => p.test(modelId));
}
```

**Recommended consolidation:**
```typescript
// Module scope, single source of truth:
const CHEAP_MODEL_PATTERNS = [
  /mini/i, /flash/i, /nano/i, /lite/i, /small/i, /haiku/i,
];

function isCheapModel(modelId: string): boolean {
  return CHEAP_MODEL_PATTERNS.some((p) => p.test(modelId));
}

function getBudgetMultiplier(modelId: string | undefined): "small" | "large" {
  if (!modelId) return "small";
  return isCheapModel(modelId) ? "small" : "large";
}
```

**Verdict: ⚠️ Note — not a blocker, but should be consolidated during implementation.** Having two copies of the same array in the same file is error-prone (future updates might only touch one copy).

---

### 6. P1-5 Type Hints — No Conflict with P1-1

P1-5 adds `buildTypeHintForMessage` which calls `inferTypeFromFiles` (already exported from `commit-message.ts`, already imported by `diff-analyzer.ts`). The result is prepended **before** the i18n template:

```typescript
const typeHint = buildTypeHintForMessage(changedFiles);
const prompt = t(lang, "autoCommitMsg.buildPrompt", { ... });
return (typeHint + prompt);
```

P1-1 removes `{examples}` from the i18n template — inside the `t()` call, not the prepended string.

**No interaction.** The prepended type hint and the template substitution are independent.

**One observation about the type hint:** `buildTypeHintForMessage` returns `""` when `inferTypeFromFiles` returns `"chore"`. Since `inferTypeFromFiles` returns `"chore"` as the default fallback for most file types (config, dependencies, scripts), the type hint will be absent for a large fraction of commits. This is by design ("let the AI decide") but worth noting — the hint is most useful when the file type strongly implies the commit type (e.g., test files → `test`, docs → `docs`).

**Verdict: ✅ No conflict. Dependency chain (`inferTypeFromFiles`) is available and already exported.**

---

### 7. Implementation Order — Safe with One Constraint

#### Phase dependencies:

| Step | Depends on | Notes |
|------|-----------|-------|
| P0-1 (cleanCommitOutput) | None | New function + one callsite in `generateAutoCommitMessage` |
| P0-2 (maxTokens) | None | One-line addition to `aiComplete` call |
| P0-3 (JP patterns) | None | Array extension |
| P0-4 (budget gate) | None | Changes `buildPrompt` signature + body |
| P0-5 (newest-first) | None | Changes `buildPrompt` loop logic |
| P1-1 (examples in system prompt) | P0-4 + P0-5 complete | Also modifies `buildPrompt` (removes `{examples}`) |
| P1-2 (specificityScore) | None required | Exists before P1-3 per plan's stated intent |
| P1-3 (skip AI comparison) | P1-2 complete, P0-4 complete (for shared constant) | Depends on P1-2's scoring rebalance |
| P1-4 (vote parsing) | None | Independent addition in `refineMessageIfGeneric` |
| P1-5 (type hints) | P1-1 complete (shared `buildPrompt` edits) | Also modifies `buildPrompt` return |

#### Key constraint:

**P1-1 and P1-5 both touch `buildPrompt`.** P1-1 modifies the template values (removes `examples`). P1-5 modifies the return statement (prepends `typeHint`). These areas don't overlap. However, **P1-1 must be applied first** because P1-5's return change assumes the `{examples}` removal has already been applied to the template strings.

**P0-4 and P0-5 both touch `buildPrompt`** but on completely different sections (signature/budget vs. loop/reversal). No ordering constraint between them.

**P0-4 and P1-3 share `CHEAP_MODEL_PATTERNS`** — if consolidated (per item 5 above), P0-4 must define the shared constant first.

**Recommendation for implementer:** Apply P0-1 through P0-5 sequentially (any order within P0), then P1-1 → P1-2 → P1-3 → P1-4 → P1-5 sequentially. Consolidate `CHEAP_MODEL_PATTERNS` during P0-4 and reference it in P1-3.

**Verdict: ✅ Safe. No compilation-deadlocking dependency between P0 and P1. P1-3 depends on P1-2 (documented). P1-5 benefits from P1-1 being done first (cleaner merge).**

---

### 8. Final Readiness Assessment

#### Blockers

| # | Issue | Severity | Resolution |
|---|-------|----------|------------|
| 1 | **P0-4 caller update uses `result?.model?.id` but `buildPrompt` is called before `aiComplete` returns.** This is impossible with the current code structure. | 🛑 **Blocker** | Change plan to use `resolveModel(ctx)?.id` before the `aiComplete` call. Add `import { resolveModel } from "./resolve-model.js";` to `auto-commit-message.ts`. |

#### Non-blocking notes

| # | Issue | Recommendation |
|---|-------|---------------|
| 2 | `CHEAP_MODEL_PATTERNS` defined twice (P0-4 and P1-3) | Consolidate into module-scope constant during implementation |
| 3 | `isCheapModel` misses 7-9B models without marketing size names | Acknowledged in plan risks. Acceptable. Consider adding `/\b\d{1,2}b\b/i` but only if model IDs consistently use this pattern for small models |
| 4 | Fence regex `(?:\w*)` doesn't match non-ASCII info strings | Functional through multi-layer processing; could be improved with `[\w\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]*` but not necessary |

#### What is correct and ready

- **P0-1 `cleanCommitOutput`:** Well-designed 4-layer extraction. Handles fences, chat prefixes, backtick wrapping, CC-pattern extraction. Each layer is idempotent on clean input.
- **P0-2 `maxTokens: 200`:** Safe reduction. A CC message needs ~15-40 tokens. 200 is generous.
- **P0-3 Japanese generic patterns:** Conservative regex — only matches when the entire body is a single generic word + optional polite ending. Specific phrases don't false-positive.
- **P1-1 examples in system prompt:** Gives small models behavioral anchors before processing noisy user content. Good prompt engineering.
- **P1-2 specificityScore rebalance:** Brings Japanese scoring to parity with English. The reward/penalty split is intentional and balanced.
- **P1-4 last-wins tiebreaker:** Simple, correct, handles the specific edge case of models saying "Both A and B are good, but B is better."
- **P1-5 type hints:** Reuses existing `inferTypeFromFiles`. Non-invasive prepend. No impact when hint is empty.
- **P0-5 newest-first order:** Directionally correct for all model sizes — recent context is more relevant.
- **Implementation order:** Well-structured phases with documented intra-phase dependencies (P1-2 before P1-3).
- **i18n integration:** Both `en` and `ja` system prompts are rewritten cohesively. Templates are updated in both languages.
- **Risk table:** Honest about limitations (`isCheapModel` gaps, `resolveModel` vs `result.model.id` consistency).

#### Overall

| Dimension | Assessment |
|-----------|-----------|
| Correctness | ⚠️ One blocker (P0-4 ordering bug) |
| Edge case coverage | ✅ All v1 review gaps closed |
| Large-model regression | ✅ Mitigated by P0-4 model gate (once fixed) |
| Interaction safety | ✅ All P0/P1 changes are orthogonal or non-conflicting |
| Implementation order | ✅ Clear phase structure with documented dependencies |
| Risk honesty | ✅ Known limitations documented |

**Readiness: NOT READY — one blocker must be resolved.**

The P0-4 caller update must be corrected to use `resolveModel(ctx)?.id` instead of `result?.model?.id`. Once that single change is made to the plan, all P0 and P1 items are implementable without architectural issues.
