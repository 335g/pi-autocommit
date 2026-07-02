import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FileDetail } from "./file-selector.js";

/**
 * A single comment from a crit review.
 */
export interface CritComment {
  id: string;
  /** The comment body text */
  body: string;
  /** The text the user selected when commenting (if any) */
  quote?: string;
  /** The file path the comment is on (if applicable) */
  file?: string;
  /** Whether the comment has been resolved */
  resolved: boolean;
}

/**
 * Result of a completed crit review.
 */
export interface CritReviewResult {
  /** True when all comments are resolved */
  approved: boolean;
  /** Review comments */
  comments: CritComment[];
  /** Free‑form instructions from the reviewer (set via the "prompt" field) */
  prompt?: string;
}

/**
 * Input required to run the full crit review flow.
 */
export interface ReviewInput {
  /** Files selected for the commit. */
  selectedFiles: string[];
  /** Pre-fetched diff details per file (TUI mode only). */
  fileDetails: Map<string, FileDetail> | undefined;
  /** Combined staged diff passed to crit. */
  stagedDiff: string;
}

/**
 * Result of the crit review flow.
 */
export interface ReviewFlowResult {
  /** Additional context to feed into the LLM commit-message prompt. */
  reviewContext?: string;
}

/**
 * Base error for review-flow control flow.
 */
export class ReviewFlowError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * Thrown when the user cancels the review flow.
 */
export class ReviewCancelledError extends ReviewFlowError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when the user asks to send unresolved comments back to the agent
 * for fixing. The caller should dispatch the comments via `pi.sendUserMessage`.
 */
export class ReviewSendToAgentError extends ReviewFlowError {
  constructor(public readonly reviewComments: string) {
    super("REVIEW_SEND_TO_AGENT");
  }
}

/**
 * Run the full crit review flow: build the review document, launch crit,
 * handle unresolved comments, and return any context for commit-message
 * generation.
 *
 * In TUI mode the user is asked what to do with unresolved comments.
 * In non-TUI mode unresolved comments are automatically included as context.
 *
 * @throws ReviewSendToAgentError when the user chooses to send comments back
 *         to the agent for fixing.
 * @throws ReviewCancelledError when the user chooses to cancel.
 */
