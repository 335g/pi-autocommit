# Task for scout

Explore the TypeScript source in /Users/335g/dev/other/pi-git/src. Focus on architectural friction from the perspective of the /codebase-design skill (deep modules, seams, adapters, locality, leverage, depth). Read all src/*.ts files (not tests) and summarize:

1. The main modules and their interfaces.
2. Where modules are shallow (interface nearly as complex as implementation) or where complexity leaks across seams.
3. Where understanding requires bouncing between many small modules.
4. Where tests are missing or would need to reach past the interface.
5. Any tight coupling (e.g., GitOperations constructed inline, pi API threaded everywhere, UI calls mixed with logic).

Use the project's domain vocabulary from CONTEXT.md (commit pipeline, checkpoint commit, commit reorganiser, commit strategy, crit review, file selection, auto-commit). Return a concise but specific findings list with file paths and concrete examples. Do not propose solutions.

---
**Output:**
Write your findings to exactly this path: /Users/335g/dev/other/pi-git/.pi-subagents/artifacts/outputs/c0387f63/context.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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