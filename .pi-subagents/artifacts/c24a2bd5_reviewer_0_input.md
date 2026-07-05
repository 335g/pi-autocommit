# Task for reviewer

Review the recent architectural refactoring in the pi-git extension. The changes span three files (src/commit-events.ts, src/index.ts, src/commit-message.ts) across three deepening opportunities:

1. **Event type unification** (`src/commit-events.ts`): `OrganizerEvent` was removed — `PipelineEvent` now includes `organised` and `fallback` variants. `OrganizerResult` now references `PipelineEvent[]` instead.

2. **Event dispatch consolidation** (`src/index.ts`): Three near-identical `switch(event.type)` loops (in `/git-commit`, `turn_end`, and `agent_end` handlers) were replaced by a shared `handlePipelineEvents()` helper function. The helper covers all event variants (info, error, dry-run, committed, cancelled, organised, fallback, stage-changed) in one place.

3. **Heuristic fallback simplification** (`src/commit-message.ts`): Reduced from 519 to 263 lines. Removed diff-content keyword analysis for type detection (kept only path-based heuristics for docs/test/chore), removed diff-content analysis for subject generation (kept type+bilingual), removed BREAKING CHANGE detection, removed text wrapping, simplified body generation.

Please review:
- Are there any issues with the unified event type dispatch (e.g., unreachable branches, missing events)?
- Does the simplified heuristic fallback cover the essential cases adequately, or could it leave a user with an uninformative commit message?
- Any readability/naming concerns with the `handlePipelineEvents` approach?
- Any edge cases or regressions introduced by removing the BREAKING CHANGE detection or stat-based body generation from the fallback?

The git diff of the changes is available — please read the files to review the current state.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

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