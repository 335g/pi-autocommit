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
  extractJsonObjectAt,
  parseCritOutput,
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

  void it("parses the final JSON object when crit prints multiple JSON lines", async () => {
    const notifications: Notification[] = [];
    const pi = createMockPi({
      critOutput:
        '{"event":"comment_added","id":"1"}\n' +
        '{"approved":true,"comments":[{"id":"1","body":"looks good","resolved":true}]}',
    });
    const ctx = createMockContext({ hasUI: true, notifications });
    const input = createReviewInput();

    const result = await runReviewFlow(pi, ctx, input);

    assert.deepStrictEqual(result, {});
  });

  void it("parses unresolved comments from the final JSON object", async () => {
    const notifications: Notification[] = [];
    const pi = createMockPi({
      critOutput:
        '{"event":"comment_added","id":"1"}\n' +
        '{"event":"comment_resolved","id":"1"}\n' +
        '{"approved":false,"comments":[{"id":"1","body":"fix this","resolved":false}]}',
    });
    const ctx = createMockContext({
      hasUI: true,
      selectResult:
        "Include comments in commit message context and continue",
      notifications,
    });
    const input = createReviewInput();

    const result = await runReviewFlow(pi, ctx, input);

    assert.strictEqual(result.reviewContext, "fix this");
  });

  void it("ignores startup text before the JSON payload", async () => {
    const notifications: Notification[] = [];
    const pi = createMockPi({
      critOutput:
        'Opening browser at http://localhost:51029\n' +
        'Waiting for review...\n' +
        '{"approved":true,"comments":[]}\n' +
        'Review complete.',
    });
    const ctx = createMockContext({ hasUI: true, notifications });
    const input = createReviewInput();

    const result = await runReviewFlow(pi, ctx, input);

    assert.deepStrictEqual(result, {});
  });
});

void describe("extractJsonObjectAt", () => {
  void it("extracts a simple object", () => {
    const text = '{"a":1}';
    const result = extractJsonObjectAt(text, 0);
    assert.deepStrictEqual(result?.value, { a: 1 });
    assert.strictEqual(result?.end, text.length);
  });

  void it("handles braces inside strings", () => {
    const text = '{"key":"value {with} braces"}';
    const result = extractJsonObjectAt(text, 0);
    assert.deepStrictEqual(result?.value, { key: "value {with} braces" });
  });

  void it("handles escaped quotes inside strings", () => {
    const text = '{"key":"value \\"with\\" quotes"}';
    const result = extractJsonObjectAt(text, 0);
    assert.deepStrictEqual(result?.value, { key: 'value "with" quotes' });
  });

  void it("handles escaped backslashes inside strings", () => {
    const text = '{"key":"C:\\\\path\\\\to\\\\file"}';
    const result = extractJsonObjectAt(text, 0);
    assert.deepStrictEqual(result?.value, { key: 'C:\\path\\to\\file' });
  });

  void it("handles nested objects", () => {
    const text = '{"outer":{"inner":{"deep":true}}}';
    const result = extractJsonObjectAt(text, 0);
    assert.deepStrictEqual(result?.value, { outer: { inner: { deep: true } } });
  });

  void it("handles arrays containing objects", () => {
    const text = '{"arr":[1,{"nested":true},3]}';
    const result = extractJsonObjectAt(text, 0);
    assert.deepStrictEqual(result?.value, { arr: [1, { nested: true }, 3] });
  });

  void it("returns null for an unclosed object", () => {
    const text = '{"a":1';
    const result = extractJsonObjectAt(text, 0);
    assert.strictEqual(result, null);
  });

  void it("returns null when start is not a brace", () => {
    const text = 'not json{"a":1}';
    const result = extractJsonObjectAt(text, 0);
    assert.strictEqual(result, null);
  });

  void it("extracts an object starting mid-string", () => {
    const text = 'prefix{"a":1}suffix';
    const result = extractJsonObjectAt(text, 6);
    assert.deepStrictEqual(result?.value, { a: 1 });
    assert.strictEqual(result?.end, 13);
  });

  void it("stops at the matching closing brace, not a nested one", () => {
    const text = '{"a":{"b":1}}';
    const result = extractJsonObjectAt(text, 0);
    assert.deepStrictEqual(result?.value, { a: { b: 1 } });
    assert.strictEqual(result?.end, text.length);
  });
});

void describe("parseCritOutput", () => {
  void it("parses a single JSON result", () => {
    const result = parseCritOutput(
      '{"approved":true,"comments":[{"id":"1","body":"ok","resolved":true}]}',
    );
    assert.strictEqual(result.approved, true);
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.comments[0].body, "ok");
  });

  void it("selects the last crit-like object from multiple JSON objects", () => {
    const result = parseCritOutput(
      '{"event":"comment_added","id":"1"}\n' +
        '{"approved":false,"comments":[{"id":"1","body":"fix","resolved":false}]}',
    );
    assert.strictEqual(result.approved, false);
    assert.strictEqual(result.comments[0].body, "fix");
  });

  void it("falls back to text when no JSON is present", () => {
    const result = parseCritOutput(
      "Review approved with no comments — no changes requested.",
    );
    assert.strictEqual(result.approved, true);
    assert.strictEqual(result.comments.length, 0);
    assert.ok(result.prompt?.includes("approved"));
  });

  void it("returns approved=false for plain text without approval wording", () => {
    const result = parseCritOutput("Some status message");
    assert.strictEqual(result.approved, false);
    assert.strictEqual(result.comments.length, 0);
  });

  void it("ignores malformed JSON and uses the next valid object", () => {
    const result = parseCritOutput(
      '{"a":1\n' +
        '{"approved":true,"comments":[]}'
    );
    assert.strictEqual(result.approved, true);
    assert.deepStrictEqual(result.comments, []);
  });

  void it("prefers final result over event object with approved boolean", () => {
    const result = parseCritOutput(
      '{"event":"comment_added","approved":true}\n' +
        '{"approved":false,"comments":[{"id":"1","body":"fix","resolved":false}]}',
    );
    assert.strictEqual(result.approved, false);
    assert.strictEqual(result.comments.length, 1);
    assert.strictEqual(result.comments[0].body, "fix");
  });

  void it("prefers final result over event object with prompt string", () => {
    const result = parseCritOutput(
      '{"event":"status","prompt":"in progress"}\n' +
        '{"approved":true,"comments":[]}',
    );
    assert.strictEqual(result.approved, true);
    assert.deepStrictEqual(result.comments, []);
  });

  void it("selects final result with empty comments array", () => {
    const result = parseCritOutput(
      '{"event":"comment_added","approved":true}\n' +
        '{"approved":true,"comments":[]}',
    );
    assert.strictEqual(result.approved, true);
    assert.deepStrictEqual(result.comments, []);
  });

  void it("falls back to last approved event object when no comments array exists", () => {
    const result = parseCritOutput(
      '{"event":"comment_added","approved":false}\n' +
        '{"event":"review_finished","approved":true}',
    );
    assert.strictEqual(result.approved, true);
    assert.deepStrictEqual(result.comments, []);
  });
});
