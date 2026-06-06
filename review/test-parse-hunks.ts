/**
 * Unit tests for parseHunks() JSON repair layers.
 *
 * Run: npx tsx review/test-parse-hunks.ts
 *
 * Tests the regex-based repair that rescues malformed JSON from cheap AI models.
 * Does NOT require a running pi session — pure function tests.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Replicated helpers (mirrors diff-analyzer.ts) ──────────────
// We replicate rather than import to keep the test self-contained.
// The regex and logic must stay in sync with the production code.

const HUNK_PAIR_PATTERN =
  /\{\s*"files"\s*:\s*\[([^\]]*)\]\s*,?\s*"message"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/gs;

interface Hunk {
  files: string[];
  message: string;
}

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

function tryRegexExtractHunks(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  const pattern = new RegExp(HUNK_PAIR_PATTERN.source, "gs");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const filesStr = match[1];
    const message = match[2].replace(/\\"/g, '"');

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

/** Full parseHunks with all 4 repair layers (mirrors production) */
function parseHunks(text: string): Hunk[] {
  let jsonText = text.trim();

  // Layer 1: code fence
  const cf = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (cf) jsonText = cf[1].trim();

  // Layer 2: direct parse
  const direct = tryParseHunkJSON(jsonText);
  if (direct) return direct;

  // Layer 3: strip trailing text
  const lastBracket = jsonText.lastIndexOf("]");
  if (lastBracket > 0) {
    const trimmed = jsonText.substring(0, lastBracket + 1).trim();
    const trimmedResult = tryParseHunkJSON(trimmed);
    if (trimmedResult) return trimmedResult;
  }

  // Layer 4: regex extract
  const regexResult = tryRegexExtractHunks(jsonText);
  if (regexResult.length > 0) return regexResult;

  return [];
}

// ── Test runner ────────────────────────────────────────────────

interface TestCase {
  name: string;
  input: string;
  expectedHunks: number;
  /** If set, check first hunk's message exactly */
  expectedFirstMessage?: string;
  /** If set, check first hunk's file count */
  expectedFirstFileCount?: number;
}

const tests: TestCase[] = [
  {
    name: "valid JSON with code fence",
    input:
      '```json\n[{"files":["a.ts"],"message":"feat: add feature"}]\n```',
    expectedHunks: 1,
    expectedFirstMessage: "feat: add feature",
  },
  {
    name: "valid JSON without code fence",
    input: '[{"files":["a.ts","b.ts"],"message":"fix: resolve bug"}]',
    expectedHunks: 1,
    expectedFirstMessage: "fix: resolve bug",
    expectedFirstFileCount: 2,
  },
  {
    name: "trailing text after JSON array (Layer 3)",
    input:
      '[{"files":["a.ts"],"message":"feat: add"}]\nSome extra text the model babbled',
    expectedHunks: 1,
  },
  {
    name: "missing comma between fields (Layer 4 rescue)",
    input: '[{"files":["a.ts"] "message":"feat: add"}]',
    expectedHunks: 1,
  },
  {
    name: "multiple hunks with preamble text",
    input:
      'Here is the result:\n[{"files":["a.ts"],"message":"feat: add A"},{"files":["b.ts"],"message":"fix: resolve B"}]\nDone.',
    expectedHunks: 2,
  },
  {
    name: "completely invalid — fallback to empty",
    input: "I cannot analyze this diff. There is nothing to commit.",
    expectedHunks: 0,
  },
  {
    name: "code fence with json tag",
    input:
      '```json\n[\n  {"files": ["x.ts"], "message": "chore: cleanup"}\n]\n```',
    expectedHunks: 1,
    expectedFirstMessage: "chore: cleanup",
  },
  {
    name: "escaped quotes in message (Layer 4)",
    input:
      '[{"files":["a.ts"],"message":"fix: handle \\"magic\\" value"}]',
    expectedHunks: 1,
  },
  {
    name: "message with scope",
    input:
      '[{"files":["src/auth/login.ts","src/auth/types.ts"],"message":"feat(auth): add login"}]',
    expectedHunks: 1,
    expectedFirstMessage: "feat(auth): add login",
    expectedFirstFileCount: 2,
  },
  {
    name: "empty array",
    input: "[]",
    expectedHunks: 0,
  },
  {
    name: "trailing comma in JSON (Layer 4 rescue)",
    input: '[{"files":["a.ts"],"message":"feat: add"},]',
    expectedHunks: 1,
  },
  {
    name: "newlines inside JSON array",
    input:
      '[\n  {"files": ["a.ts"], "message": "feat: add"},\n  {"files": ["b.ts"], "message": "fix: bug"}\n]',
    expectedHunks: 2,
  },
];

// ── Execute ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const test of tests) {
  const result = parseHunks(test.input);
  const ok =
    result.length === test.expectedHunks &&
    (test.expectedFirstMessage === undefined ||
      (result[0]?.message === test.expectedFirstMessage)) &&
    (test.expectedFirstFileCount === undefined ||
      (result[0]?.files.length === test.expectedFirstFileCount));

  if (ok) {
    passed++;
    console.log(`  ✅ ${test.name}`);
  } else {
    failed++;
    console.log(`  ❌ ${test.name}`);
    console.log(`     Expected ${test.expectedHunks} hunks, got ${result.length}`);
    if (test.expectedFirstMessage && result[0]) {
      console.log(
        `     Expected message: "${test.expectedFirstMessage}", got "${result[0].message}"`,
      );
    }
    if (test.expectedFirstFileCount && result[0]) {
      console.log(
        `     Expected file count: ${test.expectedFirstFileCount}, got ${result[0].files.length}`,
      );
    }
    console.log(`     Input: ${test.input.substring(0, 80)}...`);
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);

if (failed > 0) {
  process.exit(1);
}
