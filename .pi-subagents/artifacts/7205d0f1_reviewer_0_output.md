# Review: Updated Plan — Extract UI Notifications from Commit Pipeline

## Blocker verification

### Blocker 1: UX regression for "Generating…" notification → RESOLVED ✓

The plan introduces `PipelineCallbacks.onProgress`, an optional synchronous callback fired before `await generateCommitMessageWithLLM(...)` (Step 2). The presenter in index.ts passes it:

```
onProgress: (event) => {
  if (event.type === "generating") {
    ctx.ui.notify("Generating commit message via LLM...", "info");
  }
}
```

**Why this works:**
- The callback fires before the async LLM call, so `ctx.ui.notify` executes immediately (not deferred to after return).
- The pipeline never `await`s the callback and doesn't depend on its result — zero latency overhead.
- The callback is scoped to the LLM path only (inside the `else` branch alongside the original `ctx.ui.notify`).

**Edge cases checked:**
- `inlineMessage` set → the LLM path is skipped and `onProgress` is not called. ✓
- Callback is passed via `CommitPipelineOptions.callbacks` → the options interface would gain a new `callbacks` field (implicit in the plan, not yet shown in the interface definition). Minor clarity issue but not a blocker.
- Pipeline early-returns before LLM call (no changes, merge conflict, cancellation) → `onProgress` is never reached. ✓

### Blocker 2: Error-boundary events lost on throw → RESOLVED ✓

The plan moves footer-update responsibility entirely to each caller's catch block in index.ts. The pipeline's error boundary keeps only `unstageAll` cleanup and re-throws.

**Why this works:**
- `PipelineResult` (containing `events[]`) is only returned on the normal return path. On throw, no result is returned, so no events are lost — they were never written to a result object.
- Every pipeline caller in index.ts already has a catch block that notifies errors. Adding `statusIndicator.updateFooter()` is a one-line addition.
- The `committed` boolean in `PipelineResult` is only `true` on the success path (not set if a post-commit hook throws), so it can never report `committed: true` alongside a thrown error.

**Edge cases checked:**
- Pipeline throws before any event accumulation → no events lost (none created). ✓
- Pipeline throws after partial event accumulation (e.g., during LLM call) → the `events[]` array was being built but is never returned; only the error propagates. The presenter's catch block notifies the error and updates footer. ✓
- Error boundary re-throws after `unstageAll` → the caller catch block runs, so `statusIndicator.updateFooter()` will see the post-unstage state. ✓

---

## Internal consistency audit

### Step 1 → Step 2 (pipeline events)

`PipelineEvent` defines the seven event types. Step 2 maps each `ctx.ui.notify(...)` call in pipeline.ts to a matching `events.push(...)`. All event types referenced in Step 2 exist in the type. ✓

### Step 1 → Step 3 (organizer events)

**INCONSISTENCY FOUND.** Step 1 defines `OrganizerEvent` with four variants:

```typescript
export type OrganizerEvent =
  | { type: "info"; message: string }
  | { type: "error"; message: string }
  | { type: "organised"; checkpointCount: number; commitCount: number }
  | { type: "fallback"; message: string };
```

Step 3 says: *"`updateFooterStatus` becomes `events.push({ type: "stage-changed" })`."* — but `"stage-changed"` is **not** a member of `OrganizerEvent`. The presenter switch at Step 5 also omits a `"stage-changed"` case for the organizer.

**Impact:** Without `stage-changed` (or an explicit presenter footer call on success), the footer status bar will **not** be updated after `organizeWipCommits` completes successfully — the current `finally { await updateFooterStatus(pi, ctx) }` is removed.

**Fix:**
- Option A: Add `{ type: "stage-changed" }` to `OrganizerEvent` and handle it in the presenter.
- Option B: Have the presenter always call `statusIndicator.updateFooter()` after processing events in the success path (post-loop, inside `try`).

The note in Step 5 acknowledges the tension but doesn't resolve it — it says *"the organiser always updates footer at the end via the catch block or via events that are guaranteed non-throw"* but `OrganizerEvent` has no event type that triggers a footer update.

### Step 3 detailed — `fallbackSingleCommit` event emission

**GAP.** `fallbackSingleCommit` (commit-organizer.ts line 333) currently calls:

```typescript
ctx.ui.notify(
  `Reorganisation fell back to a single commit:\n${message.split("\n")[0]}`,
  "info",
);
```

The plan says to replace this with an event push, but `fallbackSingleCommit` has no access to the events array (signature: `(pi, ctx, config, git)`). It is called from two sites inside `organizeWipCommits` (try-block line 56 and catch-block line 82), both of which do have the events array.

