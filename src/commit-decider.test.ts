import assert from "node:assert";
import { describe, it } from "node:test";
import { shouldCreateCheckpointCommit } from "./commit-decider.js";

function makeToolResult(toolName: string) {
  return {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName,
    content: [{ type: "text" as const, text: "ok" }],
    isError: false,
    timestamp: Date.now(),
  };
}

void describe("shouldCreateCheckpointCommit", () => {
  void it("returns false for empty tool results", () => {
    assert.strictEqual(shouldCreateCheckpointCommit([]), false);
  });

  void it("returns false for read-only tools", () => {
    assert.strictEqual(
      shouldCreateCheckpointCommit([
        makeToolResult("read"),
        makeToolResult("grep"),
        makeToolResult("find"),
        makeToolResult("ls"),
      ]),
      false,
    );
  });

  void it("returns true for write tool", () => {
    assert.strictEqual(shouldCreateCheckpointCommit([makeToolResult("write")]), true);
  });

  void it("returns true for edit tool", () => {
    assert.strictEqual(shouldCreateCheckpointCommit([makeToolResult("edit")]), true);
  });

  void it("returns true for bash tool", () => {
    assert.strictEqual(shouldCreateCheckpointCommit([makeToolResult("bash")]), true);
  });

  void it("returns true when any tool is potentially mutating", () => {
    assert.strictEqual(
      shouldCreateCheckpointCommit([
        makeToolResult("read"),
        makeToolResult("edit"),
        makeToolResult("grep"),
      ]),
      true,
    );
  });
});
