/**
 * TurnLog — session-scoped conversation log accumulator with disk persistence.
 *
 * Stores per-turn (user message, assistant excerpt, changed files) in memory
 * AND persists to `<repo-root>/.pi-git/turn-log.json` for survival across
 * session reloads (Ctrl+R, pi restart).
 *
 * Used by batch-committer to inject conversation context into the AI prompt
 * when splitting diffs into logical hunks.
 *
 * Persistence is best-effort: failures are silent and never block in-memory operation.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentEndEvent } from "../types.js";
import {
  type SimpleMessage,
  collectMessagesByRole,
  tailTruncate,
  stripConversationalMarkers,
} from "../utils/message-utils.js";

/** One turn's worth of conversation context */
export interface TurnEntry {
  /** Turn index (1-based) */
  index: number;
  /** User's message — tail-truncated and stripped of conversational markers */
  userMessage: string;
  /** Assistant's first meaningful excerpt */
  assistantExcerpt: string;
  /** Files changed during this turn (REQUIRED for AI correlation) */
  filesChanged: string[];
  /** System prompt effective during this turn */
  systemPrompt?: string;
  /** Raw user prompt text (before marker stripping) */
  rawUserPrompt?: string;
}

/** On-disk representation of TurnLog state */
interface PersistedTurnLog {
  version: number;
  turnIndex: number;
  warnNotified: boolean;
  entries: TurnEntry[];
}

const TURN_LOG_FILE = "turn-log.json";
const TURN_LOG_DIR = ".pi-git";

/**
 * Session-scoped conversation log.
 *
 * Use as a module-level singleton (same pattern as footerManager):
 *   import { turnLog } from "./turn-log.js";
 */
export class TurnLog {
  static readonly MAX_ENTRIES = 20;
  static readonly MAX_CHARS = 12_000;

  private entries: TurnEntry[] = [];
  private turnIndex = 0;
  private _warnNotified = false;

  /** Git repo root — set by initialize(). null when not in a git repo. */
  private repoRoot: string | null = null;

  get turnCount(): number {
    return this.entries.length;
  }

  get totalFilesChanged(): number {
    const allFiles = new Set<string>();
    for (const e of this.entries) {
      for (const f of e.filesChanged) allFiles.add(f);
    }
    return allFiles.size;
  }

  get warnNotified(): boolean {
    return this._warnNotified;
  }

  set warnNotified(value: boolean) {
    this._warnNotified = value;
    this.saveToDisk();
  }

  // ───────────────────────────────────────────────
  // Initialization
  // ───────────────────────────────────────────────

  /**
   * Initialize TurnLog from persisted state.
   *
   * Synchronous — uses readFileSync to avoid races with agent_end
   * (which could fire before an async initialize completes).
   *
   * - Resolves repo root from cwd
   * - Loads turn-log.json if it exists
   * - If not in a git repo, starts fresh (no persistence)
   */
  initialize(cwd: string): void {
    this.repoRoot = this.resolveRepoRoot(cwd);
    if (this.repoRoot) {
      this.ensureExcluded();
      this.loadFromDisk();
    } else {
      // Not in a git repo — start fresh, no persistence
      this.entries = [];
      this.turnIndex = 0;
      this._warnNotified = false;
    }
  }

  // ───────────────────────────────────────────────
  // Core operations
  // ───────────────────────────────────────────────

  /**
   * Append a turn's conversation context.
   * Called from agent_end handler on every turn.
   *
   * Persists to disk synchronously after appending (file is small, <20KB).
   *
   * @param systemPrompt - System prompt effective during this turn (optional)
   * @param rawUserPrompt - Raw user prompt text before processing (optional)
   */
  append(
    event: AgentEndEvent,
    changedFiles: string[],
    systemPrompt?: string,
    rawUserPrompt?: string,
  ): void {
    this.turnIndex++;

    const messages = (event.messages ?? []) as SimpleMessage[];

    // User message: extract the last meaningful user message (newest-first)
    const userMessages = collectMessagesByRole(messages, "user");
    const userMsg = userMessages[0] ?? "";

    // Assistant excerpt: extract first assistant response
    const assistantMessages = collectMessagesByRole(messages, "assistant");
    const assistantMsg = assistantMessages[0] ?? "";

    // Fallback: if caller did not provide raw user prompt, use the original user message
    const finalRawUserPrompt = rawUserPrompt ?? userMsg;

    this.entries.push({
      index: this.turnIndex,
      userMessage: tailTruncate(
        stripConversationalMarkers(userMsg),
        500,
      ),
      assistantExcerpt: stripConversationalMarkers(assistantMsg).slice(
        0,
        500,
      ),
      filesChanged: changedFiles.slice(0, 20),
      systemPrompt: systemPrompt
        ? tailTruncate(systemPrompt, 1000)
        : undefined,
      rawUserPrompt: finalRawUserPrompt
        ? tailTruncate(finalRawUserPrompt, 1500)
        : undefined,
    });

    // Enforce budget: keep most recent entries
    if (this.entries.length > TurnLog.MAX_ENTRIES) {
      this.entries = this.entries.slice(-TurnLog.MAX_ENTRIES);
    }

    // Persist to disk (synchronous — small file, once per turn)
    this.saveToDisk();
  }

