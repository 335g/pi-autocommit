/**
 * Commit command argument parsing.
 *
 * Parses raw argument string from the `/git-commit` command.
 * Pure function — no side effects, easily testable.
 */

export interface ParsedCommitArgs {
  /** Whether --dry-run flag is present */
  dryRun: boolean;
  /**
   * Inline commit message extracted from args.
   * Empty string when no inline message was provided.
   * The --dry-run flag is stripped from this value.
   */
  inlineMessage: string;
}

/**
 * Parse raw argument string from `/git-commit`.
 *
 * Rules:
 * - `--dry-run` anywhere in the string sets `dryRun: true` and is removed from the inline message
 * - Everything else is treated as the inline commit message
 * - Empty input produces `{ dryRun: false, inlineMessage: "" }`
 *
 * @example
 *   parseCommitArgs("")                → { dryRun: false, inlineMessage: "" }
 *   parseCommitArgs("fix typo")        → { dryRun: false, inlineMessage: "fix typo" }
 *   parseCommitArgs("--dry-run")       → { dryRun: true,  inlineMessage: "" }
 *   parseCommitArgs("--dry-run fix")   → { dryRun: true,  inlineMessage: "fix" }
 */
export function parseCommitArgs(raw: string): ParsedCommitArgs {
  const trimmed = raw.trim();
  const dryRun = /(?:^|\s)--dry-run(?:$|\s)/.test(trimmed);
  const inlineMessage = dryRun
    ? trimmed.replace(/\s*--dry-run\s*/, "").trim()
    : trimmed;
  return { dryRun, inlineMessage };
}
