# pi-autocommit Architecture Report

## Scope
This report surveys the source under `src/` and its tests, applying a module-depth lens and the deletion test: "if I delete this file, how many other files break and how much domain knowledge walks away with it?"

Vocabulary used: module, interface, implementation, depth, deep, shallow, seam, adapter, leverage, locality.

---

## 1. Module Responsibilities and Sizes

| Module | Lines | Core responsibility |
|--------|-------|---------------------|
| `src/index.ts` | 399 | Extension wiring: command registration (`/autocommit-enable`, `/autocommit-model`), event handlers (`session_start`, `turn_end`, `agent_end`), TUI popup rendering, and pipeline event dispatch. |
| `src/pipeline.ts` | 83 | One-shot checkpoint commit executor (`runCheckpointCommit`) with status checks, staging, commit, and error-boundary unstage. |
| `src/commit-organizer.ts` | 160 | Reorganiser at `agent_end`: counts WIP checkpoints, soft-resets, calls the LLM to split changes into groups, commits each group, and falls back to a single commit. |
| `src/commit-prompt.ts` | 471 | **Deepest module.** Prompt assembly for single/group commits, LLM adapter seam (`CompleteFn`), response cleanup, group parsing, deterministic scope injection, assistant-context extraction, and heuristic fallback. |
| `src/commit-message.ts` | 223 | Heuristic commit-message generator when LLM is unavailable: type detection, subject/body generation, formatting. |
| `src/commit-types.ts` | 22 | Single source of truth for Conventional Commits types (`COMMIT_TYPES`). |
| `src/commit-decider.ts` | 30 | Heuristic: should a `turn_end` produce a checkpoint commit based on tool names? |
| `src/commit-events.ts` | 20 | Shared event types for pipeline results. |
| `src/config.ts` | 169 | Config load/save (`loadConfig`, `saveEnable`, `saveModel`) for `.pi/pi-autocommit.json`. |
| `src/git-operations.ts` | 254 | Thin wrapper around `git` CLI calls via `pi.exec`. |
| `src/git-parser.ts` | 33 | Parser for `git diff --cached --name-status` output. |
| `src/llm-commit.ts` | 84 | Model resolution/validation (`resolveModel`, `validateModelString`) against `ctx.modelRegistry`. |
| `src/model-popup.ts` | 77 | Model selector popup item builder and viewport constant. |
| `src/scope-resolver.ts` | 163 | Deterministic scope resolution: user mapping cascade, longest-literal matching, heuristic fallback, scope injection. |
| `src/status-indicator.ts` | 31 | Footer status updater for uncommitted changes. |

Total source: ~2,376 lines. Tests: ~1,403 lines across 9 test files.

---

## 2. Shallow Modules (Wide Interface Relative to Implementation)

A module is shallow when its public surface is large but the implementation is thin or purely pass-through.

- **`src/git-operations.ts` (254 lines, 18 public methods)** — This is a broad, shallow adapter. Every method is a thin wrapper over one `git` invocation (`isInsideGitRepo`, `checkStatus`, `stageAll`, `getStagedStat`, `getStagedDiff`, `getStagedNameStatus`, `hasMergeConflict`, `commit`, `unstageFile`, `unstageAll`, `getFileStagedDiff`, `getFileStagedNumstat`, `getFullStatus`, `checkUncommittedChanges`, `countWipCommits`, `resetSoft`, `stageFiles`). The interface width is justified by the variety of git commands needed, but there is almost no domain depth; all knowledge lives in callers. *Deletion test*: deleting this file destroys every git seam but no domain logic.

- **`src/commit-events.ts` (20 lines)** — Pure type surface, zero implementation. Necessary but not deep.

- **`src/commit-types.ts` (22 lines)** — Pure data surface, but the comment calls it the "single source of truth for all commit type domain knowledge." It is wide in semantic importance relative to its line count; arguably shallow in implementation but deep in leverage.