  /**
   * Serialize for AI prompt injection.
   *
   * Outputs structured blocks with 【依頼】【応答】【ファイル】markers.
   * Computes newFilesThisTurn and continuedFilesThisTurn dynamically
   * by comparing each entry against previous entries (no schema change).
   *
   * Returns "" when empty (caller should omit the section).
   */
  formatForPrompt(): string {
    if (this.entries.length === 0) return "";

    // Compute file-increment sets for each entry.
    // "new" = files that first appeared in this turn (not in any prior turn).
    // "continued" = files that also appeared in at least one prior turn.
    const seenFiles = new Set<string>();
    const increments: Array<{
      newFiles: string[];
      continuedFiles: string[];
    }> = [];

    for (const e of this.entries) {
      const newFiles: string[] = [];
      const continuedFiles: string[] = [];
      for (const f of e.filesChanged) {
        if (seenFiles.has(f)) {
          continuedFiles.push(f);
        } else {
          newFiles.push(f);
          seenFiles.add(f);
        }
      }
      increments.push({ newFiles, continuedFiles });
    }

    const lines: string[] = [];
    let totalChars = 0;

    // Most recent entries first (recency matters more for AI attention)
    const reversed = [...this.entries].reverse();
    const reversedInc = [...increments].reverse();

    for (let i = 0; i < reversed.length; i++) {
      const e = reversed[i];
      const inc = reversedInc[i];

      const parts: string[] = [
        `### Turn ${e.index} ━━━━━━━━━━━━━━━━━━━━━━`,
        `【依頼】${e.userMessage}`,
        `【応答】${e.assistantExcerpt}`,
      ];

      // Original prompts section (when available)
      if (e.systemPrompt || e.rawUserPrompt) {
        const promptParts: string[] = [];
        if (e.systemPrompt) promptParts.push(`System: ${e.systemPrompt}`);
        if (e.rawUserPrompt) promptParts.push(`User: ${e.rawUserPrompt}`);
        parts.push(`【プロンプト】${promptParts.join(" | ")}`);
      }

      // File section with new/continued annotation
      const fileParts: string[] = [];
      if (inc.newFiles.length > 0) {
        fileParts.push(`新規: ${inc.newFiles.join(", ")}`);
      }
      if (inc.continuedFiles.length > 0) {
        fileParts.push(`継続: ${inc.continuedFiles.join(", ")}`);
      }
      if (fileParts.length > 0) {
        parts.push(`【ファイル】${fileParts.join(" | ")}`);
      } else if (e.filesChanged.length > 0) {
        parts.push(`【ファイル】${e.filesChanged.join(", ")}`);
      }

      const block = parts.join("\n");

      if (totalChars + block.length > TurnLog.MAX_CHARS) break;
      lines.push(block);
      totalChars += block.length + 1; // +1 for double-newline separator
    }

    return lines.join("\n\n");
  }

  /** Get entries for external consumers (e.g., heuristic grouping) */
  getEntries(): TurnEntry[] {
    return this.entries;
  }

