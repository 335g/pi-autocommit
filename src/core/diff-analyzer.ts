/**
 * Diff analysis and hunk splitting logic
 *
 * Uses the configured or session AI model to analyze git diff and split changes into
 * logical hunks with Conventional Commits messages.
 */

import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { FileStats, Hunk } from "../types.js";
import { footerManager } from "../utils/footer-manager.js";
import { t } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import { sanitizeHunk } from "./commit-message.js";
import { resolveModel } from "./resolve-model.js";

/** Maximum diff bytes to send to the AI (truncated if larger) */
const MAX_DIFF_BYTES = 30_000;

/** Max files per AI analysis batch (split large diffs for progress visibility) */
const FILES_PER_BATCH = 8;

/** Maximum output tokens for the AI completion (hunk JSON is small) */
const MAX_OUTPUT_TOKENS = 1024;

function getSystemPrompt(lang: string): string {
  return t(lang, "diffAnalyzer.systemPrompt");
}

function buildPrompt(diff: string, lang: string): string {
  const examples = t(lang, "diffAnalyzer.examples");
  return t(lang, "diffAnalyzer.buildPrompt", { diff, examples });
}

/** Pattern to extract {files, message} pairs from broken JSON */
const HUNK_PAIR_PATTERN = /\{\s*"files"\s*:\s*\[([^\]]*)\]\s*,\s*"message"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/gs;

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
  if (direct) return direct;

  // Layer 3: Strip trailing non-JSON text and retry
  const lastBracket = jsonText.lastIndexOf("]");
  if (lastBracket > 0) {
    const trimmed = jsonText.substring(0, lastBracket + 1).trim();
    const trimmedResult = tryParseHunkJSON(trimmed);
    if (trimmedResult) return trimmedResult;
  }

  // Layer 4: Regex pair extraction from malformed JSON
  const regexResult = tryRegexExtractHunks(jsonText);
  if (regexResult.length > 0) return regexResult;

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
function truncateDiff(diff: string, maxBytes: number): string {
  if (diff.length <= maxBytes) return diff;
  const slice = diff.substring(0, maxBytes);
  const lastNewline = slice.lastIndexOf("\n");
  return lastNewline > 0 ? slice.substring(0, lastNewline) : slice;
}

/** Strip noise lines from diff that don't help AI analysis */
function stripDiffNoise(diff: string): string {
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

/**
 * Send a single batch of diff to the AI and return parsed hunks.
 */
async function callAIForDiff(
  model: Model<Api>,
  auth: { apiKey?: string; headers?: Record<string, string> },
  ctx: ExtensionContext,
  diff: string,
  langOverride?: string,
): Promise<Hunk[]> {
  const lang = langOverride ?? getLanguage(ctx.cwd);
  const cleaned = stripDiffNoise(diff);
  const truncated = truncateDiff(cleaned, MAX_DIFF_BYTES);

  const context: Context = {
    systemPrompt: getSystemPrompt(lang),
    messages: [
      {
        role: "user",
        content: buildPrompt(truncated, lang),
        timestamp: Date.now(),
      },
    ],
  };

  const result = await completeSimple(model, context, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    signal: ctx.signal,
    reasoning: "minimal",
    temperature: 0,
    maxTokens: MAX_OUTPUT_TOKENS,
  });

  const text = result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  return parseHunks(text);
}

export async function analyzeDiff(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  diff: string,
  langOverride?: string,
): Promise<Hunk[]> {
  const fileCount = countFilesInDiff(diff);
  const lang = langOverride ?? getLanguage(ctx.cwd);

  const model = resolveModel(ctx);
  if (!model) {
    return fallbackFileBasedHunks(diff);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return fallbackFileBasedHunks(diff);
  }

  // Split into batches if many files (for progress visibility + smaller payloads)
  if (fileCount > FILES_PER_BATCH) {
    const batches = splitDiffIntoBatches(diff, FILES_PER_BATCH);
    const allHunks: Hunk[] = [];

    for (let i = 0; i < batches.length; i++) {
      void footerManager.setCommitProgress(i + 1, batches.length);

      try {
        const hunks = await callAIForDiff(model, auth, ctx, batches[i], lang);
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
  try {
    const hunks = await callAIForDiff(model, auth, ctx, diff, lang);
    if (hunks.length === 0) {
      return fallbackFileBasedHunks(diff);
    }
    return hunks;
  } catch {
    return fallbackFileBasedHunks(diff);
  }
}

/**
 * Post-process AI-generated hunks: sanitize commit messages, deduplicate files
 * across hunks (each file belongs only to its first hunk), and remove empty hunks.
 */
export function processHunks(hunks: Hunk[]): Hunk[] {
  const sanitized = hunks.map(sanitizeHunk);
  const seenFiles = new Set<string>();
  return sanitized
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

/**
 * Parse addition/deletion counts for each file from a full diff.
 */
function parseDiffStats(fullDiff: string): Map<string, FileStats> {
  const result = new Map<string, FileStats>();
  const lines = fullDiff.split("\n");
  let currentFile: string | null = null;
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (currentFile) {
        result.set(currentFile, { path: currentFile, additions, deletions });
      }
      const match = line.match(/diff --git a\/(.+?) b\/(.+?)$/);
      if (match) {
        currentFile = match[2];
        additions = 0;
        deletions = 0;
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  if (currentFile) {
    result.set(currentFile, { path: currentFile, additions, deletions });
  }

  return result;
}
