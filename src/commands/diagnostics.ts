/**
 * /git-diagnostics command
 *
 * Dumps P0 effectiveness measurement counters for inspection.
 * Usage:
 *   /git-diagnostics         Show all counters
 *   /git-diagnostics reset   Reset all counters
 *   /git-diagnostics --help  Show help
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { diagReset, diagSnapshot, type DiagSnapshot } from "../utils/diagnostics.js";

function formatSnapshot(s: DiagSnapshot): string {
  const lines: string[] = [
    "[pi-git] Diagnostics",
    "",
    "── parseHunks repair layers ──",
    `  Layer 2 (direct JSON):     ${s.parseLayer2_directJSON}`,
    `  Layer 3 (trailing strip):  ${s.parseLayer3_trailingStrip}`,
    `  Layer 4 (regex extract):   ${s.parseLayer4_regexExtract}`,
    `  Fallback (file-based):     ${s.parseFallback_fileBased}`,
    "",
    "── auto-commit message quality ──",
    `  isGenericMessage:          ${s.msgIsGeneric}`,
    `  refineTriggered:           ${s.msgRefineTriggered}`,
    `  refineUsedAI:              ${s.msgRefineUsedAI}`,
    "",
    "── commit message sanitization ──",
    `  sanitize called:           ${s.msgSanitized}`,
    `  sanitize changed (invalid): ${s.msgSanitizeChanged}`,
    "",
    "── stored prompt availability ──",
    `  system prompt used:        ${s.intentPath_storedSystemPromptUsed}`,
    `  raw user prompt used:      ${s.intentPath_storedUserPromptUsed}`,
    `  prompts missing:           ${s.intentPath_storedPromptsMissing}`,
    "",
    "── TurnLog management ──",
    `  auto-cleared on clean start: ${s.turnLog_autoClearedOnCleanStart}`,
    `  manually cleared:            ${s.turnLog_manuallyCleared}`,
  ];

  const totalParses =
    s.parseLayer2_directJSON +
    s.parseLayer3_trailingStrip +
    s.parseLayer4_regexExtract +
    s.parseFallback_fileBased;

  if (totalParses > 0) {
    const repairRate =
      ((s.parseLayer3_trailingStrip + s.parseLayer4_regexExtract) /
        totalParses) *
      100;
    const fallbackRate = (s.parseFallback_fileBased / totalParses) * 100;
    lines.push(
      "",
      `── summary ──`,
      `  Total parse calls:        ${totalParses}`,
      `  Repair rate (L3+L4):      ${repairRate.toFixed(1)}%`,
      `  Fallback rate:            ${fallbackRate.toFixed(1)}%`,
    );
  }

  return lines.join("\n");
}

export async function handleDiagnostics(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  if (!ctx.hasUI) return;

  const trimmed = args.trim().toLowerCase();

  if (trimmed === "--help") {
    ctx.ui.notify(
      "/git-diagnostics [reset] [--help]\n\nShow P0 effectiveness measurement counters.\n\nSubcommands:\n  reset  Reset all counters to zero",
      "info",
    );
    return;
  }

  if (trimmed === "reset") {
    diagReset();
    ctx.ui.notify("[pi-git] Diagnostic counters reset.", "info");
    return;
  }

  const snapshot = diagSnapshot();
  ctx.ui.notify(formatSnapshot(snapshot), "info");
}
