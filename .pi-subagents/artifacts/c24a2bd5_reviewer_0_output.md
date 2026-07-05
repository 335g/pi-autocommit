I now have a complete picture of the changes. Let me compile my findings.

---

## Review

### 1. Event type unification (`commit-events.ts`) — ✅ Correct

The removal of `OrganizerEvent` is clean. `PipelineEvent` now includes all variants (`organised`, `fallback`, `stage-changed`) that were previously split across two types. `OrganizerResult.events` is now correctly typed as `PipelineEvent[]`. No stale references to `OrganizerEvent` remain anywhere in `src/`.

### 2. Event dispatch consolidation (`index.ts`) — ✅ Correct with minor note

The `handlePipelineEvents` helper correctly covers all event types that appear in `PipelineEvent[]` arrays:

| Variant | Handled | Notes |
|---|---|---|
| `info` | ✅ `ctx.ui.notify(msg, "info")` | |
| `error` | ✅ `ctx.ui.notify(msg, "error")` | |
| `dry-run` | ✅ `ctx.ui.notify(msg, "info")` | |
| `committed` | ✅ `ctx.ui.notify(msg, "info")` | |
| `cancelled` | ✅ `ctx.ui.notify(reason, "info")` | |
| `organised` | ✅ notification with counts | |
| `fallback` | ✅ `ctx.ui.notify(msg, "warning")` | |
| `stage-changed` | ✅ `await statusIndicator.updateFooter()` | |
| `generating` | ⚠️ Not handled — intentional, only used as progress callback | |

The three call sites (`git-commit`, `turn_end`, `agent_end`) all correctly call `handlePipelineEvents`. No unreachable branches, no missing events.

**Readability:** The function is well-documented with a JSDoc comment. The switch is clear and each case is minimal. No naming concerns — `handlePipelineEvents` accurately describes its purpose.

### 3. Simplified heuristic fallback (`commit-message.ts`) — ✅ Acceptable with dead-code note

The simplification follows the stated design principle: "No diff-content analysis — that would duplicate the LLM prompt's domain logic and drift independently." This is a defensible architectural choice.

**Preserved fallback coverage:**
- `docs` type when only `.md`/`docs/` paths changed ✅
- `test` type when only test paths changed ✅
- `chore` type when only config paths changed ✅
- `feat` type when any file has status `"A"` ✅
- `refactor` default for everything else ✅
- Bilingual subjects (Japanese/English) ✅
- Body listing files with status labels ✅

**What the simplified fallback loses (all acceptable for a fallback):**
- `fix` type: returns `"refactor: refactor code"` instead of `"fix: fix issues"` — the heuristic couldn't reliably detect fixes anyway from keywords
- `style` type: returns `"refactor"` instead of `"style"` — only detectable via diff analysis
- `perf` type: same story
- `BREAKING CHANGE` footer: removed from fallback — never reliable at the heuristic level
- Specific subjects like `"追加 foo"` → now uses generic `"新機能を追加"` — less informative but still readable

**Note (minor): dead code in `extractSubject`.**
`determineType` can now only return `"docs"`, `"test"`, `"chore"`, `"feat"`, or `"refactor"`. The branches for `"fix"`, `"style"`, and `"perf"` in `extractSubject` are unreachable via the normal code path. Not a bug, but unnecessary code that could be removed.

### 4. Edge cases and regressions

- **BREAKING CHANGE detection removed:** The LLM path (`llm-commit.ts`) still handles BREAKING CHANGE via its prompt and `enforceNoBody` post-processing. The heuristic never reliably detected breaking changes, so removal is safe. If LLM is unavailable, breaking changes may be silently undetected, but this is an acceptable fallback trade-off.

- **`_stat` and `_diff` parameters kept as unused:** `generateCommitMessage` still accepts these parameters (prefixed with `_`) for backward compatibility with `llm-commit.ts`, which passes them. No caller needs updating.

- **NX uninformative fallback message:** The most generic case (mixed code changes, no new files) produces `"refactor: refactor code"` — a tautology. With a body of just `"Changes:\n- path/to/file — update"`, this is useful enough to identify which files changed. A user seeing this would know the LLM was unavailable and could edit the message.

- **No test coverage for `commit-message.ts`:** There are no unit tests for `determineType`, `extractSubject`, `generateBody`, or `generateCommitMessage`. This means the refactored heuristic has no automated guard against regressions.

### Summary

**No blockers.** The refactoring is architecturally sound, the consolidation eliminates duplication, and the heuristic simplification is a correct trade-off (simpler code with known limitations, accepting that the LLM path is the quality source). The only issues are minor: dead case branches in `extractSubject` and lack of test coverage for the heuristic module.

---