/**
 * Types for pi-git extension
 */

export interface Hunk {
  /** Files included in this hunk */
  files: string[];
  /** Conventional Commit message for this hunk */
  message: string;
}

/** A hunk after user review, with inclusion flag */
export interface ReviewedHunk extends Hunk {
  /** Whether this hunk is included in the commit batch */
  included: boolean;
}

/** Result returned from the interactive hunk review UI */
export interface ReviewResult {
  /** Hunks with user decisions (included/excluded) */
  hunks: ReviewedHunk[];
  /** Whether the user cancelled the review (Esc) without committing */
  cancelled: boolean;
}

export interface AgentEndEvent {
  messages?: Array<{
    role: string;
    content: unknown;
  }>;
}

// ───────────────────────────────────────────────
// Intent-based hunk splitting types
// ───────────────────────────────────────────────

/** A single @@ block parsed from a unified git diff */
export interface DiffHunk {
  /** 1-based global index across all files (used in AI prompts as [H1], [H2], ...) */
  globalIndex: number;
  /** File path (b/ side of diff --git) */
  file: string;
  /** 0-based index of this hunk within its file */
  hunkIndexInFile: number;
  /** The @@ header line (e.g. "@@ -10,5 +10,7 @@ function foo() {") */
  header: string;
  /** Full diff lines for this hunk (header + content) */
  content: string;
  /** First non-header line trimmed — for AI context hint */
  summary: string;
  /** Whether this is a new file (--- /dev/null) */
  isNewFile: boolean;
  /** Whether this is a deleted file (+++ /dev/null) */
  isDeletedFile: boolean;
  /** Whether this is atomic (binary/rename/mode-only — no @@ blocks to split) */
  isAtomic: boolean;
  /** File-level diff header lines (diff --git, ---, +++, index) */
  fileHeader: string[];
}

/** Reference to a specific DiffHunk by its globalIndex */
export interface DiffHunkRef {
  /** 1-based global index matching DiffHunk.globalIndex */
  globalIndex: number;
  /** File path for display/debugging */
  file: string;
}

/** AI-generated commit group — a set of diff hunks that form one logical commit */
export interface CommitGroup {
  /** Diff hunk references (by globalIndex) included in this commit */
  hunks: DiffHunkRef[];
  /** Conventional Commit message */
  message: string;
  /** Confidence in the grouping */
  confidence: "high" | "medium" | "low";
  /** Corresponding conversation turn indices (1-based, from TurnLog) */
  turnIndices?: number[];
  /** Optional note (e.g. reason for low confidence) */
  note?: string;
}

/** AI response for intent-based hunk analysis */
export interface HunkGroupingResult {
  /** Overall confidence across all groups */
  overallConfidence: "high" | "medium" | "low";
  /** Commit groups */
  groups: CommitGroup[];
}
