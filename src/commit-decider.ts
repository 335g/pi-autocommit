import type { ToolResultMessage } from "@earendil-works/pi-ai";

/**
 * Tools that may have changed files in the working tree.
 *
 * Read-only tools (`read`, `grep`, `find`, `ls`) are intentionally excluded.
 * `bash` is included because many file mutations happen through shell commands
 * (`sed`, `make`, `npm install`, ...). The final authority is `git status`, so
 * a non-mutating `bash` command simply results in no checkpoint commit.
 */
const POTENTIALLY_MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

/**
 * Decide whether the turn just performed a file mutation worth checkpointing.
 *
 * This is a fast heuristic. It checks `toolResults` to see whether any tool
 * that may mutate files was invoked. Callers should still verify with
 * `git status` that the working tree actually changed before creating a checkpoint
 * commit.
 *
 * @param toolResults - Tool results emitted in `turn_end`.
 */
export function shouldCreateCheckpointCommit(
  toolResults: ToolResultMessage[],
): boolean {
  if (!toolResults || toolResults.length === 0) {
    return false;
  }
  return toolResults.some((r) => POTENTIALLY_MUTATING_TOOLS.has(r.toolName));
}
