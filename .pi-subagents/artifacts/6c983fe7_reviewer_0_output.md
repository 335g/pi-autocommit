## Review: Extract UI notifications from commit pipeline

### Correct (what is already good)

1. **Problem identification is precise.** The plan correctly inventories all 13+ `ctx.ui.*` calls across `pipeline.ts:142-315` and `commit-organizer.ts:73-358`, including the duplicated `updateFooterStatus` in both modules. This is evidence-based and complete.

2. **Architecture direction is sound.** Moving UI concerns out of business-logic modules while keeping error-boundary cleanup (unstageAll, footer invariants) in the pipeline is the right separation — cleanup is a domain invariant, not presentation.

3. **Files intentionally left unchanged are justified.** `reviewer.ts`, `confirmation.ts`, `file-selector.ts` are correctly excluded because they own interactive control flow (not just notification). The plan explains why each stays.

4. **Event types are well-chosen.** The `PipelineEvent` discriminated union (`info | error | dry-run | committed | cancelled | generating | stage-changed`) maps cleanly to the existing notification patterns. Returning events from the function rather than using callbacks makes tests trivial — `assert.equal(result.events[0].type, "info")`.

5. **Step ordering is logical.** Types → refactor pipeline → refactor organizer → extract StatusIndicator → presenter → tests. Each step depends on the previous.

6. **Domain vocabulary alignment is correct.** The plan uses "commit pipeline", "commit reorganiser", "checkpoint commit", and "file selection" exactly as defined in `CONTEXT.md`. No drift.

---

### Blocker: UX regression for the "Generating…" notification

**Location:** Step 2 (pipeline.ts), line `ctx.ui.notify("Generating commit message via LLM…", "info")` at `src/pipeline.ts:269`.

**Issue:** This notification is a *progress indicator* — it fires *before* `await generateCommitMessageWithLLM(...)` (a multi-second LLM call) so the user sees immediate feedback. With the events-array approach, all `events.push()` calls happen synchronously during execution, but the presenter in `index.ts` iterates over events *after* `await runCommitPipeline()` returns. By that time the LLM call has already completed, so the "Generating…" notification would appear too late to serve its purpose.

This is a genuine regression in UX. The plan's "Events vs callbacks vs return value" section (Open Question 2) discusses testability and async overhead but never considers the *progress/streaming* use case.

**Recommendations:**
- Keep this single `ctx.ui.notify(...)` call in the pipeline (as an expedient) with a comment marking it as the only remaining direct UI call, OR
- Pass a progress callback (e.g. `onProgress?: (event: PipelineEvent) => void`) alongside the return-value events so the presenter can stream real-time notifications while still getting a deterministic event array for post-hoc processing, OR
- Accept the UX change and remove the notification entirely (simplest, but loses useful feedback).

The plan should acknowledge this tradeoff explicitly.

---

### Blocker: Error-boundary events are lost on throw

**Location:** Step 2 (pipeline.ts), error boundary at `src/pipeline.ts:336-352`.

**Issue:** The plan states:

> "The error boundary still throws, but cleanup events are appended before re-throw."

If the pipeline throws, the function does **not** return a `PipelineResult`. Events appended before the re-throw (including the `stage-changed` event for footer cleanup) are **never consumed** by the presenter — the `index.ts` catch block only calls `ctx.ui.notify(errorMessage, "error")`, not `statusIndicator.updateFooter()`.

Currently, the error boundary calls `await updateFooter()` directly *before* re-throwing, so the footer is updated. After the plan, this update must happen in the `index.ts` catch block instead, or the plan must keep a direct `updateFooter()` call in the error boundary.

**Recommendation:** The `index.ts` catch block in each handler must also call `await statusIndicator.updateFooter()` (or equivalent). The plan should document this requirement. Alternatively, keep the direct `updateFooter()` call in the pipeline's error boundary since it's an invariant, not presentation.

---

### Note: Type mismatch — `stage-changed` event lacks `hasChanges` payload

**Location:** Step 1 (`src/commit-events.ts`).

The plan defines `stage-changed` as:
```typescript
| { type: "stage-changed" };  // footer status changed
```

But Step 2 says:
> `events.push({ type: "stage-changed", hasChanges })`

The type definition has no `hasChanges` property. Either:
- Add `hasChanges: boolean` to the `"stage-changed"` variant so the `StatusIndicator` doesn't need to re-check via `git`, or
- Remove `hasChanges` from the emit site and let `StatusIndicator.updateFooter()` re-check (slightly more I/O but simpler types).

---

### Note: Organizer event space is disjoint from pipeline event space

**Location:** Steps 1, 3, 5.

The plan defines `PipelineEvent` and `OrganizerEvent` as separate unions. The presenter in `index.ts` would need two separate render loops (one for pipeline results, one for organizer results). While not a blocker, the plan's Step 5 only shows a switch for `PipelineEvent`. The `agent_end` handler that calls `organizeWipCommits` would need a parallel switch for `OrganizerEvent`.

**Recommendation:** Either define a shared `UIEvent` supertype, or acknowledge in the plan that the presenter will have two parallel switch statements.

---

### Note: `runCommitPipeline`'s `ctx` parameter — worth documenting the remaining dependency

**Location:** Open Question 1.

The plan correctly notes that `ctx` is still needed for `selectFiles(ctx, ...)`. However, `ctx` is also accessed at `pipeline.ts:178` (`ctx.mode`) for deciding whether to fetch `fileDetails`. After the refactor, `ctx` would only be used for `selectFiles` (line 226) and `ctx.mode` (line 178). This is fine, but the plan could explicitly note that the remaining `ctx` coupling is through `file-selector.ts`, which is out of scope.

---

### Risk: Pipeline return-type change is breaking

The plan changes `runCommitPipeline` from `Promise<void>` to `Promise<PipelineResult>`. The only caller is `index.ts` (3 call sites), so the blast radius is small. But the function is exported — if there are external consumers of the package, this is a breaking change. Low risk for this codebase.

Similarly, `organizeWipCommits` changes from `Promise<void>` to `Promise<OrganizerResult>` and is exported.

---

### Summary

| Dimension | Assessment |
|---|---|
| **Coherent** | Yes — well-structured, evidence-based, correctly scoped |
| **Achievable** | Yes — each step is concrete and bounded |
| **Architecture alignment** | ✓ Uses `CONTEXT.md` vocabulary correctly, follows single-responsibility principle |
| **Blocker issues** | 2 (UX regression for "Generating…" notification; error-boundary events lost on throw) |
| **Minor issues** | 2 (type mismatch on `stage-changed`; presenter needs two event loops) |
| **Unaddressed risk** | Error-boundary footer update must move to index.ts catch blocks |
| **Step ordering** | ✓ Logical, with prerequisite types first |

**Conclusion:** The plan is well-conceived and the refactoring direction is correct. It must resolve the two blocker issues before implementation — the "Generating…" notification timing problem is the most significant because it affects user experience and the plan's current architecture (return-only events) can't express it.

---