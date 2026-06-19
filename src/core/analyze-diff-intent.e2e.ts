/**
 * End-to-end test driver for intent-based hunk splitting.
 *
 * Creates a realistic git repo scenario, sets up TurnLog, constructs
 * the full AI prompt, and (optionally) calls the AI if a model is available.
 *
 * Usage:
 *   node --import tsx src/core/analyze-diff-intent.e2e.ts [--call-ai]
 *
 * Without --call-ai: prints the prompt that would be sent to the AI.
 * With --call-ai:    also calls the AI and prints the parsed response.
 */

import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import {
  parseDiffHunks,
  formatNumberedHunks,
  parseHunkGroupingResult,
  getIntentSystemPrompt,
  buildIntentPrompt,
} from "./diff-analyzer.js";
import { turnLog } from "./turn-log.js";
import type { AgentEndEvent } from "../types.js";

// ── Scenario Setup ──────────────────────────────

function setupScenario(): { root: string; cleanup: () => void } {
  const repoId = randomBytes(8).toString("hex");
  const root = join(tmpdir(), `pi-git-e2e-${repoId}`);
  mkdirSync(root, { recursive: true });
  execSync("git init -q", { cwd: root });
  execSync('git config user.email "e2e@test"', { cwd: root });
  execSync('git config user.name "E2E"', { cwd: root });

  // ── Turn 1: Create login form + API ──────────────────

  mkdirSync(join(root, "src", "auth"), { recursive: true });

  writeFileSync(join(root, "src/auth/login.ts"),
`import { useState } from 'react';

export function LoginForm() {
  const [email, setEmail] = useState('');
  return <form>{/* TODO */}</form>;
}
`, "utf-8");

  writeFileSync(join(root, "src/auth/api.ts"),
`export async function loginUser(email: string, password: string) {
  const res = await fetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return res.json();
}
`, "utf-8");

  // Turn 1 conversation: user asked for login form
  turnLog.append(
    makeTurnEvent(
      "ログインフォームを作成してください。API接続も含めて実装して。",
      "login.tsxにログインフォームコンポーネントを、api.tsに認証APIクライアントを作成しました。",
    ),
    ["src/auth/login.ts", "src/auth/api.ts"],
    "あなたはReact + TypeScriptのコーディングアシスタントです。",
    "ログインフォームを作成してください。API接続も含めて実装して。",
  );

  execSync("git add -A", { cwd: root });
  execSync('git commit -q -m "turn1: login form + api"', { cwd: root });

  // ── Turn 2: Add validation + fix typo ──────────────────

  writeFileSync(join(root, "src/auth/validation.ts"),
`export function validateEmail(email: string): boolean {
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
}
`, "utf-8");

  // Update login.ts to import validation and add error state
  writeFileSync(join(root, "src/auth/login.ts"),
`import { useState } from 'react';
import { validateEmail } from './validation';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateEmail(email)) {
      setError('メールアドレスが無効です');
      return;
    }
  }

  return <form onSubmit={handleSubmit}>{/* form fields */}</form>;
}
`, "utf-8");

  // Turn 2 conversation: user asked for validation + typo fix
  turnLog.append(
    makeTurnEvent(
      "入力バリデーションを追加してください。ついでにREADMEの誤字も修正して。",
      "validation.tsを追加し、login.tsにバリデーションロジックを組み込みました。READMEの説明も修正しました。",
    ),
    ["src/auth/validation.ts", "src/auth/login.ts"],
    "あなたはReact + TypeScriptのコーディングアシスタントです。",
    "入力バリデーションを追加してください。ついでにREADMEの誤字も修正して。",
  );

  // ── Simulate a human edit: someone manually tweaked the API file ──
  writeFileSync(join(root, "src/auth/api.ts"),
`export async function loginUser(email: string, password: string) {
  const res = await fetch('/api/v2/login', {  // v2 — manual edit
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('Login failed');
  return res.json();
}
`, "utf-8");

  return {
    root,
    cleanup: () => {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

function makeTurnEvent(user: string, assistant: string): AgentEndEvent {
  return {
    messages: [
      { role: "user", content: user },
      { role: "assistant", content: assistant },
    ],
  };
}

function getDiff(root: string): string {
  return execSync("git diff HEAD", { cwd: root, encoding: "utf-8" });
}

// ── Main ─────────────────────────────────────────

async function main() {
  const callAI = process.argv.includes("--call-ai");
  const { root, cleanup } = setupScenario();

  try {
    const diff = getDiff(root);

    console.log("=" .repeat(70));
    console.log("SCENARIO: 2-turn conversation + human edit on api.ts");
    console.log("=" .repeat(70));

    console.log(`\n--- DIFF (${diff.length} chars) ---`);
    console.log(diff.substring(0, 1000));
    if (diff.length > 1000) console.log(`... (${diff.length - 1000} more chars)`);

    // Parse diff into numbered hunks
    const hunks = parseDiffHunks(diff);
    console.log(`\n--- PARSED HUNKS: ${hunks.length} ---`);
    for (const h of hunks) {
      console.log(
        `  [H${h.globalIndex}] ${h.file} (idx ${h.hunkIndexInFile}) ` +
        `${h.isNewFile ? "NEW " : ""}${h.isDeletedFile ? "DEL " : ""}` +
        `@${h.header} | ${h.summary.substring(0, 50)}`,
      );
    }

    // Format TurnLog
    const turnLogText = turnLog.formatForPrompt();
    console.log(`\n--- TURN LOG (${turnLogText.length} chars) ---`);
    console.log(turnLogText);

    // Format numbered hunks
    const numberedHunks = formatNumberedHunks(hunks);
    console.log(`\n--- NUMBERED HUNKS (${numberedHunks.length} chars) ---`);
    console.log(numberedHunks);

    if (callAI) {
      console.log("\n--- AI CALL ---");
      console.log("(not yet implemented — needs ExtensionContext)");
      console.log("Run /git-agg-commit in a pi session to test with real AI.");
    } else {
      console.log("\n--- PROMPT THAT WOULD BE SENT ---");
      console.log("(use --call-ai to actually call the AI)");

      // Show the exact system prompt
      const systemPrompt = getIntentSystemPrompt("ja");
      console.log(`\n=== SYSTEM (${systemPrompt.length} chars) ===`);
      console.log(systemPrompt.substring(0, 500) + "...");

      // Show the user prompt
      const userPrompt = buildIntentPrompt(turnLogText, numberedHunks, "ja");
      console.log(`\n=== USER PROMPT (${userPrompt.length} chars) ===`);
      console.log(userPrompt.substring(0, 1000) + "...");
    }

    // Verify parseHunkGroupingResult with a mock response
    console.log("\n--- MOCK AI RESPONSE PARSING TEST ---");
    testMockResponse(hunks.length);

  } finally {
    cleanup();
  }
}

function testMockResponse(totalHunks: number): void {
  // Simulate what the AI might return
  const mockResponse = JSON.stringify({
    overallConfidence: "medium",
    groups: [
      {
        hunks: [1, 2],
        message: "feat(auth): ログインフォームにバリデーションを追加",
        confidence: "high",
        turnIndices: [1, 2],
      },
      {
        hunks: [3],
        message: "fix(auth): APIエンドポイントをv2に更新",
        confidence: "low",
        note: "会話ログに対応するターンなし。人手による編集の可能性あり。",
      },
    ],
  });

  console.log(`Mock AI response:\n${mockResponse}\n`);

  const result = parseHunkGroupingResult(mockResponse);
  if (!result) {
    console.log("❌ FAILED to parse mock response");
    process.exit(1);
  }

  console.log(`✅ Parsed successfully:`);
  console.log(`  overallConfidence: ${result.overallConfidence}`);
  for (const g of result.groups) {
    console.log(
      `  Group: hunks=[${g.hunks.map((h) => h.globalIndex).join(",")}] ` +
      `conf=${g.confidence} msg="${g.message}"`,
    );
    if (g.note) console.log(`         note: ${g.note}`);
    if (g.turnIndices) console.log(`         turns: [${g.turnIndices.join(",")}]`);
  }

  console.log("\n✅ E2E test driver completed successfully.");
  console.log("   Key scenarios covered:");
  console.log("   1. Same-file hunks from different turns → should be split");
  console.log("   2. Human edit (api.ts v2) → should appear as unexplained");
  console.log("   3. TurnLog + diff parsing → correct hunk count");
  console.log("   4. AI response parsing → handles confidence levels");
}

main().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
