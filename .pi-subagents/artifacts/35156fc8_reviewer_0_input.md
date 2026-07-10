# Task for reviewer

[Read from: /Users/335g/dev/other/pi-git/plan.md, /Users/335g/dev/other/pi-git/progress.md]

Review the diff of the last 3 commits in this repo (pi-git). The diff is saved at /tmp/pi-git-model-review.diff and covers changes that add a new `model` config option for specifying the LLM model used for commit message generation.

Context: pi-git is a pi-coding-agent extension that adds `/git-commit` and `/git-status` commands. It generates Conventional Commits messages via LLM (using `completeSimple` from `@earendil-works/pi-ai/compat`). Previously the LLM call always used `ctx.model` (the session's current model). This change adds a `model` config key (in `"provider/modelId"` format, e.g. `"anthropic/claude-sonnet-4"`) to `.pi/pi-git.json` so users can override which model generates commit messages.

The changed files are:
- src/config.ts — added `model?: string` to `PiGitConfig`, added to `KNOWN_KEYS`, parse logic in `loadConfig`
- src/llm-commit.ts — added exported `resolveModel(ctx, config)` helper that resolves the model from config string via `ctx.modelRegistry.find(provider, modelId)`, with validation (format, found in registry, has configured auth) and fallback to `ctx.model` with warnings; uses resolved model in `generateCommitMessageWithLLM`
- src/commit-organizer.ts — uses `resolveModel` in `proposeCommitGroups` instead of `ctx.model`
- src/config.test.ts — added tests for the new `model` config key
- README.md / README.ja.md — documented the new config option

Please review the diff for:
1. Correctness: does the model resolution logic handle edge cases properly? Is the fallback to `ctx.model` correct?
2. Type safety: `ctx.modelRegistry` is accessed with optional chaining (`?.`) — is `modelRegistry` actually optional on `ExtensionContext`? Check the type definition.
3. Consistency: are both LLM call sites (llm-commit.ts and commit-organizer.ts) using the new `resolveModel` consistently?
4. Test coverage: are the new tests sufficient?
5. Any bugs, edge cases, or improvements you'd recommend.

Read the diff file at /tmp/pi-git-model-review.diff, then inspect the relevant source files in the repo at /Users/335g/dev/other/pi-git/ as needed (src/config.ts, src/llm-commit.ts, src/commit-organizer.ts, src/config.test.ts). Also check the pi-coding-agent ExtensionContext type definition to verify whether `modelRegistry` is optional or required.

Provide a structured review with issues categorized by severity (blocker / major / minor / nit) and concrete suggestions.

---
**Output:**
Write your findings to exactly this path: /tmp/pi-git-model-review-result.md
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