- **`src/status-indicator.ts` (31 lines)** — Tiny wrapper around `git.checkUncommittedChanges()` + `ctx.ui.setStatus`. Very shallow; exists mainly to avoid duplicating the footer update call.

- **`src/model-popup.ts` (77 lines)** — Mostly data transformation (`buildModelSelectItems`) and one trivial helper. The actual TUI rendering is in `index.ts`, so the module is shallower than it looks.

---

## 3. Complexity Leaking Across Seams

A seam leaks when a caller must know internals of the callee to use it correctly.

- **`commit-prompt.ts` ↔ `commit-message.ts` heuristic fallback** (`commit-prompt.ts:471` calls `commit-message.ts`)
  - `completeSingleMessage` swallows all errors and falls back to `heuristicSingleMessage`, which delegates to `generateCommitMessage`. The fallback is silent and leaks the assumption that callers do not need to know whether the message came from the LLM or the heuristic. This is intentional but means output quality is non-deterministic across seams.

- **`commit-organizer.ts` ↔ `commit-prompt.ts` ↔ `llm-commit.ts`**
  - `commit-organizer.ts:160` calls `completeCommitGroups`, which lazily imports `resolveModel` from `llm-commit.ts` at runtime (`commit-prompt.ts:471`). The import is dynamic, so the seam is not visible in static imports. *A reader must open three files* to trace how a model is resolved for group propositions.

- **`index.ts` ↔ `model-popup.ts` ↔ `config.ts` model popup**
  - `index.ts` calls `buildModelSelectItems` and also has its own `buildModelOptions` fallback for non-TUI. The two builders duplicate the "clear first, mark current, append unavailable" logic. If `model-popup.ts` changes its ordering or sentinel, `index.ts` must also change its fallback parsing (`index.ts:148-176` vs `model-popup.ts:45-77`). Complexity leaks because the same domain rule (how to render model choices) is implemented twice across the seam.

- **`commit-prompt.ts` scope injection**
  - `injectScopeIntoMessage` and `resolveScope` are in `scope-resolver.ts`, but `commit-prompt.ts` must know the contract: "tell the LLM not to include scope, then inject it later." This contract is duplicated in prompt text (`buildSingleSystemPrompt`, `buildGroupsSystemPrompt`) and in post-processing. If the injection regex changes, the prompt instructions can become inconsistent.

---

## 4. Understanding Requires Bouncing Between Many Files

- **Checkpoint flow:** `index.ts:285` → `pipeline.ts:24` → `git-operations.ts` → `commit-events.ts`. To understand a checkpoint commit you open 4 files.
- **Reorganiser flow:** `index.ts:316` → `commit-organizer.ts:34` → `commit-prompt.ts` (for groups) → `llm-commit.ts` (dynamic import) → `scope-resolver.ts` (injection). To understand the LLM commit-group path you open 5 files.
- **Model selection flow:** `index.ts:183` (`showModelPopup`) uses `model-popup.ts` for TUI items, has its own `buildModelOptions` for non-TUI, calls `validateModelString` in `llm-commit.ts`, and persists via `config.ts`. The TUI path also touches `@earendil-works/pi-tui` types inline. This is the most cross-cutting surface in the codebase.
- **Scope resolution flow:** `commit-message.ts:144`, `commit-prompt.ts:471`, and `scope-resolver.ts:163` all touch scope. The heuristic in `scope-resolver.ts` is an extraction from the original `commit-message.ts`, but `commit-message.ts` still calls `resolveScope`, so the two files are tightly coupled.

---

## 5. Missing or Hard-to-Write Tests Through Current Interfaces

Tests are comprehensive at the unit level (102 passing), but integration-shaped seams are hard to exercise:

