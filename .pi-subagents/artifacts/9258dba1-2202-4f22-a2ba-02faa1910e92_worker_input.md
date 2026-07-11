# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Continue the architecture deepening work in /Users/335g/dev/other/pi-autocommit. Two prior candidates are already in progress or complete.

Tackle the next candidate: **Inject the git seam into the commit reorganiser** (`src/commit-organizer.ts` / `src/git-operations.ts`).

Context:
- Read `CONTEXT.md` and `docs/adr/0001-commit-every-turn-strategy.md` for domain context.
- Read `/Users/335g/dev/other/pi-autocommit/.agents/skills/codebase-design/SKILL.md` and use its vocabulary (module, interface, depth, seam, adapter, leverage, locality).
- Read the already-completed `src/model-popup.ts` refactor as an example of moving logic behind a clean seam.

Goal:
- Make `organizeWipCommits` testable without a real git repository.
- Do not change its high-level reorganisation policy (count WIP checkpoints → soft reset → propose groups → commit each group → fallback to single commit).

Approach to follow:
1. Identify every `GitOperations` method used by `src/commit-organizer.ts`.
2. Define a narrow `CommitStore` interface in `src/commit-organizer.ts` (or a new small file) that exposes only those operations.
3. Refactor `organizeWipCommits` to accept a `CommitStore` instance instead of constructing `GitOperations` internally.
4. Provide a production adapter that wraps `GitOperations` and satisfies `CommitStore`.
5. Provide an in-memory test adapter that simulates git history/staging/commits so the reorganiser policy can be unit-tested.
6. Add unit tests for `organizeWipCommits` using the in-memory adapter:
   - zero WIP commits → no-op
   - single WIP commit → fallback or single group
   - multiple WIP commits → multiple logical groups
   - LLM failure → fallback to single commit
   - ensure staged state is left consistent

Constraints:
- Do not change the public interface of `commit-prompt.ts` or other modules.
- Keep `pipeline.ts` and `index.ts` unchanged; the production adapter is wired in `index.ts`'s `agent_end` handler.
- Run `npm test` and `npm run build`. All existing tests must pass.
- If a design decision is unclear, report the options and your recommendation instead of guessing.

When done, report:
- The new `CommitStore` interface
- File paths changed
- Test and build results
- Any risks or follow-ups
- Whether scope-ownership candidate looks already unified (quick check of `src/scope-resolver.ts` vs `src/commit-message.ts`)

## Acceptance Contract
Acceptance level: reviewed
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```