The plan should specify one of:
- Change `fallbackSingleCommit` to return an `OrganizerEvent` that the caller pushes.
- Accept `events: OrganizerEvent[]` as a parameter.

### Step 5 — Missing `turn_end` presenter pattern

Step 5 shows two presenter patterns (git-commit and agent_end/organizer), but the `turn_end` handler also calls `runCommitPipeline` and needs the same treatment. Since `turn_end` uses `inlineMessage` (no LLM call), it doesn't need `onProgress`, but it still needs the event-loop + catch-block-footer pattern. Minor gap; easy to add.

### Step 5 — `git-review` handler's specific error branches

The `/git-review` handler intercepts `ReviewSendToAgentError` and `ReviewCancelledError` before the generic catch. Neither branch currently calls `statusIndicator.updateFooter()`. After refactor, these branches should also call it for consistency, since the pipeline's error boundary (which does `unstageAll`) has already run for `ReviewSendToAgentError`. Not a regression (current code doesn't update footer on these paths either), but the plan should note this.

---

## New issues introduced

### Issue 1: Organizer footer gap (see Internal consistency above)

**Severity:** Medium — would cause a visual bug where the footer status bar is stale after `agent_end` reorganisation succeeds.

### Issue 2: `fallbackSingleCommit` event plumbing unspecified

**Severity:** Low-Medium — easily resolved but not currently specified.

### Issue 3: Testing gap — `onProgress` not mentioned

Step 6 lists "verify `PipelineResult.events` content for each path" but doesn't mention testing the `PipelineCallbacks.onProgress` callback. The callback is part of the public API and should be tested (mock callback and verify invocation + timing).

### Issue 4: `onProgress` callback throw risk

If the `onProgress` callback itself throws (e.g., `ctx.ui.notify` throws for some environment reason), the error propagates into the pipeline, potentially aborting the LLM call. The plan says the pipeline "never awaits it and doesn't depend on its result" but doesn't say anything about defensive wrapping. Consider wrapping the callback in a try-catch (at least a no-op guard) inside the pipeline.

### Issue 5: Type-extending `CommitPipelineOptions`

The plan passes `callbacks` inside `CommitPipelineOptions` but the current interface doesn't define a `callbacks` field. This is a necessary addition but should be explicitly listed in the "Files changed" table at Step 7 (or Step 2).

---

## Domain vocabulary alignment (CONTEXT.md)

| Term in plan | CONTEXT.md term | Status |
|---|---|---|
| Commit pipeline | Commit pipeline | ✓ Match |
| Commit reorganiser | Commit reorganiser | ✓ OK (spelling variance "organizer"/"reorganiser" is pre-existing) |
| Checkpoint commit | Checkpoint commit | ✓ Match |
| File selection | File selection | ✓ Match |
| PipelineResult / PipelineEvent / OrganizerEvent | (new internal types) | ✓ No conflict |
| StatusIndicator | (new class) | ✓ No conflict |
| CommitPresenter (concept) | (presentation concern in index.ts) | ✓ Aligns with "index.ts is the coordinator" pattern |

No new domain terms introduced. The plan correctly keeps `reviewer.ts`, `confirmation.ts`, and `file-selector.ts` unchanged because those UI calls are intrinsic to their interactive contracts, not pipeline progress signalling.

---

## Summary

### What's solid
- Both blockers are properly resolved with minimal, coherent mechanisms.
- The `callbacks + return-value` hybrid pattern is well-motivated: `events[]` for post-hoc assertions (deterministic ordering), `onProgress` for real-time UI feedback (synchronous fire-and-forget).
- The separation of concerns (pipeline/organizer return events, presenter maps them to UI) is clean and testable.
- Error boundary simplification (unstageAll only, footer delegated to callers) is correct and safer than the current approach with dual responsibility.
- All line numbers in the existing-file analysis match the current source.

### Top 3 items to resolve before implementation

1. **Organizer footer gap:** Add `stage-changed` to `OrganizerEvent` (or presenter post-loop footer call). Without this, the footer will be stale after `agent_end` reorganisation succeeds.

2. **`fallbackSingleCommit` event plumbing:** Specify how its `ctx.ui.notify` call becomes an event push (return value or parameter).

3. **Presenter for `turn_end` handler:** Extend Step 5 to show the pattern for the `turn_end` handler (simpler — no `onProgress` needed, but same catch-block footer invariant).

### Residual risks
- `onProgress` callback throw is unguarded — low risk but worth a defensive try-catch.
- `git-review` handler's specific error branches (`ReviewSendToAgentError`, `ReviewCancelledError`) are not covered by the footer invariant in the plan — pre-existing gap, not a regression.

---

## Acceptance report