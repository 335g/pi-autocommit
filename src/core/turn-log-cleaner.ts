import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hasChanges } from "./git.js";
import { turnLog, type TurnLog } from "./turn-log.js";
import { diagIncr } from "../utils/diagnostics.js";

/**
 * Clear TurnLog if the working tree is clean.
 * Called from session_start to avoid stale context after a fresh start.
 *
 * The TurnLog instance is injectable for testing.
 */
export async function maybeClearTurnLogOnCleanStart(
  pi: ExtensionAPI,
  cwd: string,
  log: TurnLog = turnLog,
): Promise<void> {
  try {
    if (await hasChanges(pi, cwd)) return;
    if (log.turnCount === 0) return;
    log.clear();
    diagIncr("turnLog_autoClearedOnCleanStart");
  } catch {
    // Silently ignore — don't clear if we can't determine status
  }
}
