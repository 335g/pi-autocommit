# Auto-commit strategy: `turn_end` checkpoints with `agent_end` reorganisation

We extended `commitEveryTurn` so users can choose between two strategies.
`agent_end` keeps the original behaviour: one automatic commit at the end of every agent loop.
`turn_end` creates lightweight checkpoint commits after each file-mutating turn, then reorganises those checkpoints into logical Conventional Commits at `agent_end`.

We chose the two-phase approach for `turn_end` because a single agent request can produce many changes across multiple turns (for example, a goal command). Committing only at `agent_end` risks losing intermediate state if the loop is interrupted, while committing blindly at every `turn_end` produces noisy history. Checkpoints give us safety and recovery, and the final reorganisation step lets an LLM split the combined diff into coherent commits using the assistant's own reasoning as context.

## Considered options

- **Commit only at `agent_end`** — simple, but a long loop leaves all work uncommitted until the very end.
- **Commit at every `turn_end` without reorganisation** — safe, but produces many small, often meaningless commits.
- **Checkpoints at `turn_end` + LLM reorganisation at `agent_end`** — balances safety and clean history, at the cost of one extra LLM call per agent loop.

## Consequences

- `turn_end` mode uses `wip(checkpoint):` commit messages as a marker. The reorganiser looks for that prefix when deciding how far to `git reset --soft`.
- The reorganiser calls the LLM via `completeSimple` so the prompt is not visible in the conversation history.
- If LLM reorganisation fails, the extension falls back to a single Conventional Commit containing all checkpointed changes.
