/**
 * Diff analysis and hunk splitting logic
 *
 * Uses the configured or session AI model to analyze git diff and split changes into
 * logical hunks with Conventional Commits messages.
 */

import type { Context } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { FileStats, Hunk } from "../types.js";
import { isJapanese } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import { sanitizeHunk } from "./commit-message.js";
import { resolveModel } from "./resolve-model.js";

/** Maximum diff bytes to send to the AI (truncated if larger) */
const MAX_DIFF_BYTES = 30_000;

/** Files threshold: skip AI analysis when ≤ this many files changed */
const FAST_PATH_FILE_LIMIT = 5;

/** Maximum output tokens for the AI completion (hunk JSON is small) */
const MAX_OUTPUT_TOKENS = 1024;

function getSystemPrompt(lang: string): string {
  if (isJapanese(lang)) {
    return `git diffを論理的なhunkに分割してください。

ルール:
- 各hunk = 単一の論理的な変更（例：「機能Xを追加」「バグYを修正」）
- 関連するファイル変更はグループ化する
- 1ファイルに独立した複数の変更がある場合は分割する

以下のJSON配列のみを返してください:
[
  {"files": ["path/to/file1.ts", "path/to/file2.ts"], "message": "feat: 機能を追加"},
  {"files": ["path/to/file3.ts"], "message": "fix: バグを修正"}
]

メッセージ形式: Conventional Commits (feat, fix, docs, style, refactor, test, chore)。
サブジェクトは50文字以内。日本語で記述。`;
  }

  return `Split git diff into logical hunks.

Rules:
- Each hunk = single logical change (e.g., "add feature X", "fix bug Y")
- Group related file changes together
- Split independent changes within one file into separate hunks

Return ONLY a JSON array:
[
  {"files": ["path/to/file1.ts", "path/to/file2.ts"], "message": "feat(scope): add feature"},
  {"files": ["path/to/file3.ts"], "message": "fix: resolve null check"}
]

Message format: Conventional Commits (feat, fix, docs, style, refactor, test, chore).
Keep subject under 50 chars. Use imperative mood.`;
}

function buildPrompt(diff: string, lang: string): string {
  if (isJapanese(lang)) {
    return `以下のgit diffを分析し、論理的なhunkに分割してください:

\`\`\`diff
${diff}
\`\`\`

指定された形式のJSON配列のみを返してください。`;
  }

  return `Here is the git diff to analyze. Split it into logical hunks:

\`\`\`diff
${diff}
\`\`\`

Respond with ONLY a JSON array of hunks as specified.`;
}

function parseHunks(text: string): Hunk[] {
  // Extract JSON from the response (handle code fences)
  let jsonText = text.trim();
  const codeFenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeFenceMatch) {
    jsonText = codeFenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      throw new Error("Response is not an array");
    }
    return parsed.map((item: unknown) => {
      if (typeof item !== "object" || item === null) {
        throw new Error("Invalid hunk item");
      }
      const hunk = item as Record<string, unknown>;
      const files = Array.isArray(hunk.files)
        ? hunk.files.filter((f): f is string => typeof f === "string")
        : [];
      const message =
        typeof hunk.message === "string" ? hunk.message : "chore: update files";
      return { files, message } as Hunk;
    });
  } catch {
    return [];
  }
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

export async function analyzeDiff(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  diff: string,
): Promise<Hunk[]> {
  // Fast path: few files → instant fallback, skip AI call entirely
  if (countFilesInDiff(diff) <= FAST_PATH_FILE_LIMIT) {
    return fallbackFileBasedHunks(diff);
  }

  const model = resolveModel(ctx);
  if (!model) {
    return fallbackFileBasedHunks(diff);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return fallbackFileBasedHunks(diff);
  }

  // Strip noise and truncate oversized diffs
  const cleanedDiff = stripDiffNoise(diff);
  const analysisDiff = truncateDiff(cleanedDiff, MAX_DIFF_BYTES);

  try {
    const lang = getLanguage();
    const context: Context = {
      systemPrompt: getSystemPrompt(lang),
      messages: [
        {
          role: "user",
          content: buildPrompt(analysisDiff, lang),
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

    const hunks = parseHunks(text);
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
export function splitDiffByFile(fullDiff: string): Map<string, string[]> {
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
export function parseDiffStats(fullDiff: string): Map<string, FileStats> {
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
