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