export async function runReviewFlow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: ReviewInput,
): Promise<ReviewFlowResult> {
  // Build per-file entries for the crit review document
  const fileEntries = input.selectedFiles
    .map((path) => {
      const detail = input.fileDetails?.get(path);
      return detail
        ? {
            path,
            additions: detail.additions,
            deletions: detail.deletions,
          }
        : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  // Run crit review
  ctx.ui.notify(
    "Opening crit review in your browser. Review the diff and click Finish Review when done.",
    "info",
  );
  const result = await runCritReview(pi, input.stagedDiff, fileEntries);

  // Handle unresolved comments
  const unresolvedComments = result.comments.filter((c) => !c.resolved);
  if (unresolvedComments.length === 0) {
    return {};
  }

  const commentSummary = unresolvedComments
    .map((c) => {
      const location = c.file
        ? `${c.file}${c.quote ? `: "${c.quote}"` : ""}`
        : "";
      return location ? `${location}: ${c.body}` : c.body;
    })
    .join("\n");

  ctx.ui.notify(
    `Unresolved review comments:\n${commentSummary}`,
    "warning",
  );

  if (ctx.hasUI) {
    const choice = await ctx.ui.select(
      "Review has unresolved comments. What would you like to do?",
      [
        "Fix based on comments — unstages and sends to LLM for fixing",
        "Include comments in commit message context and continue",
        "Cancel — abort, fix issues manually, then re-run",
      ],
    );

    if (
      choice ===
      "Fix based on comments — unstages and sends to LLM for fixing"
    ) {
      const fullSummary = result.prompt
        ? `${result.prompt}\n\n${commentSummary}`
        : commentSummary;
      throw new ReviewSendToAgentError(fullSummary);
    }

    if (
      choice !==
      "Include comments in commit message context and continue"
    ) {
      throw new ReviewCancelledError(
        "Review cancelled by user — fix issues first.",
      );
    }
  }

  return { reviewContext: commentSummary };
}

/**
 * Check whether the `crit` CLI is available on the system.
 *
 * Should be called early in the review command handler, before any git state
 * is modified, so the user gets a clear message if crit is not installed.
 *
 * @throws If `crit` is not found on the system PATH.
 */
export async function checkCritAvailable(pi: ExtensionAPI): Promise<void> {
  try {
    await pi.exec("which", ["crit"]);
  } catch {
    throw new Error(
      "`crit` is not available. Install it first (npm install -g crit) or use `/commit` instead.",
    );
  }
}

/**
 * Write a review document and launch crit on it.
 *
 * Creates a temporary markdown file with the diff summary, opens crit in the
 * browser, and blocks until the user clicks "Finish Review". The temp file
 * is cleaned up when the function returns (even on error).
 *
 * @throws If `crit` is not installed or returns unparseable output.
 */
export async function runCritReview(
  pi: ExtensionAPI,
  diffContent: string,
  fileEntries: { path: string; additions: number; deletions: number }[],
): Promise<CritReviewResult> {
  const timestamp = Date.now();
  const reviewPath = join(tmpdir(), `pi-git-review-${timestamp}.md`);

  try {
    const document = buildReviewDocument(diffContent, fileEntries);
    writeFileSync(reviewPath, document, "utf-8");

    try {
      const { stdout } = await pi.exec("crit", [reviewPath]);
      return parseCritOutput(stdout);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("not found") ||
        message.includes("ENOENT") ||
        message.includes("command not found")
      ) {
        throw new Error(
          "`crit` is not available. Install it first (npm install -g crit) or use `/commit` instead.",
        );
      }
      throw new Error(`crit review failed: ${message}`);
    }
  } finally {
    try {
      unlinkSync(reviewPath);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Build a structured markdown document for crit review.
 */
function buildReviewDocument(
  diffContent: string,
  fileEntries: { path: string; additions: number; deletions: number }[],
): string {
  const lines: string[] = [];
  lines.push("# Review");
  lines.push("");
  lines.push(
    `Total: ${fileEntries.length} file${fileEntries.length !== 1 ? "s" : ""}`,
  );
  lines.push("");
  lines.push("| File | Additions | Deletions |");
  lines.push("|------|-----------|-----------|");
  for (const entry of fileEntries) {
    lines.push(
      `| \`${entry.path}\` | +${entry.additions} | -${entry.deletions} |`,
    );
  }
  lines.push("");
  lines.push("## Diff");
  lines.push("");
  lines.push("```diff");
  lines.push(diffContent);
  lines.push("```");
  return lines.join("\n");
}

/**
 * Extract a single top-level JSON object starting at `start`.
 *
 * Uses brace matching that respects strings and escapes, so nested
 * objects and arrays are handled correctly.
 *
 * @internal Exported for testing only.
 */
export function extractJsonObjectAt(
  text: string,
  start: number,
): { value: Record<string, unknown>; end: number } | null {
  if (text[start] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return {
            value: JSON.parse(text.slice(start, i + 1)) as Record<
              string,
              unknown
            >,
            end: i + 1,
          };
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/**
 * Parse crit's stdout JSON output.
 *
 * Crit may print startup messages or event lines before the final JSON
 * payload, and may emit multiple JSON objects during a comment rally.
 * We scan for all valid top-level JSON objects and use the last one that
 * looks like a crit review result.
 *
 * If no JSON is found, fall back to interpreting the raw text.
 * In some environments crit outputs the prompt message directly
 * (e.g. "Review approved with no comments — no changes requested.")
 * instead of the full JSON payload.
 *
 * @internal Exported for testing only.
 */
export function parseCritOutput(stdout: string): CritReviewResult {
  const objects: Record<string, unknown>[] = [];

  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] === "{") {
      const parsed = extractJsonObjectAt(stdout, i);
      if (parsed) {
        objects.push(parsed.value);
        i = parsed.end - 1;
      }
    }
  }

  if (objects.length > 0) {
    // Prefer the last object that resembles a crit result payload.
    // A crit result always has a comments array, so prefer that over
    // event objects that may happen to carry an approved boolean or
    // prompt string.
    let result = objects[objects.length - 1];
    for (let i = objects.length - 1; i >= 0; i--) {
      if (Array.isArray(objects[i].comments)) {
        result = objects[i];
        break;
      }
    }

    // Fallback: tolerate payloads that lack comments but look like a result.
    if (!Array.isArray(result.comments)) {
      for (let i = objects.length - 1; i >= 0; i--) {
        const o = objects[i];
        if (
          typeof o.approved === "boolean" ||
          typeof o.prompt === "string"
        ) {
          result = o;
          break;
        }
      }
    }

    const rawComments = (result.comments ?? []) as Array<
      Record<string, unknown>
    >;

    return {
      approved: (result.approved as boolean) ?? false,
      prompt: result.prompt as string | undefined,
      comments: rawComments.map((c) => ({
        id: (c.id as string) ?? "",
        body: (c.body as string) ?? "",
        quote: c.quote as string | undefined,
        file: c.file as string | undefined,
        resolved: (c.resolved as boolean) ?? false,
      })),
    };
  }

  // Fallback: no JSON found — treat raw output as prompt text.
  // This handles cases where crit outputs the prompt message directly
  // without JSON wrapping.
  const trimmed = stdout.trim();
  const approved =
    trimmed.toLowerCase().includes("approved") ||
    trimmed.toLowerCase().includes("no changes requested");

  return {
    approved,
    prompt: trimmed || undefined,
    comments: [],
  };
}
