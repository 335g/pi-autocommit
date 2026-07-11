# Task for scout

Explore the pi-autocommit codebase at /Users/335g/dev/other/pi-autocommit. Focus on architectural friction and deepening opportunities using this vocabulary: module, interface, implementation, depth, deep, shallow, seam, adapter, leverage, locality. Apply the deletion test.

Read all source files under src/ and their tests. Report:
1. Each module's approximate responsibility and size
2. Where interfaces are wide relative to implementation (shallow modules)
3. Where complexity leaks across seams
4. Where understanding requires bouncing between many files
5. Where tests are missing or hard to write through the current interface
6. Any duplication or near-duplication
7. Specific candidates for deepening with file paths

Do not propose solutions yet. Be concrete about file paths, function names, and line counts. Use the codebase-design vocabulary.

---
**Output:**
Write your findings to exactly this path: /tmp/scout-architecture-report.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

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