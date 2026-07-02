import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExecResult,
} from "@earendil-works/pi-coding-agent";
import {
  runReviewFlow,
  ReviewSendToAgentError,
  ReviewCancelledError,
} from "./reviewer.js";
import type { FileDetail } from "./file-selector.js";

interface MockPiOptions {
  critOutput?: string;
  onExec?: (cmd: string, args: string[]) => void;
}

function createMockPi(options: MockPiOptions = {}): ExtensionAPI {
  return {
    exec: async (cmd: string, args?: string[]): Promise<ExecResult> => {
      options.onExec?.(cmd, args ?? []);
      if (cmd === "crit" && options.critOutput !== undefined) {
        return {
          stdout: options.critOutput,
          stderr: "",
          code: 0,
          killed: false,
        };
      }
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  } as ExtensionAPI;
}

interface Notification {
  message: string;
  level: string;
}

interface MockContextOptions {
  hasUI: boolean;
  selectResult?: string;
  notifications: Notification[];
}

function createMockContext(options: MockContextOptions): ExtensionContext {
  return {
    hasUI: options.hasUI,
    ui: {
      notify: (message: string, level: string) => {
        options.notifications.push({ message, level });
      },
      select: async (_prompt: string, _choices: string[]) => {
        return options.selectResult ?? "";
      },
    },
  } as ExtensionContext;
}

function createReviewInput(
  overrides?: Partial<{
    selectedFiles: string[];
    fileDetails: Map<string, FileDetail>;
    stagedDiff: string;
  }>,
) {
  return {
    selectedFiles: ["src/foo.ts"],
    fileDetails: new Map([
      [
        "src/foo.ts",
        { diff: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 },
      ],
    ]),
    stagedDiff: "@@ -1 +1 @@\n-old\n+new",
    ...overrides,
  };
}

function critResult(options: {
  approved: boolean;
  comments: Array<{
    id: string;
    body: string;
    resolved: boolean;
    file?: string;
    quote?: string;
  }>;
  prompt?: string;
}): string {
  return JSON.stringify({
    approved: options.approved,
    comments: options.comments,
    prompt: options.prompt,
  });
}

void describe("runReviewFlow", () => {
  void it("returns empty result when there are no comments", async () => {
    const notifications: Notification[] = [];
    const pi = createMockPi({
      critOutput: critResult({ approved: true, comments: [] }),
    });
    const ctx = createMockContext({ hasUI: true, notifications });
    const input = createReviewInput();

    const result = await runReviewFlow(pi, ctx, input);

    assert.deepStrictEqual(result, {});
    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].level, "info");
    assert.ok(
      notifications[0].message.includes(
        "Opening crit review in your browser",
      ),
    );
  });

  void it("returns empty result when all comments are resolved", async () => {
    const notifications: Notification[] = [];
    const pi = createMockPi({
      critOutput: critResult({
        approved: true,
        comments: [{ id: "1", body: "looks good", resolved: true }],
      }),
    });
    const ctx = createMockContext({ hasUI: true, notifications });
    const input = createReviewInput();

    const result = await runReviewFlow(pi, ctx, input);

    assert.deepStrictEqual(result, {});
    assert.strictEqual(notifications.length, 1);
  });

  void it("returns reviewContext when user chooses to include comments", async () => {
    const notifications: Notification[] = [];
    const pi = createMockPi({
      critOutput: critResult({
        approved: false,
        comments: [{ id: "1", body: "fix typo", resolved: false }],
      }),
    });
    const ctx = createMockContext({
      hasUI: true,
      selectResult:
        "Include comments in commit message context and continue",
      notifications,
    });
    const input = createReviewInput();

    const result = await runReviewFlow(pi, ctx, input);

    assert.strictEqual(result.reviewContext, "fix typo");
    assert.strictEqual(notifications.length, 2);
    assert.strictEqual(notifications[1].level, "warning");
    assert.ok(notifications[1].message.includes("Unresolved review comments"));
  });

  void it("throws ReviewSendToAgentError when user chooses fix", async () => {
    const notifications: Notification[] = [];
    const pi = createMockPi({
      critOutput: critResult({
        approved: false,
        comments: [{ id: "1", body: "fix typo", resolved: false }],
      }),
    });
    const ctx = createMockContext({
      hasUI: true,
      selectResult:
        "Fix based on comments — unstages and sends to LLM for fixing",
      notifications,
    });
    const input = createReviewInput();

    await assert.rejects(
      async () => runReviewFlow(pi, ctx, input),
      (error) => {
        assert.ok(error instanceof ReviewSendToAgentError);
        assert.strictEqual(error.name, "ReviewSendToAgentError");
        assert.ok(error.reviewComments.includes("fix typo"));
        return true;
      },
    );
    assert.strictEqual(notifications.length, 2);
  });

  void it("throws ReviewCancelledError when user chooses cancel", async () => {
    const notifications: Notification[] = [];
    const pi = createMockPi({
      critOutput: critResult({
        approved: false,
        comments: [{ id: "1", body: "fix typo", resolved: false }],
      }),
    });
    const ctx = createMockContext({
      hasUI: true,
      selectResult: "Cancel — abort, fix issues manually, then re-run",
      notifications,
    });
    const input = createReviewInput();

    await assert.rejects(
      async () => runReviewFlow(pi, ctx, input),
      (error) => {
        assert.ok(error instanceof ReviewCancelledError);
        assert.strictEqual(error.name, "ReviewCancelledError");
        assert.ok(error.message.includes("Review cancelled by user"));
        return true;
      },
    );
    assert.strictEqual(notifications.length, 2);
  });

  void it("auto-includes reviewContext in non-TUI mode", async () => {
    const notifications: Notification[] = [];
    const pi = createMockPi({
      critOutput: critResult({
        approved: false,
        comments: [
          {
            id: "1",
            body: "fix typo",
            resolved: false,
            file: "src/foo.ts",
            quote: "old",
          },
        ],
      }),
    });
    const ctx = createMockContext({ hasUI: false, notifications });
    const input = createReviewInput();

    const result = await runReviewFlow(pi, ctx, input);

    assert.strictEqual(
      result.reviewContext,
      'src/foo.ts: "old": fix typo',
    );
    assert.strictEqual(notifications.length, 2);
  });

  void it("includes reviewer prompt in send-to-agent error", async () => {
    const notifications: Notification[] = [];
    const pi = createMockPi({
      critOutput: critResult({
        approved: false,
        comments: [{ id: "1", body: "fix typo", resolved: false }],
        prompt: "Please refactor this carefully.",
      }),
    });
    const ctx = createMockContext({
      hasUI: true,
      selectResult:
        "Fix based on comments — unstages and sends to LLM for fixing",
      notifications,
    });
    const input = createReviewInput();

    await assert.rejects(
      async () => runReviewFlow(pi, ctx, input),
      (error) => {
        assert.ok(error instanceof ReviewSendToAgentError);
        const comments = error.reviewComments;
        assert.ok(comments.includes("Please refactor this carefully."));
        assert.ok(comments.includes("fix typo"));
        return true;
      },
    );
  });

  void it("builds review document with per-file stats", async () => {
    let document = "";
    const pi = createMockPi({
      critOutput: critResult({ approved: true, comments: [] }),
      onExec: (cmd, args) => {
        if (cmd === "crit") {
          const reviewPath = args[0] ?? "";
          document = readFileSync(reviewPath, "utf-8");
        }
      },
    });
    const ctx = createMockContext({ hasUI: true, notifications: [] });
    const input = createReviewInput();

    await runReviewFlow(pi, ctx, input);

    assert.ok(document.includes("src/foo.ts"));
    assert.ok(document.includes("+1"));
    assert.ok(document.includes("-1"));
  });

  void it("joins multiple unresolved comments with newlines", async () => {
    const notifications: Notification[] = [];
    const pi = createMockPi({
      critOutput: critResult({
        approved: false,
        comments: [
          { id: "1", body: "first issue", resolved: false },
          { id: "2", body: "second issue", resolved: false },
        ],
      }),
    });
    const ctx = createMockContext({
      hasUI: true,
      selectResult:
        "Include comments in commit message context and continue",
      notifications,
    });
    const input = createReviewInput();

    const result = await runReviewFlow(pi, ctx, input);

    assert.strictEqual(
      result.reviewContext,
      "first issue\nsecond issue",
    );
  });

  void it("formats comment location without quote", async () => {
    const notifications: Notification[] = [];
    const pi = createMockPi({
      critOutput: critResult({
        approved: false,
        comments: [
          {
            id: "1",
            body: "fix typo",
            resolved: false,
            file: "src/foo.ts",
          },
        ],
      }),
    });
    const ctx = createMockContext({
      hasUI: true,
      selectResult:
        "Include comments in commit message context and continue",
      notifications,
    });
    const input = createReviewInput();

    const result = await runReviewFlow(pi, ctx, input);

    assert.strictEqual(result.reviewContext, "src/foo.ts: fix typo");
  });

  void it("works when fileDetails is undefined", async () => {
    let document = "";
    const pi = createMockPi({
      critOutput: critResult({ approved: true, comments: [] }),
      onExec: (cmd, args) => {
        if (cmd === "crit") {
          const reviewPath = args[0] ?? "";
          document = readFileSync(reviewPath, "utf-8");
        }
      },
    });
    const ctx = createMockContext({ hasUI: true, notifications: [] });
    const input = createReviewInput({ fileDetails: undefined });

    const result = await runReviewFlow(pi, ctx, input);

    assert.deepStrictEqual(result, {});
    assert.ok(document.includes("Total: 0 files"));
    assert.ok(!document.includes("| +1 |"));
  });
});
