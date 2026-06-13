/**
 * Diff analysis and hunk splitting logic
 *
 * Uses the configured or session AI model to analyze git diff and split changes into
 * logical hunks with Conventional Commits messages.
 */

import { aiComplete } from "./ai.js";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Hunk, DiffHunk, CommitGroup, HunkGroupingResult, DiffHunkRef } from "../types.js";
import { diagIncr } from "../utils/diagnostics.js";
import { footerManager } from "../utils/footer-manager.js";
import { t } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import {
  sanitizeHunk,
  inferTypeFromFiles,
  isGenericMessage,
  generateFallbackMessage,
} from "./commit-message.js";

/** Maximum diff bytes to send to the AI (truncated if larger) */
const MAX_DIFF_BYTES = 30_000;

/** Max files per AI analysis batch (split large diffs for progress visibility) */
const FILES_PER_BATCH = 8;

/** Maximum output tokens for the AI completion (hunk JSON can be large with many indices) */
const MAX_OUTPUT_TOKENS = 2048;

function getSystemPrompt(lang: string): string {
  return t(lang, "diffAnalyzer.systemPrompt");
}

function getSystemPromptWithContext(lang: string): string {
  return t(lang, "diffAnalyzer.systemPromptWithContext");
}

function buildPrompt(diff: string, lang: string): string {
  const examples = t(lang, "diffAnalyzer.examples");
  const hintText = buildTypeHint(diff);
  const typeHints = hintText
    ? `${t(lang, "diffAnalyzer.typeHints")}\n${hintText}\n\n`
    : "";
  return t(lang, "diffAnalyzer.buildPrompt", { diff, examples, typeHints });
}

/** Build a prompt that includes TurnLog conversation context */
function buildPromptWithContext(
  diff: string,
  turnLogText: string,
  lang: string,
): string {
  return t(lang, "diffAnalyzer.buildPromptWithContext", {
    diff,
    turnLogText,
  });
}

/**
 * Build a type hint string from the files in a diff.
 * Groups files by inferred Conventional Commit type to help cheap AI models
 * choose the correct type. Empty string when no files are found.
 */
function buildTypeHint(diff: string): string {
  const fileRegex = /^diff --git a\/(.+) b\/(.+)$/gm;
  const files: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = fileRegex.exec(diff)) !== null) {
    files.push(match[2]);
  }

  if (files.length === 0) return "";

  // Group files by inferred type
  const typeGroups = new Map<string, string[]>();
  for (const file of files) {
    const type = inferTypeFromFiles([file]);
    if (!typeGroups.has(type)) typeGroups.set(type, []);
    typeGroups.get(type)!.push(file);
  }

  // Build compact hint: one line per type
  return [...typeGroups.entries()]
    .map(([type, paths]) => {
      if (paths.length === 1) return `${type}: ${paths[0]}`;
      const shown = paths.slice(0, 3);
      const suffix = paths.length > 3 ? ` ... (${paths.length} files)` : "";
      return `${type}: ${shown.join(", ")}${suffix}`;
    })
    .join("\n");
}

/** Pattern to extract {files, message} pairs from broken JSON */
const HUNK_PAIR_PATTERN =
  /\{\s*"files"\s*:\s*\[([^\]]*)\]\s*,?\s*"message"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/gs;

/** Try JSON.parse and return typed Hunks, or null on any failure */
function tryParseHunkJSON(text: string): Hunk[] | null {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((item: unknown) => {
        if (typeof item !== "object" || item === null) return null;
        const hunk = item as Record<string, unknown>;
        const files = Array.isArray(hunk.files)
          ? hunk.files.filter((f): f is string => typeof f === "string")
          : [];
        const message =
          typeof hunk.message === "string"
            ? hunk.message
            : "chore: update files";
        return { files, message } as Hunk;
      })
      .filter((h): h is Hunk => h !== null);
  } catch {
    return null;
  }
}

