/**
 * Lightweight diagnostic counters for pi-git P0 effectiveness measurement.
 *
 * Counters are incremented at key decision points and can be dumped
 * via /git-diagnostics command. Zero runtime overhead when not queried.
 */

export interface DiagSnapshot {
  // ── parseHunks repair layers (diff-based path) ─────────────────
  /** Layer 2: direct JSON.parse succeeded */
  parseLayer2_directJSON: number;
  /** Layer 3: trailing text stripped, then parse succeeded */
  parseLayer3_trailingStrip: number;
  /** Layer 4: regex pair extraction succeeded */
  parseLayer4_regexExtract: number;
  /** All layers failed, fell back to file-based hunks */
  parseFallback_fileBased: number;

  // ── parseHunkGroupingResult repair layers (intent-based path) ──
  /** Layer 1: JSON parse succeeded (new primary path) */
  parseLayer1_jsonPrimary: number;
  /** Layer 2: tagged-line fallback used */
  parseLayer2_taggedFallback: number;
  /** Layer 3: heuristic extraction used */
  parseLayer3_heuristicFallback: number;
  /** All layers failed */
  parseFailure_allLayers: number;

  // ── intent-based analysis flow ────────────────────────────────
  /** Intent-based analysis succeeded (high/medium confidence) */
  intentPath_success: number;
  /** TurnLog heuristic fallback activated */
  intentPath_fallback: number;
  /** Diff-based fallback used (last resort) */
  intentPath_diffBased: number;
  /** Hunk batching was triggered (>MAX_HUNKS_PER_INTENT_BATCH hunks) */
  intentPath_batched: number;
  /** TurnLog text was truncated (prompt size guard) */
  intentPath_promptTruncated: number;
  /** AI grouping skipped for cheap model */
  cheapModel_skippedAI: number;

  // ── confidence verification ───────────────────────────────────
  /** Overall confidence downgraded to "low" (>50% low-confidence hunks) */
  confidenceDowngrade_overconfidentModel: number;
  /** Overall confidence downgraded from "high" to "medium" (>30% low-confidence hunks) */
  confidenceDowngrade_highToMedium: number;

  // ── auto-commit-message quality ───────────────────────────────
  /** isGenericMessage() returned true */
  msgIsGeneric: number;
  /** refineMessageIfGeneric() was called */
  msgRefineTriggered: number;
  /** refine used AI comparison (not just heuristic) */
  msgRefineUsedAI: number;

  // ── commit-message sanitization ───────────────────────────────
  /** sanitizeCommitMessage() was called */
  msgSanitized: number;
  /** sanitize actually changed the message (was invalid format) */
  msgSanitizeChanged: number;
}

const counters: DiagSnapshot = {
  parseLayer2_directJSON: 0,
  parseLayer3_trailingStrip: 0,
  parseLayer4_regexExtract: 0,
  parseFallback_fileBased: 0,

  parseLayer1_jsonPrimary: 0,
  parseLayer2_taggedFallback: 0,
  parseLayer3_heuristicFallback: 0,
  parseFailure_allLayers: 0,

  intentPath_success: 0,
  intentPath_fallback: 0,
  intentPath_diffBased: 0,
  intentPath_batched: 0,
  intentPath_promptTruncated: 0,
  cheapModel_skippedAI: 0,

  confidenceDowngrade_overconfidentModel: 0,
  confidenceDowngrade_highToMedium: 0,

  msgIsGeneric: 0,
  msgRefineTriggered: 0,
  msgRefineUsedAI: 0,

  msgSanitized: 0,
  msgSanitizeChanged: 0,
};

/** Increment a counter by 1. Safe to call from any context. */
export function diagIncr<K extends keyof DiagSnapshot>(key: K): void {
  counters[key]++;
}

/** Take an atomic snapshot of all counters. */
export function diagSnapshot(): DiagSnapshot {
  return { ...counters };
}

/** Reset all counters to zero. */
export function diagReset(): void {
  for (const key of Object.keys(counters) as (keyof DiagSnapshot)[]) {
    counters[key] = 0;
  }
}
