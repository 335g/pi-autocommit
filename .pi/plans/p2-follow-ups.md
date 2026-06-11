# P2 Implementation Plan: Small Model Commit Message — Follow-ups

**Date:** 2026-06-11
**Status:** Draft — Under Review
**Based on:** Plan v3 (P0/P1 implemented), source reviews (budget-truncation #3/#4, refinement-heuristics #6, prompt-engineering #7/#8)
**Prerequisite:** P0 + P1 already implemented in `src/core/auto-commit-message.ts` and `src/i18n/messages.ts`

---

## Goal

Address the 4 deferred P2 improvements that are not critical for the core small-model fix but improve correctness, safety, and testability.

---

## P2-1: Newline-boundary diff truncation

**Severity:** Low-Medium
**Source:** Budget-truncation review Issue #4
**File:** `src/core/auto-commit-message.ts`

### Problem

`buildPrompt` currently calls `truncate(cleanedDiff, MAX_DIFF_CHARS)` which cuts at **space boundaries**. Diff lines don't have natural-language "words" — a space-boundary cut can break in the middle of:

- `@@ -1,5 +1,7 @@` (hunk header)
- `+   const x` (added line)
- `-   return oldValue;` (removed line)

This produces syntactically invalid diff fragments. Small models already struggle with raw diffs; broken syntax makes it worse.

### Fix

Add a `truncateDiffAtNewline` helper that cuts at newline boundaries, and use it for the diff section. Align with `diff-analyzer.ts`'s existing `truncateDiff` function (lines 198-202):

```typescript
// In src/core/auto-commit-message.ts:

/** Truncate diff content at a clean newline boundary (not mid-line) */
function truncateDiffAtNewline(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  const slice = diff.substring(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  return lastNewline > 0 ? slice.substring(0, lastNewline) : slice;
}
```

Then in `buildPrompt`, replace:
```typescript
diffSection = truncate(cleaned, MAX_DIFF_CHARS);
```
with:
```typescript
diffSection = truncateDiffAtNewline(cleaned, MAX_DIFF_CHARS);
```

**Changes:** ~10 lines, 1 call site change.

---

## P2-2: English conversational markers in `isValidCommitSubject`

**Severity:** Low
**Source:** Refinement-heuristics review Issue #6
**File:** `src/core/auto-commit-message.ts`

### Problem

`isValidCommitSubject` only validates Japanese (`lang === "ja"`). For English, it always returns `true`. English conversational patterns pass through as valid commit subjects:

| User input | Candidate produced | `isValidCommitSubject` | Problem |
|-----------|-------------------|----------------------|---------|
| `"can you add a login form"` | `feat: can you add a login form` | `true` (no check) | "can you" is conversational |
| `"could you please fix the bug"` | `fix: could you please fix the bug` | `true` (no check) | "could you please" remains |
| `"I'd like you to refactor auth"` | `refactor: I'd like you to refactor auth` | `true` (no check) | "I'd like you to" is conversational |

In practice, these candidates typically lose in heuristic comparison to the AI-generated message, but defense-in-depth is warranted.

### Fix

Add English conversational markers to `isValidCommitSubject`:

```typescript
/** English conversational markers similar to Japanese counterparts */
const CONVERSATIONAL_MARKERS_EN: RegExp[] = [
  /^(can|could|would|will)\s+you\s/i,
  /^please\s/i,
  /^(i|we)\s+(would\s+like|want|need)\s+(you\s+)?to\s/i,
  /^(i'?d\s+like\s+(you\s+)?to)\s/i,
  /^(add|fix|create|remove|update|change)\s+(a|an|the|some)\s/i,
];
```

Update the function body:
```typescript
function isValidCommitSubject(body: string, lang: string): boolean {
  if (lang === "ja") {
    // ... existing Japanese checks ...
  } else {
    // English conversational markers
    if (CONVERSATIONAL_MARKERS_EN.some((p) => p.test(body))) return false;
    // Question marks or exclamation marks indicate conversational tone
    if (/[?!]$/.test(body)) return false;
    // Too short to carry meaning
    if (body.length < 3) return false;
  }
  return true;
}
```

**Changes:** ~20 lines (new constant + function body restructuring).

---

## P2-3: Unit tests for key functions

**Severity:** Medium (process risk)
**Source:** Refinement-heuristics review Issue #8
**File:** New: `src/core/__tests__/auto-commit-message.test.ts` (or similar)

### Problem

All critical functions are pure (string in → string/number out) but have zero test coverage:

| Function | Pure? | Test priority |
|----------|-------|--------------|
| `isGenericMessage` | ✅ | **CRITICAL** — Japanese patterns must be verified |
| `cleanCommitOutput` | ✅ | **CRITICAL** — 4-layer extraction must handle all edge cases |
| `specificityScore` | ✅ | HIGH — Japanese/English parity |
| `sanitizeCommitMessage` | ✅ | HIGH — chatter stripping via cleanCommitOutput |
| `userMessageToCandidate` | ✅ | MEDIUM — type inference + truncation |
| `isValidCommitSubject` | ✅ | MEDIUM — English markers (P2-2) |
| `isCheapModel` | ✅ | LOW — regex matching, stable |
| `getBudgetMultiplier` | ✅ | LOW — wraps isCheapModel |
| `truncateDiffAtNewline` | ✅ | LOW — simple string operation |
| `buildTypeHintForMessage` | ✅ | LOW — wraps inferTypeFromFiles |

### Fix

Add a test file with focused test cases. Use the project's existing test framework (none currently configured — need to set up). If no framework exists, use Node's built-in `node:test` or add `vitest` as a dev dependency.

**Minimal test cases for `isGenericMessage`:**

```typescript
// Japanese generic messages MUST be detected
test("isGenericMessage detects Japanese generic patterns", () => {
  expect(isGenericMessage("fix: 修正しました")).toBe(true);
  expect(isGenericMessage("chore: 変更を適用")).toBe(true);
  expect(isGenericMessage("feat: 機能を追加")).toBe(true);
  expect(isGenericMessage("chore: ファイルを更新しました")).toBe(true);
});

// Japanese specific messages MUST NOT be detected as generic
test("isGenericMessage allows specific Japanese messages", () => {
  expect(isGenericMessage("feat: ログインフォームを追加")).toBe(false);
  expect(isGenericMessage("fix: nullチェックを追加")).toBe(false);
  expect(isGenericMessage("chore: 依存関係を更新")).toBe(false);
  expect(isGenericMessage("feat: 削除機能を追加")).toBe(false); // 削除 in compound
});
```

**Minimal test cases for `cleanCommitOutput`:**

```typescript
test("cleanCommitOutput extracts from markdown fences", () => {
  expect(cleanCommitOutput("```\nfeat: add login\n```")).toBe("feat: add login");
});

test("cleanCommitOutput strips chat prefixes", () => {
  expect(cleanCommitOutput("Here is the commit message: feat: add login"))
    .toBe("feat: add login");
  expect(cleanCommitOutput("コミットメッセージ: feat: ログイン追加"))
    .toBe("feat: ログイン追加");
});

test("cleanCommitOutput strips backtick wrapping", () => {
  expect(cleanCommitOutput("`feat: add login`")).toBe("feat: add login");
});

test("cleanCommitOutput picks first CC line from multiple options", () => {
  const input = "feat: add login\nfix: resolve bug\nchore: update deps";
  expect(cleanCommitOutput(input)).toBe("feat: add login");
});

test("cleanCommitOutput handles Japanese fence info strings", () => {
  expect(cleanCommitOutput("```コミットメッセージ\nfeat: ログインを追加\n```"))
    .toBe("feat: ログインを追加");
});
```

**Note on test framework:** The project currently has no test infrastructure. Before adding tests, determine:
- Use `node:test` (Node 18+, zero dependencies)
- Or add `vitest` as devDependency (more features, watch mode)

**Recommendation:** `node:test` for minimal overhead. Test file at `src/core/__tests__/auto-commit-message.test.ts`.

**Changes:** ~150 lines (test file), ~10 lines (package.json if vitest). No source code changes.

---

## P2-4: Defense-in-depth first-line extraction in `sanitizeCommitMessage`

**Severity:** Low
**Source:** Prompt-engineering review Issue #7, plan-risks review Section 6
**File:** `src/core/commit-message.ts`

### Problem

`sanitizeCommitMessage` uses the regex `/^(\w+)(\([^)]+\))?(!)?:\s*(.+)$/` **without** the `m` (multiline) flag. If a multi-line string is ever passed directly (bypassing `cleanCommitOutput`), the regex fails to match and the colon-fallback path produces garbage.

Currently safe because:
- `auto-commit-message.ts` always calls `cleanCommitOutput` before `sanitizeCommitMessage`
- `diff-analyzer.ts` has its own `parseHunks` cleanup

But future callers may not have this protection. A one-line defense costs nothing and prevents a class of bugs.

### Fix

Add first-line extraction at the top of `sanitizeCommitMessage`:

```typescript
export function sanitizeCommitMessage(
  message: string,
  files?: string[],
): string {
  // Defense-in-depth: take only the first non-empty line.
  // Multi-line input should have been cleaned by callers (cleanCommitOutput,
  // parseHunks), but this guards against future callers that forget.
  const firstLine = message
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  let sanitized = (firstLine || message).trim();
  // ... rest of function unchanged
```

**Changes:** ~5 lines (wrap existing `.trim()` in first-line extraction).

---

## Files Changed

| File | P2 Item | Changes |
|------|---------|---------|
| `src/core/auto-commit-message.ts` | P2-1, P2-2 | ~30 lines (new function + constant + function body) |
| `src/core/commit-message.ts` | P2-4 | ~5 lines |
| `src/core/__tests__/auto-commit-message.test.ts` (new) | P2-3 | ~150 lines |

## Risks

| Risk | Mitigation |
|------|-----------|
| `truncateDiffAtNewline` may return empty string if `\n` not found before maxChars | Fallback to `slice` (same behavior as current `truncate` fallback) |
| English conversational markers may false-positive | Patterns are anchored at `^` and use specific word sequences (`can you`, `could you`, `would you`). Legitimate commit messages don't start this way |
| Test framework choice may add unwanted dependency | `node:test` has zero dependencies and is built into Node 18+ |
| `sanitizeCommitMessage` first-line extraction breaks callers expecting multi-line | No caller passes multi-line input intentionally. The change is semantically neutral for single-line input |

## Validation

1. **P2-1**: Verify diff truncation at newline boundary with a diff containing `@@` headers
2. **P2-2**: Verify `isValidCommitSubject("can you add login", "en")` returns `false`
3. **P2-3**: Run `node --test src/core/__tests__/` and verify all pass
4. **P2-4**: Verify `sanitizeCommitMessage("feat: hello\n\ngoodbye")` returns `feat: hello`