- **`pipeline.ts`**: No direct test file. `runCheckpointCommit` requires a real `ExtensionAPI` with `pi.exec`. Because `GitOperations` is constructed inside the function, it cannot be injected; testing would require a git repo + pi mock.
- **`commit-organizer.ts`**: No direct test file. `organizeWipCommits` orchestrates soft reset, group commits, and fallback. It requires a real git history and a real LLM adapter or stub; the module constructs `GitOperations` internally.
- **`index.ts`**: No test file. Command handlers and event handlers depend on `ExtensionAPI`, `ExtensionContext`, and `@earendil-works/pi-tui` widgets. The TUI popup code is embedded directly in the handler, making it impossible to unit-test without rendering.
- **`status-indicator.ts`**: No test file. Depends on `GitOperations` and `ctx.ui.setStatus`.
- **`GitOperations` seam**: `git-operations.ts` has no tests. Every method shells out through `pi.exec`; the interface is wide but shallow, so mocking is tedious and the value-per-test is low.
- **Error boundary in `pipeline.ts:83`**: `unstageAll` cleanup on failure is not tested because `runCheckpointCommit` cannot be injected with a fake git.

---

## 6. Duplication and Near-Duplication

1. **Model option builders (near-duplication)**
   - `src/index.ts:86-110` (`buildModelOptions`) and `src/model-popup.ts:45-77` (`buildModelSelectItems`) both iterate `ctx.modelRegistry.getAvailable()`, prepend the clear entry, mark the current model, and append an unavailable current model. Only the output shape differs (`string[]` vs `SelectItem[]`).

2. **Scope/format instructions in prompts (duplicated domain rule)**
   - `commit-prompt.ts:235-240` (`buildGroupsSystemPrompt`) and `commit-prompt.ts:333-351` (`buildSingleSystemPrompt`) both encode the "scope managed → no scope in LLM output" rule.
   - `commit-prompt.ts:244-248` and `commit-prompt.ts:340-341` both contain language-specific subject/body instructions; they are computed by `subjectLangInstruction`/`bodyLangInstruction` helpers, but the inline variants in `buildGroupsSystemPrompt` duplicate the helper logic.

3. **Text extraction from message content (near-duplication)**
   - `commit-prompt.ts:109-118` (`extractText`) and `commit-prompt.ts:173-181` (`extractAssistantContext`) both filter content arrays for text blocks. The shapes differ slightly (adapter response vs assistant message), but the logic is structurally identical.

4. **LLM fallback cleanup (duplicated silently)**
   - `cleanupResponse` strips code fences/backticks for single messages.
   - `parseCommitGroups` does not strip fences; if the group LLM wraps output in markdown, parsing fails. The cleanup logic is not reused for groups, creating an asymmetric seam.

5. **`commit-message.ts` ↔ `scope-resolver.ts` heuristic**
   - `scope-resolver.ts:163` contains `determineScopeHeuristic`, which was extracted from `commit-message.ts` but the original file still imports `resolveScope` from `scope-resolver.ts`. The two modules are now mutually dependent in concept even if not in import cycle.

---

## 7. Specific Candidates for Deepening

### High-leverage deepening targets

1. **`src/commit-prompt.ts` — already the deepest module, but can be deeper**
   - File: `src/commit-prompt.ts` (471 lines)
   - Candidate: split the prompt builder, adapter seam, response cleanup/parser, and scope injection into sub-modules or package-private helpers. The module currently owns ~6 distinct responsibilities.
   - Why: it is the single place where LLM, heuristic, scope, language, and cleanup policies meet. Concentrating them is correct, but 471 lines is large enough that a reader cannot hold the whole interface in working memory.

2. **`src/commit-organizer.ts` — thin orchestrator with hidden git complexity**
   - File: `src/commit-organizer.ts` (160 lines)
   - Candidate: introduce an injectable `CommitPlanner` or `ReorganizerStrategy` seam so the function does not directly instantiate `GitOperations`. This would make the orchestrator testable and let the git-operations detail move behind an adapter.
   - Why: the file mixes high-level policy ("soft reset WIPs, split into groups, commit each") with low-level git error handling. A seam would let tests verify the policy without a real git repo.

