/**
 * Types for pi-git extension
 */

export interface Hunk {
  /** Files included in this hunk */
  files: string[];
  /** Conventional Commit message for this hunk */
  message: string;
  /** Optional description of changes for message generation context */
  description?: string;
}

export interface FileStats {
  path: string;
  additions: number;
  deletions: number;
}

export interface AgentEndEvent {
  messages?: Array<{
    role: string;
    content: unknown;
  }>;
}
