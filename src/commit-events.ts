// ── Event types for the commit pipeline ──────────────────

export type PipelineEvent =
  | { type: "info"; message: string }
  | { type: "error"; message: string }
  | { type: "dry-run"; message: string }
  | { type: "committed"; message: string }
  | { type: "cancelled"; reason: string }
  | { type: "generating" }          // for progress callback only
  | { type: "stage-changed"; hasChanges?: boolean };  // footer status changed

export interface PipelineResult {
  events: PipelineEvent[];
  /** true when the commit was actually executed */
  committed: boolean;
}

/**
 * Optional callbacks for real-time progress during pipeline execution.
 * These fire synchronously within the pipeline so the caller can update
 * the UI *before* an async step completes (e.g. LLM generation).
 */
export interface PipelineCallbacks {
  onProgress?: (event: PipelineEvent) => void;
}

// ── Event types for the commit organiser ─────────────────

export type OrganizerEvent =
  | { type: "info"; message: string }
  | { type: "error"; message: string }
  | { type: "organised"; checkpointCount: number; commitCount: number }
  | { type: "fallback"; message: string }
  | { type: "stage-changed"; hasChanges?: boolean };

export interface OrganizerResult {
  events: OrganizerEvent[];
  organised: boolean;
}
