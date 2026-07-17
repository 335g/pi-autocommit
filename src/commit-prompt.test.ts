import assert from "node:assert";
import { describe, it } from "node:test";
import type { PiAutocommitConfig } from "./config.js";
import {
  completeCommitGroups,
  completeSingleMessage,
  extractAssistantContext,
  type CompleteFn,
} from "./commit-prompt.js";

// ── Test helpers ─────────────────────────────────────────

/** Minimal model stub for fake adapters — only `id` matters in the core. */
const stubModel = { id: "test-model" } as unknown as Parameters<
  CompleteFn
>[0];

/** Build a fake CompleteFn returning the given text from its first content block. */
function fakeCompleteReturning(text: string): CompleteFn {
  return async () =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
    }) as never;
}

/** Minimal ctx stub: only `model` and `modelRegistry` touched by resolveModel. */
function makeCtx(model: unknown) {
  return {
    model,
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    },
  } as never;
}

function config(over: Partial<PiAutocommitConfig> = {}): PiAutocommitConfig {
  return {
    lang: "en",
    enable: true,
    commitPickerMaxCommits: 30,
    deferReorganise: false,
    ...over,
  };
}

void describe("extractAssistantContext", () => {
  void it("returns empty string when no assistant messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];
    assert.strictEqual(extractAssistantContext(messages), "");
  });

  void it("extracts text from a single assistant message", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "I will fix the bug." }],
      },
    ];
    assert.strictEqual(
      extractAssistantContext(messages),
      "I will fix the bug.",
    );
  });

  void it("joins multiple assistant messages with --- separator", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "fix it" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "First I'll add a test." }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Then I'll fix the code." }],
      },
    ];
    assert.strictEqual(
      extractAssistantContext(messages),
      "First I'll add a test.\n\n---\n\nThen I'll fix the code.",
    );
  });

  void it("skips non-text content blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", text: "ignored" },
          { type: "text", text: "kept" },
          { type: "text" }, // empty text dropped
        ],
      },
    ];
    assert.strictEqual(extractAssistantContext(messages), "kept");
  });
});

void describe("completeSingleMessage", () => {
  void it("returns the cleaned LLM message with injected scope (mapping present)", async () => {
    const cfg = config({ scope: { "packages/frontend/**": "frontend" } });
    const complete = fakeCompleteReturning(
      "```\nfeat: add login\n\nImplement JWT login.\n```",
    );

    const message = await completeSingleMessage(
      makeCtx(stubModel),
      cfg,
      {
        diff: "--- a/packages/frontend/login.ts\n+++ b/packages/frontend/login.ts\n",
        nameStatus: "A\tpackages/frontend/login.ts\n",
        stat: "1 file changed",
      },
      complete,
    );

    assert.strictEqual(
      message,
      "feat(frontend): add login\n\nImplement JWT login.",
    );
  });

  void it("falls back to the heuristic when the LLM returns empty text", async () => {
    const cfg = config();
    const complete = fakeCompleteReturning("");

    const message = await completeSingleMessage(
      makeCtx(stubModel),
      cfg,
      {
        diff: "--- a/src/a.ts\n+++ b/src/a.ts\n",
        nameStatus: "A\tsrc/a.ts\n",
        stat: "1 file changed",
      },
      complete,
    );

    // Heuristic: new file → `feat`, top-level dir → scope `src`.
    assert.match(message, /^feat\(src\): add new functionality/);
    assert.match(message, /src\/a\.ts/);
  });

  void it("falls back to the heuristic when the LLM adapter throws", async () => {
    const cfg = config();
    const complete: CompleteFn = async () => {
      throw new Error("LLM unreachable");
    };

    const message = await completeSingleMessage(
      makeCtx(stubModel),
      cfg,
      {
        diff: "--- a/docs/x.md\n+++ b/docs/x.md\n",
        nameStatus: "M\tdocs/x.md\n",
        stat: "1 file changed",
      },
      complete,
    );

    // Docs-only diff → `docs` type, scope `docs`.
    assert.match(message, /^docs\(docs\): update documentation/);
  });
});