  /**
   * Compute file co-occurrence scores from TurnLog entries.
   * Returns a Map of "fileA::fileB" → co-occurrence count.
   * Files in each pair are sorted alphabetically for stable keys.
   */
  getFileCooccurrence(): Map<string, number> {
    const scores = new Map<string, number>();

    for (const entry of this.entries) {
      const files = entry.filesChanged;
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const key = [files[i], files[j]].sort().join("::");
          scores.set(key, (scores.get(key) || 0) + 1);
        }
      }
    }

    return scores;
  }

  /**
   * Clear all entries (called after successful batch commit).
   * Also deletes the persisted file.
   */
  clear(): void {
    this.entries = [];
    this.turnIndex = 0;
    this._warnNotified = false;
    this.deleteFromDisk();
  }

  // ───────────────────────────────────────────────
  // Persistence (private)
  // ───────────────────────────────────────────────

  /**
   * Resolve the git repo root from a working directory.
   * Returns null if not in a git repo.
   * Follows the same pattern as getLocalSettingsPath() in settings.ts.
   */
  private resolveRepoRoot(cwd: string): string | null {
    try {
      return execSync("git rev-parse --show-toplevel", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Ensure .pi-git/ is in .git/info/exclude so turn-log.json
   * doesn't get picked up by git stash and committed accidentally.
   *
   * Uses .git/info/exclude (not .gitignore) because it's:
   * - Per-repo (no global side effects)
   * - Not committed (doesn't modify the user's .gitignore)
   * - Standard git practice for tool-generated files
   */
  private ensureExcluded(): void {
    if (!this.repoRoot) return;
    const excludePath = join(this.repoRoot, ".git", "info", "exclude");
    const pattern = ".pi-git/";

    try {
      if (existsSync(excludePath)) {
        const current = readFileSync(excludePath, "utf-8");
        if (current.includes(pattern)) return; // already excluded
        writeFileSync(excludePath, `${current.trimEnd()}\n${pattern}\n`, "utf-8");
      } else {
        // No exclude file yet — create one
        mkdirSync(join(this.repoRoot, ".git", "info"), { recursive: true });
        writeFileSync(excludePath, `${pattern}\n`, "utf-8");
      }
    } catch {
      // Best-effort — if we can't write to exclude, TurnLog still works.
      // The file may end up in git stash, but orphan recovery handles it.
    }
  }

  /**
   * Load entries from .pi-git/turn-log.json.
   * Synchronous — consistent with loadJson/loadToml in settings.ts.
   *
   * Validates the shape and types of loaded data. Malformed data
   * triggers a fresh start with a console warning.
   */
  private loadFromDisk(): void {
    if (!this.repoRoot) return;

    // Clean up stale temp file from a previous crash
    const staleTmp = join(this.repoRoot, TURN_LOG_DIR, "turn-log.json.tmp");
    try { unlinkSync(staleTmp); } catch { /* ignore */ }

    const filePath = join(this.repoRoot, TURN_LOG_DIR, TURN_LOG_FILE);
    if (!existsSync(filePath)) return;

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return; // read error → fresh start
    }

    if (!raw.trim()) return; // empty file → fresh start

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn("[pi-git] Failed to parse turn-log.json — starting fresh");
      return;
    }

    // ── Runtime type/shape validation ──
    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data)
    ) {
      console.warn("[pi-git] Invalid turn-log.json shape — starting fresh");
      return;
    }

    const obj = data as Record<string, unknown>;

    // Version check — accept both v1 (legacy) and v2 (with prompt fields)
    if (obj.version !== 1 && obj.version !== 2) {
      console.warn(
        `[pi-git] Unsupported turn-log.json version: ${obj.version} — starting fresh`,
      );
      return;
    }

    // Validate entries array
    if (!Array.isArray(obj.entries)) {
      console.warn("[pi-git] turn-log.json entries is not an array — starting fresh");
      return;
    }

    // Validate turnIndex
    if (typeof obj.turnIndex !== "number" || !Number.isFinite(obj.turnIndex)) {
      console.warn("[pi-git] turn-log.json turnIndex is invalid — starting fresh");
      return;
    }

    // Filter valid entries (skip malformed ones gracefully)
    const validEntries: TurnEntry[] = [];
    for (const e of obj.entries) {
      if (
        typeof e === "object" &&
        e !== null &&
        typeof (e as TurnEntry).index === "number" &&
        typeof (e as TurnEntry).userMessage === "string" &&
        typeof (e as TurnEntry).assistantExcerpt === "string" &&
        Array.isArray((e as TurnEntry).filesChanged) &&
        (e as TurnEntry).filesChanged.every((f: unknown) => typeof f === "string")
      ) {
        validEntries.push(e as TurnEntry);
      }
      // Silently skip malformed entries
    }

    this.entries = validEntries.slice(-TurnLog.MAX_ENTRIES);
    this.turnIndex = obj.turnIndex as number;
    this._warnNotified = obj.warnNotified === true;
  }

  /**
   * Write current state to .pi-git/turn-log.json.
   * Uses atomic write (tmp file → rename) to prevent corruption on crash.
   * Uses PID in tmp filename to avoid collisions with concurrent pi sessions.
   */
  private saveToDisk(): void {
    if (!this.repoRoot) return;

    const dir = join(this.repoRoot, TURN_LOG_DIR);
    const finalPath = join(dir, TURN_LOG_FILE);
    const tmpPath = join(dir, `turn-log.json.${process.pid}.tmp`);

    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 });

      const data: PersistedTurnLog = {
        version: 2,
        turnIndex: this.turnIndex,
        warnNotified: this._warnNotified,
        entries: this.entries,
      };

      writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
      renameSync(tmpPath, finalPath);
    } catch {
      // Silent — persistence failure is non-fatal.
      // In-memory operation continues normally.
    }
  }

  /**
   * Remove .pi-git/turn-log.json.
   * No-op if the file doesn't exist.
   */
  private deleteFromDisk(): void {
    if (!this.repoRoot) return;

    const filePath = join(this.repoRoot, TURN_LOG_DIR, TURN_LOG_FILE);
    try {
      unlinkSync(filePath);
    } catch {
      // File may not exist — that's fine
    }
  }
}

/** Module-level singleton — same pattern as footerManager */
export const turnLog = new TurnLog();
