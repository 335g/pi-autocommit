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

function getSystemPrompt(lang: string): string {
  if (isJapanese(lang)) {
    return `あなたはgit diff解析ツールです。git diffを分析し、変更を論理的なhunkに分割してください。

ルール:
- 各hunkは単一の論理的な変更を表す（例：「機能Xを追加」「バグYを修正」「Zをリファクタリング」）
- 同じ論理的な変更に属するファイル変更はグループ化する
- 1つのファイルに複数の独立した変更が含まれる場合は、別々のhunkに分割する
- 新規ファイルの場合は、内容から論理的な目的を推定する

各hunkに対して以下を提供してください:
- files: このhunkに含まれるファイルパスの配列
- message: Conventional Commits形式のメッセージ。typeは feat, fix, docs, style, refactor, test, chore から選択
  - サブジェクトは50文字以内に収める
  - 命令形を使用する（例：「追加」でなく「追加する」→英語のimperative moodに相当する日本語表現）
  - スコープはリポジトリの文脈から明確に推定できる場合のみ含める
  - 日本語でメッセージを記述する

以下の形式のJSON配列のみを返してください。マークダウンのコードフェンスや追加のテキストは不要です:
[
  {
    "files": ["path/to/file1.ts", "path/to/file2.ts"],
    "message": "feat: ユーザー認証機能を追加"
  }
]`;
  }

  return `You are a git diff analyzer. Your task is to analyze a git diff and split the changes into logical hunks.

Rules:
- Each hunk should represent a single logical change (e.g., "add feature X", "fix bug Y", "refactor Z")
- Group related file changes together if they belong to the same logical change
- If a single file contains multiple independent changes, split them into separate hunks
- For new files, infer the logical purpose from the content

For each hunk, provide:
- files: array of file paths included in this hunk
- message: a Conventional Commits style message. Choose type from: feat, fix, docs, style, refactor, test, chore
  - Keep the subject under 50 characters
  - Use imperative mood (e.g., "add" not "added")
  - Include scope only if clearly inferable from the repository context

Return ONLY a JSON array in this exact format, with no markdown code fences or additional text:
[
  {
    "files": ["path/to/file1.ts", "path/to/file2.ts"],
    "message": "feat(scope): add user authentication"
  }
]`;
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

export async function analyzeDiff(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  diff: string,
): Promise<Hunk[]> {
  const model = resolveModel(ctx);
  if (!model) {
    return fallbackFileBasedHunks(diff);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return fallbackFileBasedHunks(diff);
  }

  try {
    const lang = getLanguage();
    const context: Context = {
      systemPrompt: getSystemPrompt(lang),
      messages: [
        {
          role: "user",
          content: buildPrompt(diff, lang),
          timestamp: Date.now(),
        },
      ],
    };

    const result = await completeSimple(model, context, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: ctx.signal,
      reasoning: "minimal",
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