void describe("completeCommitGroups", () => {
  void it("parses the LLM response into groups with injected scope (mapping present)", async () => {
    const cfg = config({ scope: { "packages/frontend/**": "frontend", "packages/backend/**": "backend" } });
    const llmText = [
      "=== COMMIT 1 ===",
      "feat: add login",
      "",
      "Implement login.",
      "=== FILES ===",
      "packages/frontend/auth.ts",
      "=== END ===",
      "=== COMMIT 2 ===",
      "fix(db): escape input",
      "",
      "Prevent injection.",
      "=== FILES ===",
      "packages/backend/query.ts",
      "=== END ===",
    ].join("\n");
    const complete = fakeCompleteReturning(llmText);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      cfg,
      {
        diff: "staged diff here",
        reasoning: "I will split login and db fix.",
      },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat(frontend): add login\n\nImplement login.",
        files: ["packages/frontend/auth.ts"],
      },
      {
        message: "fix(backend): escape input\n\nPrevent injection.",
        files: ["packages/backend/query.ts"],
      },
    ]);
  });

  void it("throws when the LLM returns empty text", async () => {
    const cfg = config();
    const complete = fakeCompleteReturning("");

    await assert.rejects(
      completeCommitGroups(
        makeCtx(stubModel),
        cfg,
        { diff: "diff", reasoning: "reasoning" },
        complete,
      ),
      /Empty reorganiser response/,
    );
  });

  void it("throws when the LLM response has no parseable groups", async () => {
    const cfg = config();
    const complete = fakeCompleteReturning("sorry, I cannot help with that.");

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      cfg,
      { diff: "diff", reasoning: "reasoning" },
      complete,
    );

    // Parseable returns empty groups (not throw) — throw only on empty raw text.
    assert.deepStrictEqual(groups, []);
  });

  void it("throws when no model is available", async () => {
    const cfg = config();
    const complete = fakeCompleteReturning("feat: x");

    await assert.rejects(
      completeCommitGroups(
        makeCtx(undefined),
        cfg,
        { diff: "diff", reasoning: "reasoning" },
        complete,
      ),
      /No model available/,
    );
  });

  void it("strips markdown fences from the LLM response before parsing groups", async () => {
    const cfg = config();
    const llmText = [
      "```",
      "=== COMMIT 1 ===",
      "feat: add login",
      "",
      "Implement login.",
      "=== FILES ===",
      "src/auth.ts",
      "=== END ===",
      "```",
    ].join("\n");
    const complete = fakeCompleteReturning(llmText);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      cfg,
      { diff: "diff", reasoning: "reasoning" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat: add login\n\nImplement login.",
        files: ["src/auth.ts"],
      },
    ]);
  });

  void it("works with Japanese config and Japanese LLM responses", async () => {
    const cfg = config({ lang: "ja" });
    const llmText = [
      "=== COMMIT 1 ===",
      "feat: ログインを追加",
      "",
      "ログイン機能を実装。",
      "=== FILES ===",
      "src/auth.ts",
      "=== END ===",
    ].join("\n");
    const complete = fakeCompleteReturning(llmText);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      cfg,
      { diff: "diff", reasoning: "reasoning" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat: ログインを追加\n\nログイン機能を実装。",
        files: ["src/auth.ts"],
      },
    ]);
  });
});

void describe("ADR-0003 scope injection", () => {
  void it("single path strips an LLM-emitted scope before injecting the deterministic one", async () => {
    const cfg = config({ scope: { "packages/frontend/**": "frontend" } });
    // LLM ignored the “no scope” instruction and emitted `feat(auth)`.
    const complete = fakeCompleteReturning("feat(auth): add login\n\nBody.");

    const message = await completeSingleMessage(
      makeCtx(stubModel),
      cfg,
      {
        diff: "diff",
        nameStatus: "A\tpackages/frontend/login.ts\n",
        stat: "1 file changed",
      },
      complete,
    );

    assert.strictEqual(message, "feat(frontend): add login\n\nBody.");
  });

  void it("groups path strips an LLM-emitted scope before injecting the deterministic one", async () => {
    const cfg = config({ scope: { "packages/frontend/**": "frontend" } });
    const llmText = [
      "=== COMMIT 1 ===",
      "feat(auth): add login",
      "=== FILES ===",
      "packages/frontend/auth.ts",
      "=== END ===",
    ].join("\n");
    const complete = fakeCompleteReturning(llmText);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      cfg,
      { diff: "diff", reasoning: "reasoning" },
      complete,
    );

    assert.strictEqual(
      groups[0]?.message,
      "feat(frontend): add login",
    );
  });

  void it("no mapping: leaves the LLM-emitted scope untouched (single path)", async () => {
    const cfg = config();
    const complete = fakeCompleteReturning("feat(auth): add login\n\nBody.");

    const message = await completeSingleMessage(
      makeCtx(stubModel),
      cfg,
      {
        diff: "diff",
        nameStatus: "A\tsrc/auth/login.ts\n",
        stat: "1 file changed",
      },
      complete,
    );

    assert.strictEqual(message, "feat(auth): add login\n\nBody.");
  });
});