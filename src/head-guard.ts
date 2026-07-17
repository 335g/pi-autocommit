/**
 * Decide whether the commit reorganiser should be skipped at `agent_end`.
 *
 * Returns `true` when the HEAD commit captured at `agent_start` matches the
 * current HEAD. This means the agent run produced no commits, so there is
 * nothing to reorganise.
 *
 * A `null` baseline (e.g., HEAD could not be read at `agent_start`) is treated
 * as "unknown", so the reorganiser proceeds with its normal behaviour rather
 * than risk silently skipping a real reorganisation.
 */
export function shouldSkipReorganisation(
  baselineHead: string | null,
  currentHead: string | null,
): boolean {
  if (baselineHead === null || currentHead === null) {
    return false;
  }
  return baselineHead === currentHead;
}