/** Regex-based extraction of hunk pairs from broken JSON */
function tryRegexExtractHunks(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  const pattern = new RegExp(HUNK_PAIR_PATTERN.source, "gs");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const filesStr = match[1];
    const message = match[2].replace(/\\"/g, '"');

    // Parse file paths from the captured array segment
    const fileMatches = filesStr.match(/"((?:[^"\\]|\\.)*)"/g);
    const files = fileMatches
      ? fileMatches.map((f) => f.slice(1, -1).replace(/\\"/g, '"'))
      : [];

    if (files.length > 0 && message.length > 0) {
      hunks.push({ files, message });
    }
  }

  return hunks;
}

function parseHunks(text: string): Hunk[] {
  let jsonText = text.trim();

  // Layer 1: Extract JSON from code fences
  const codeFenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeFenceMatch) {
    jsonText = codeFenceMatch[1].trim();
  }

  // Layer 2: Direct JSON.parse
  const direct = tryParseHunkJSON(jsonText);
  if (direct) {
    diagIncr("parseLayer2_directJSON");
    return direct;
  }

  // Layer 3: Strip trailing non-JSON text and retry
  const lastBracket = jsonText.lastIndexOf("]");
  if (lastBracket > 0) {
    const trimmed = jsonText.substring(0, lastBracket + 1).trim();
    const trimmedResult = tryParseHunkJSON(trimmed);
    if (trimmedResult) {
      diagIncr("parseLayer3_trailingStrip");
      return trimmedResult;
    }
  }

  // Layer 4: Regex pair extraction from malformed JSON
  const regexResult = tryRegexExtractHunks(jsonText);
  if (regexResult.length > 0) {
    diagIncr("parseLayer4_regexExtract");
    return regexResult;
  }

  diagIncr("parseFallback_fileBased");
  return [];
}

function fallbackFileBasedHunks(diff: string): Hunk[] {
  // Parse diff to extract file paths
  const hunks: Hunk[] = [];
  const fileRegex = /^diff --git a\/(.+) b\/(.+)$/gm;
  let match: RegExpExecArray | null;

  while (true) {
    match = fileRegex.exec(diff);
    if (match === null) break;
    const filePath = match[2]; // Use 'b/' path (new version)
    hunks.push({
      files: [filePath],
      message: `chore: update ${filePath}`,
    });
  }

  return hunks;
}

/** Count files in a diff by counting "diff --git" headers */
function countFilesInDiff(diff: string): number {
  const matches = diff.match(/^diff --git/gm);
  return matches ? matches.length : 0;
}

/** Truncate oversized diff at a clean line break */
export function truncateDiff(diff: string, maxBytes: number): string {
  if (diff.length <= maxBytes) return diff;
  const slice = diff.substring(0, maxBytes);
  const lastNewline = slice.lastIndexOf("\n");
  return lastNewline > 0 ? slice.substring(0, lastNewline) : slice;
}

/** Strip noise lines from diff that don't help AI analysis */
export function stripDiffNoise(diff: string): string {
  const lines = diff.split("\n");
  const result: string[] = [];
  let inBinary = false;

  for (const line of lines) {
    // Skip git index lines (object hash metadata, no semantic value)
    if (/^index [0-9a-f]+\.\.[0-9a-f]+/.test(line)) continue;

    // Detect binary diff content start
    if (line.startsWith("GIT binary patch") || line.startsWith("literal ")) {
      inBinary = true;
      result.push(line); // keep the header for context
      continue;
    }

    // Skip binary diff payload (base64 lines, incomprehensible to AI)
    if (inBinary) {
      if (line.trim() === "" || /^[A-Za-z0-9+/=]+$/.test(line.trim())) {
        continue;
      }
      inBinary = false;
    }

    result.push(line);
  }

  return result.join("\n");
}

/**
 * Split a full diff into per-batch diff strings, each containing ≤ batchSize files.
 * Groups files by parent directory first so related files stay in the same batch.
 */
