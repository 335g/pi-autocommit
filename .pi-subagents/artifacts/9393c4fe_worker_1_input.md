# Task for worker

[Read from: /Users/335g/dev/other/pi-autocommit/context.md, /Users/335g/dev/other/pi-autocommit/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
You are designing the INTERFACE for a deepened module in the pi-autocommit codebase. Output ONLY a design proposal — do not write or edit any source files. Working directory: /Users/335g/dev/other/pi-autocommit

Use the deep-module vocabulary EXACTLY (module / interface / implementation / depth / seam / adapter / leverage / locality). Do NOT drift into 'component'/'service'/'API'/'boundary'.

## Read these files first, in order

1. CONTEXT.md — domain glossary (vocabulary you MUST use: Auto-commit, Checkpoint commit, Commit pipeline, Commit reorganiser, Commit strategy, Commit message model, Scope mapping, Uncommitted-changes indicator, Commit prompt module)
2. .agents/skills/codebase-design/SKILL.md — architecture vocabulary
3. .agents/skills/codebase-design/DEEPENING.md — dependency categories

## Then read this code

- src/llm-commit.ts — single-commit path: generateCommitMessageWithLLM, validateModelString, resolveModel, cleanupResponse
- src/commit-organizer.ts — reorganiser path: proposeCommitGroups, parseCommitGroups, buildOrganizerSystemPrompt, buildOrganizerUserContent, extractAssistantContext
- src/commit-message.ts — heuristic fallback (pure, in-process dependency)
- src/scope-resolver.ts — hasScopeMapping, injectScopeIntoMessage (pure, in-process dependency)
- src/commit-types.ts — COMMIT_TYPES single source of truth
- src/git-parser.ts — parseNameStatus (pure)
- src/commit-events.ts
- src/index.ts — the two callers (turn_end checkpoint, agent_end reorganiser)
- docs/adr/0003-deterministic-scope-via-path-mapping.md — ADR you MUST NOT violate

## Problem space

Two callers share duplicated prompt logic:
- single-commit path (checkpoint at turn_end): returns ONE Conventional Commits message string
- reorganiser path (agent_end): returns CommitGroup[] — array of { message, files }

Both currently inline: language switching rules, COMMIT_TYPES reference table, hasScopeMapping subject-format rule, dynamic import of completeSimple + text extraction (filter·map·join·trim), injectScopeIntoMessage post-injection.

Diverging: systemPrompt skeleton (single vs === COMMIT N === blocks), userContent (diff only vs assistant reasoning + diff), result interpretation (cleanupResponse vs parseCommitGroups), failure mode (heuristic fallback in single, throw→fallbackSingleCommit CALLS generateCommitMessageWithLLM AGAIN → silent double LLM roundtrip in reorganiser).

## Dependencies by category

- ports & adapters: LLM adapter. Prod = dynamic import('@earendil-works/pi-ai/compat').completeSimple; test = fake. TWO adapters ⇒ real seam.
- local-substitutable: scope-resolver, commit-message heuristic (pure, internal)
- in-process: commit-types, git-parser (pure)

## Constraints all designs must satisfy

- 2 callers with INCOMPATIBLE return types (string vs CommitGroup[])
- LLM adapter substitutable (prod dynamic import, test fake)
- Heuristic fallback reachable from single path (LLM unavailable ⇒ heuristic message)
- Scope injection per ADR-0003 preserved on BOTH paths
- Core must NOT import any pi-coding-agent type (ExtensionContext ok; AgentEndEvent/Messages NOT ok — structural typing only if reasoning extraction lives in core)
- Silent double-LLM-roundtrip on reorganiser failure must disappear as a natural consequence of depth
- Behaviour preserved

## YOUR DESIGN CONSTRAINT (Agent 2 — MAXIMISE FLEXIBILITY)

MAXIMISE FLEXIBILITY — support many use cases and extension. Imagine the commit prompt module being reused beyond the two current callers (e.g. a future `/autocommit-message` slash command that lets the user steer generation, an incremental reorganiser that proposes groups one at a time, a dry-run mode that returns the message without committing). Surface the right extension points (prompt variant, response parser variant, progress callback) but keep the LLM adapter substituted at the seam. Prefer a small set of configurable entry points over one giant function.

## Output (in this order)

1. Interface — TypeScript signatures (types, methods, params) plus invariants, ordering, error modes
2. Usage example — BOTH callers (single + reorganiser) using it, PLUS ONE speculative future caller
3. What the implementation hides behind the seam — bullet list
4. Dependency strategy and adapters — which port sits at the interface, which are internal
5. Trade-offs — where leverage is high, where it's thin

Be concrete. TypeScript signatures. No hedging. No file edits.

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