3. **`src/index.ts` — presentation and wiring are entangled**
   - File: `src/index.ts` (399 lines)
   - Candidate: extract command handlers (`autocommit-enable`, `autocommit-model`) and event handlers into separate modules. The TUI popup rendering (`showModelPopup`, ~70 lines) could move to `model-popup.ts`, where the item-building logic already lives.
   - Why: `index.ts` is the largest file and the only one that knows about TUI widgets, command registration, and pipeline orchestration. Splitting it would localize UI knowledge and make handlers independently testable.

4. **`src/git-operations.ts` — wide shallow adapter**
   - File: `src/git-operations.ts` (254 lines)
   - Candidate: group methods into cohesive sub-adapters (e.g., `StagingOperations`, `DiffOperations`, `CommitHistoryOperations`) or split into a smaller core plus query objects. Alternatively, make the methods accept fewer one-off commands by exposing higher-level operations like `prepareCommit()`.
   - Why: 18 public methods on one class forces every caller to know which low-level git command to invoke. A deeper module would encapsulate common sequences.

5. **`src/model-popup.ts` — split rendering from item building**
   - File: `src/model-popup.ts` (77 lines) and `src/index.ts:119-176`
   - Candidate: move `showModelPopup` and `buildModelOptions` fully into `model-popup.ts`, leaving `index.ts` to call a single `showModelPopup(ctx, currentModel)` function.
   - Why: the popup currently has two implementations of the same list-building rule. Consolidating them removes duplication and improves locality.

6. **`src/commit-message.ts` and `src/scope-resolver.ts` — merge or clarify ownership**
   - Files: `src/commit-message.ts` (223 lines), `src/scope-resolver.ts` (163 lines)
   - Candidate: either make `scope-resolver.ts` the sole owner of all scope logic (including the heuristic), or move `determineScopeHeuristic` back and have `commit-message.ts` depend on it. The current split is historical, not conceptual.
   - Why: `commit-message.ts` imports `resolveScope`, and `scope-resolver.ts` contains a function extracted from `commit-message.ts`. This creates confusion about which module owns scope.

7. **`src/commit-prompt.ts` response cleanup for groups**
   - File: `src/commit-prompt.ts:235-270` (`parseCommitGroups` and callers)
   - Candidate: reuse `cleanupResponse` before `parseCommitGroups`, or make the parser fence-aware.
   - Why: the single-message path strips markdown fences; the group path does not. This asymmetry is a latent bug and a seam leak.

---

## 8. Summary Friction Map

| Area | Friction | Recommended first move |
|------|----------|------------------------|
| `index.ts` | Too many responsibilities (commands, TUI, wiring, handlers) | Extract TUI popup to `model-popup.ts`; extract command handlers to `commands/` |
| `commit-prompt.ts` | Large module with many private policies | Split prompt builders and response cleanup into helpers or sibling files |
| `commit-organizer.ts` | Untestable because it constructs `GitOperations` | Inject a git-interface seam |
| `git-operations.ts` | Wide, shallow adapter | Group into smaller adapters or higher-level operations |
| `model-popup.ts`/`index.ts` | Duplicate list-building rule | Consolidate both builders into `model-popup.ts` |
| `commit-prompt.ts` groups | No markdown cleanup before parsing | Reuse `cleanupResponse` for group LLM output |
| `commit-message.ts`/`scope-resolver.ts` | Historical split of scope logic | Clarify single ownership |

---

## Start Here

**First file to open for a refactoring pass: `src/index.ts`**

It is the largest file (399 lines), the only file that touches the TUI rendering library, command registration, and pipeline orchestration, and it duplicates model-popup logic with `model-popup.ts`. Reducing its surface area first will make the other seams easier to see and deepen.