function splitDiffIntoBatches(diff: string, batchSize: number): string[] {
  const fileDiffs = splitDiffByFile(diff);
  const files = [...fileDiffs.keys()];

  // Group files by parent directory (files in same dir are likely related)
  const dirGroups = new Map<string, string[]>();
  for (const file of files) {
    const lastSlash = file.lastIndexOf("/");
    const dir = lastSlash >= 0 ? file.substring(0, lastSlash) : ".";
    if (!dirGroups.has(dir)) dirGroups.set(dir, []);
    dirGroups.get(dir)!.push(file);
  }

  // Pack directory groups into batches, keeping groups together when possible
  const fileBatches: string[][] = [];
  let current: string[] = [];

  for (const groupFiles of dirGroups.values()) {
    // If this group would overflow the current batch, start a new one
    if (current.length > 0 && current.length + groupFiles.length > batchSize) {
      fileBatches.push(current);
      current = [];
    }
    // If a single group exceeds batchSize, split it (files in same dir are
    // highly related, so this is the least-damaging place to split)
    for (let i = 0; i < groupFiles.length; i += batchSize) {
      const chunk = groupFiles.slice(i, i + batchSize);
      if (chunk.length === groupFiles.length && current.length === 0) {
        // Single group fits entirely in one batch
        current.push(...chunk);
      } else if (current.length + chunk.length <= batchSize) {
        current.push(...chunk);
      } else {
        if (current.length > 0) fileBatches.push(current);
        current = [...chunk];
      }
    }
  }
  if (current.length > 0) fileBatches.push(current);

  // Convert batches of file names to diff strings
  return fileBatches.map((batchFiles) => {
    const lines: string[] = [];
    for (const file of batchFiles) {
      const diffLines = fileDiffs.get(file);
      if (diffLines) lines.push(...diffLines);
    }
    return lines.join("\n");
  });
}

export async function analyzeDiff(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  diff: string,
  langOverride?: string,
  turnLogText?: string,
): Promise<Hunk[]> {
  const fileCount = countFilesInDiff(diff);
  const lang = langOverride ?? getLanguage(ctx.cwd);

  // Choose prompt builder: with context if TurnLog is provided
  const buildPromptFn = turnLogText
    ? (d: string) => buildPromptWithContext(d, turnLogText, lang)
    : (d: string) => buildPrompt(d, lang);
  const systemPromptFn = turnLogText
    ? () => getSystemPromptWithContext(lang)
    : () => getSystemPrompt(lang);

  // Split into batches if many files (for progress visibility + smaller payloads)
  if (fileCount > FILES_PER_BATCH) {
    const batches = splitDiffIntoBatches(diff, FILES_PER_BATCH);
    const allHunks: Hunk[] = [];

    for (let i = 0; i < batches.length; i++) {
      await footerManager.setCommitProgress(i + 1, batches.length);

      const batchCleaned = stripDiffNoise(batches[i]);
      const batchTruncated = truncateDiff(batchCleaned, MAX_DIFF_BYTES);

      try {
        const result = await aiComplete(ctx, {
          systemPrompt: systemPromptFn(),
          userMessage: buildPromptFn(batchTruncated),
          maxTokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
        });
        if (!result) {
          allHunks.push(...fallbackFileBasedHunks(batches[i]));
          continue;
        }
        const hunks = parseHunks(result.text);
        if (hunks.length > 0) {
          allHunks.push(...hunks);
        } else {
          // Empty batch result → use fallback for these files
          allHunks.push(...fallbackFileBasedHunks(batches[i]));
        }
      } catch {
        allHunks.push(...fallbackFileBasedHunks(batches[i]));
      }
    }

    if (allHunks.length === 0) {
      return fallbackFileBasedHunks(diff);
    }
    return allHunks;
  }

  // Single batch: standard path
  const cleaned = stripDiffNoise(diff);
  const truncated = truncateDiff(cleaned, MAX_DIFF_BYTES);

  try {
    const result = await aiComplete(ctx, {
      systemPrompt: systemPromptFn(),
      userMessage: buildPromptFn(truncated),
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
    });
    if (!result) {
      return fallbackFileBasedHunks(diff);
    }
    const hunks = parseHunks(result.text);
    if (hunks.length === 0) {
      return fallbackFileBasedHunks(diff);
    }
    return hunks;
  } catch {
    return fallbackFileBasedHunks(diff);
  }
}

