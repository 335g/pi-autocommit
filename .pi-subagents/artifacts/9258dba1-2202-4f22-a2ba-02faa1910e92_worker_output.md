Implemented the git seam injection into the commit reorganiser.

## What changed

- **`src/commit-store.ts`** (new) — defines the `CommitStore` interface and the production `GitCommitStore` adapter that wraps `GitOperations`.
- **`src/commit-organizer.ts`** — `organizeWipCommits` now accepts a `CommitStore` instance and an optional `CompleteFn` instead of constructing `GitOperations` internally. `ExtensionAPI` is no longer imported here.
- **`src/index.ts`** — wires `GitCommitStore(new GitOperations(pi))` into the `agent_end` handler.
- **`src/commit-organizer.test.ts`** — added `InMemoryCommitStore` and 6 new tests covering: no-op outside repo, no-op with zero WIPs, single-group reorganisation, multi-group reorganisation, LLM-failure fallback, and independent staging per group.

## Scope-ownership check

Already unified. `src/scope-resolver.ts` owns `resolveScope`, `hasScopeMapping`, `injectScopeIntoMessage`, and the heuristic fallback `determineScopeHeuristic`. `src/commit-message.ts` only imports and calls `resolveScope` — no split remains.

## Validation

- `npm test`: **116 tests passed**
- `npm run build`: **passed**

No files are staged.