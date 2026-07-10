# Review: Add `model` config option for commit-message LLM generation

Scope: last 3 commits in `pi-git` (diff at `/tmp/pi-git-model-review.diff`).
Files changed: `src/config.ts`, `src/llm-commit.ts`, `src/commit-organizer.ts`,
`src/config.test.ts`, `README.md`, `README.ja.md`.

Verification performed:
- Read full diff at `/tmp/pi-git-model-review.diff` and current source for all four `.ts` files.
- Inspected `ExtensionContext` and `ModelRegistry` type definitions in
  `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
  and `dist/core/model-registry.d.ts`.
- Ran `npx tsc --noEmit` → no errors.
- Ran `npm test` → 29 tests pass / 0 fail (the previously-printed "1 failed"
  line was a stdout artefact from a concurrent run; the underlying TAP shows
  `ℹ pass 29 / ℹ fail 0`).

## Summary

The change adds an optional `model` config key in `"provider/modelId"` format
that overrides which LLM generates commit messages. A new `resolveModel(ctx,
config)` helper in `src/llm-commit.ts` validates the string, looks it up via
`ctx.modelRegistry.find(provider, modelId)`, checks
`hasConfiguredAuth(resolved)`, and falls back to `ctx.model` with a `console.warn`
on any failure. Both LLM call sites (`llm-commit.ts:generateCommitMessageWithLLM`
and `commit-organizer.ts:proposeCommitGroups`) are upgraded to use it.

The implementation is coherent, minimal, and consistent. `tsc` and tests pass.
Two notable issues and a few nits are listed below.

## Findings

### Blocker
None.

### Major
- **No test coverage for `resolveModel`** — `src/llm-commit.ts:15-56`.
  The new `resolveModel` helper carries the bulk of the new logic (slash-format
  validation, registry lookup, auth check, fallback-to-`ctx.model` with
  distinct warning messages). The only new tests added
  (`src/config.test.ts:38-76`) verify *parsing* of the `model` key in
  `loadConfig`; they never exercise `resolveModel`. As a result, the most
  behaviour-rich part of the change — including the three fallback branches
  and the format-validation boundary (`slashIdx < 1` vs
  `slashIdx >= modelStr.length - 1`) — is unguarded against regressions.
  A small unit test using a stub `{ find, hasConfiguredAuth }` as
  `ctx.modelRegistry` (the rest of `ExtensionContext` can be `{} as any` since
  `resolveModel` only touches `ctx.model` and `ctx.modelRegistry`) would cover:
  1. valid `modelStr` + registry hit + auth ok → returns resolved model.
  2. valid format but `find()` returns undefined → warns and falls back to
     `ctx.model`.
  3. `find()` hits but `hasConfiguredAuth` returns false → warns and falls
     back to `ctx.model`.
  4. invalid format (`"/foo"`, `"foo/"`, `""`) → warns and falls back.
  5. `config.model` unset → returns `ctx.model` directly (no warning).
  6. `ctx.model` undefined + fallback triggered → returns `undefined`
     (caller throws `"No model available"`).

### Minor
- **Unused imports in `src/config.test.ts:1`** — `before` and `after` are
  imported from `"node:test"` but never referenced anywhere in the file.
  `tsconfig.json` does not enable `noUnusedLocals`, so this does not fail the
  type check, but it is dead code that should be removed:
  `import { describe, it } from "node:test";`.

### Nit
- **Optional chaining on a required field** — `src/llm-commit.ts:41` and `:49`
  use `ctx.modelRegistry?.find(...)` and
  `ctx.modelRegistry?.hasConfiguredAuth(...)`. The `ExtensionContext` type
  (`...dist/core/extensions/types.d.ts`, line ~219) declares `modelRegistry:
  ModelRegistry` as **required, non-optional** (no `?`). The `?.` is therefore
  superfluous and slightly misleading — it implies the field may be undefined.
  Either drop the `?.` to match the type, or (if guarding against an
  under-populated runtime context) keep it and add a short comment explaining
  the defencive intent. `ModelRegistry.find` returns
  `Model<Api> | undefined` and `hasConfiguredAuth` returns `boolean`, so once
  `ctx.modelRegistry` is treated as non-null the call chain is type-safe.

### Note
- **`indexOf("/")` split semantics** — `resolveModel` splits on the first
  slash, so `"anthropic/claude/sonnet"` becomes provider=`"anthropic"`,
  modelId=`"claude/sonnet"`. Real model IDs don't contain slashes, so this
  would fall through to the not-found fallback gracefully, but the README
  tables (`README.md:131` / `README.ja.md:134`) describe the format only as
  `"provider/modelId"` and could explicitly note that there should be exactly
  one slash. Low impact because the fallback path is well behaved.

- **`Model<Api>` vs `Model<any>`** — `resolveModel` is typed to return
  `Model<Api> | undefined` while `ctx.model` is `Model<any> | undefined`.
  `Model<any>` is assignable to `Model<Api>`, so the return path is fine and
  `tsc` confirms; no action needed.

- **`commit-organizer.ts:proposeCommitGroups` ordering preserved** — the
  resolveModel/`!model` check still happens before the
  `await import("@earendil-works/pi-ai/compat")` and `git.getStagedDiff()`
  calls, matching the previous `if (!ctx.model)` ordering. No regression.

- **Regression-spread check** — grep for `ctx.model` direct uses that should
  have been converted: only the two intended call sites in
  `llm-commit.ts:144` and `commit-organizer.ts:117` were updated; no other
  `completeSimple(ctx.model, ...)` usages remain. Conversion is consistent.

## Correctness assessment

- Fallback logic: correct. When `config.model` is unset OR `ctx.model` is
  undefined, returns `ctx.model` without warning; otherwise validates and
  resolves, warning specifically about each failure mode (bad format /
  not found / no auth).
- Format validation: correct boundaries — rejects leading/trailing slash
  (`slashIdx < 1` and `slashIdx >= modelStr.length - 1`).
- Auth check: correct — uses `hasConfiguredAuth(resolved)` (synchronous,
  confirmed in `ModelRegistry` def) before returning the resolved model.
- `loadConfig` parsing: trims and discards empty/whitespace-only strings,
  consistent with the existing `lang` handling pattern.
- Both LLM call sites upgraded symmetrically.

## Recommendation

Approve once Major #1 (add `resolveModel` tests) and Minor #2 (drop unused
`before`/`after` imports) are addressed. The nit about `ctx.modelRegistry?.`
is cosmetic and can be folded in opportunistically.