// ───────────────────────────────────────────────
// Intent-based hunk analysis (new)
// ───────────────────────────────────────────────

function getIntentSystemPrompt(lang: string): string {
  return t(lang, "diffAnalyzer.intentSystemPrompt");
}

function buildIntentPrompt(
  turnLogText: string,
  numberedHunksText: string,
  lang: string,
): string {
  return t(lang, "diffAnalyzer.intentBuildPrompt", {
    turnLogText,
    numberedHunksText,
  });
}

/**
 * Parse AI response into HunkGroupingResult.
 * Handles JSON objects with nested groups arrays.
 * Falls back gracefully on parse failures.
 */
function parseHunkGroupingResult(text: string): HunkGroupingResult | null {
  let jsonText = text.trim();

  // Layer 1: Extract JSON from code fences
  const codeFenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeFenceMatch) {
    jsonText = codeFenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const overallConfidence = parsed.overallConfidence;
    if (
      overallConfidence !== "high" &&
      overallConfidence !== "medium" &&
      overallConfidence !== "low"
    ) {
      return null;
    }

    if (!Array.isArray(parsed.groups)) return null;

    const groups: CommitGroup[] = [];
    for (const g of parsed.groups) {
      if (typeof g !== "object" || g === null) continue;
      if (!Array.isArray(g.hunks) || typeof g.message !== "string") continue;

      const hunks: DiffHunkRef[] = [];
      for (const idx of g.hunks as number[]) {
        if (typeof idx === "number" && Number.isInteger(idx) && idx > 0) {
          hunks.push({ globalIndex: idx, file: "" });
        }
      }
      if (hunks.length === 0) continue;

      const confidence =
        g.confidence === "high" || g.confidence === "medium" || g.confidence === "low"
          ? g.confidence
          : "medium";

      groups.push({
        hunks,
        message: (g.message as string) || "chore: update files",
        confidence,
        turnIndices: Array.isArray(g.turnIndices)
          ? (g.turnIndices as number[]).filter(
              (t: unknown) => typeof t === "number",
            )
          : undefined,
        note: typeof g.note === "string" ? g.note : undefined,
      });
    }

    if (groups.length === 0) return null;

    return { overallConfidence, groups };
  } catch {
    return null;
  }
}

/**
 * Analyze a git diff using intent-based hunk splitting.
 *
 * Uses conversation history (TurnLog) as the primary source for commit
 * boundaries, with diff hunks for verification and precise grouping.
 *
 * Includes an implicit consistency check: AI assigns confidence levels
 * to each group, and overallConfidence drives the fallback strategy.
 *
 * @returns HunkGroupingResult, or null if AI analysis failed (caller should fall back)
 */
export async function analyzeDiffIntent(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  diff: string,
  turnLogText: string,
  langOverride?: string,
): Promise<HunkGroupingResult | null> {
  const lang = langOverride ?? getLanguage(ctx.cwd);

  // Parse diff into numbered hunks
  const diffHunks = parseDiffHunks(diff);
  if (diffHunks.length === 0) return null;

  const numberedHunksText = formatNumberedHunks(diffHunks);

  // Build prompt
  const systemPrompt = getIntentSystemPrompt(lang);
  const userMessage = buildIntentPrompt(turnLogText, numberedHunksText, lang);

  try {
    const result = await aiComplete(ctx, {
      systemPrompt,
      userMessage,
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
    });

    if (!result) return null;

    const grouping = parseHunkGroupingResult(result.text);
    if (!grouping) return null;

    // Enrich DiffHunkRef with file paths from the parsed DiffHunk array
    const hunkMap = new Map<number, DiffHunk>();
    for (const h of diffHunks) {
      hunkMap.set(h.globalIndex, h);
    }

    for (const group of grouping.groups) {
      for (const ref of group.hunks) {
        const h = hunkMap.get(ref.globalIndex);
        if (h) ref.file = h.file;
      }
    }

    return grouping;
  } catch {
    return null;
  }
}

/**
 * Validate that every DiffHunk is assigned to exactly one commit group.
 * Unassigned hunks are collected into a catch-all group.
 * Out-of-range indices are silently dropped.
 */
export function validateHunkCoverage(
  groups: CommitGroup[],
  totalHunks: number,
): CommitGroup[] {
  const assigned = new Set<number>();
  const result: CommitGroup[] = [];

  for (const g of groups) {
    const validHunks = g.hunks.filter((ref) => {
      if (ref.globalIndex < 1 || ref.globalIndex > totalHunks) return false;
      if (assigned.has(ref.globalIndex)) return false;
      assigned.add(ref.globalIndex);
      return true;
    });
    if (validHunks.length > 0) {
      result.push({ ...g, hunks: validHunks });
    }
  }

  const unassigned: DiffHunkRef[] = [];
  for (let i = 1; i <= totalHunks; i++) {
    if (!assigned.has(i)) {
      unassigned.push({ globalIndex: i, file: "" });
    }
  }

  if (unassigned.length > 0) {
    result.push({
      hunks: unassigned,
      message: "chore: その他の変更を適用",
      confidence: "low",
      note: "AIがグループ化できなかったhunkの自動回収",
    });
  }

  return result;
}

/**
 * Post-process AI-generated hunks: sanitize commit messages, deduplicate files
 * across hunks (each file belongs only to its first hunk), and remove empty hunks.
 */
export function processHunks(hunks: Hunk[]): Hunk[] {
  const sanitized = hunks.map(sanitizeHunk);
  const seenFiles = new Set<string>();
  return sanitized
    .map((hunk) => {
      // Check for generic messages and replace with file-based fallback
      if (isGenericMessage(hunk.message)) {
        return { ...hunk, message: generateFallbackMessage(hunk.files) };
      }
      return hunk;
    })
    .map((hunk) => ({
      ...hunk,
      files: hunk.files.filter((f) => {
        if (seenFiles.has(f)) return false;
        seenFiles.add(f);
        return true;
      }),
    }))
    .filter((hunk) => hunk.files.length > 0);
}

// ───────────────────────────────────────────────
// Intent-based diff-hunk parsing
// ───────────────────────────────────────────────

/** Pattern for @@ hunk header: @@ -oldStart,oldCount +newStart,newCount @@ [context] */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse a unified git diff into numbered DiffHunks (one per @@ block).
 *
 * Non-splittable files (binary, rename-only, mode-only) produce a single
 * atomic DiffHunk with `isAtomic: true`. All hunks are assigned 1-based
 * global indices for AI prompt reference.
 */
export function parseDiffHunks(fullDiff: string): DiffHunk[] {
  const fileDiffs = splitDiffByFile(fullDiff);
  const result: DiffHunk[] = [];
  let globalIndex = 0;

  for (const [file, lines] of fileDiffs) {
    const hunks = extractHunksFromFile(file, lines);

    if (hunks.length === 0) {
      // Atomic change: binary, rename-only, mode-only, or deleted file.
      const content = lines.join("\n");
      const isNew = lines.some((l) => l.startsWith("--- /dev/null"));
      const isDeleted = lines.some((l) => l.startsWith("+++ /dev/null"));
      const summary =
        lines
          .find((l) => !l.startsWith("diff ") && !l.startsWith("--- ") &&
            !l.startsWith("+++ ") && !l.startsWith("index ") &&
            !l.startsWith("similarity ") && !l.startsWith("rename ") &&
            !l.startsWith("old mode ") && !l.startsWith("new mode ") &&
            !l.startsWith("GIT binary ") && !l.startsWith("literal ") &&
            l.trim() !== "") || isDeleted
            ? "(deleted)"
            : isNew
              ? "(new file)"
              : "(binary/mode/rename)";

      globalIndex++;
      result.push({
        globalIndex,
        file,
        hunkIndexInFile: 0,
        header: lines[0] || `diff --git a/${file} b/${file}`,
        content,
        summary,
        isNewFile: isNew,
        isDeletedFile: isDeleted,
        isAtomic: true,
      });
      continue;
    }

    // Regular hunks: assign per-file and global indices
    for (let i = 0; i < hunks.length; i++) {
      const hunkLines = hunks[i];
      const headerLine = hunkLines[0];
      const headerMatch = HUNK_HEADER_RE.exec(headerLine);

      // Extract a one-line summary from the @@ context text
      const contextHint = headerMatch?.[5]?.trim() || "";
      // Take the first non-context-line diff line as additional hint
      const firstChangeLine =
        hunkLines
          .slice(1)
          .find((l) => l.startsWith("+") || l.startsWith("-"))
          ?.slice(1)
          ?.trim() || "";
      const summary = contextHint || firstChangeLine || file;

      // Line range for display
      const newStart = headerMatch ? parseInt(headerMatch[3], 10) : 0;
      const newCount = headerMatch?.[4]
        ? parseInt(headerMatch[4], 10)
        : headerMatch
          ? 1
          : 0;

      globalIndex++;
      result.push({
        globalIndex,
        file,
        hunkIndexInFile: i,
        header: `@@ ${newStart}-${newStart + newCount - 1}`,
        content: hunkLines.join("\n"),
        summary,
        isNewFile: lines.some((l) => l.startsWith("--- /dev/null")),
        isDeletedFile: lines.some((l) => l.startsWith("+++ /dev/null")),
        isAtomic: false,
      });
    }
  }

  return result;
}

/**
 * Extract individual @@ hunks from a single file's diff lines.
 * Returns an array of hunk-line-arrays, or empty array for atomic files.
 */
function extractHunksFromFile(
  _file: string,
  lines: string[],
): string[][] {
  const hunks: string[][] = [];
  let current: string[] = [];
  let hasAnyHunk = false;

  for (const line of lines) {
    if (HUNK_HEADER_RE.test(line)) {
      if (current.length > 0) {
        hunks.push(current);
        current = [];
      }
      hasAnyHunk = true;
      current.push(line);
    } else if (hasAnyHunk && current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0 && hasAnyHunk) {
    hunks.push(current);
  }

  return hunks;
}

/**
 * Format DiffHunks for AI prompt injection.
 * Each hunk gets a [HN] label with file path, line range, and first-line summary.
 */
export function formatNumberedHunks(hunks: DiffHunk[]): string {
  if (hunks.length === 0) return "";

  const lines: string[] = [];

  for (const h of hunks) {
    const tag = h.isAtomic
      ? h.isDeletedFile
        ? " (削除)"
        : h.isNewFile
          ? " (新規)"
          : " (バイナリ等)"
      : "";

    const lineRef = h.isAtomic ? "" : ` (L${h.header.replace("@@ ", "")})`;
    const display = `[H${h.globalIndex}] ${h.file}${lineRef}${tag}: ${h.summary.substring(0, 60)}`;
    lines.push(display);
  }

  return lines.join("\n");
}

/**
 * Split a full diff into per-file diff line arrays, keyed by file path.
 */
function splitDiffByFile(fullDiff: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const lines = fullDiff.split("\n");
  let currentFile: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (currentFile) {
        result.set(currentFile, currentLines);
      }
      const match = line.match(/diff --git a\/(.+?) b\/(.+?)$/);
      if (match) {
        currentFile = match[2];
        currentLines = [line];
      }
    } else if (currentFile) {
      currentLines.push(line);
    }
  }

  if (currentFile) {
    result.set(currentFile, currentLines);
  }

  return result;
}
