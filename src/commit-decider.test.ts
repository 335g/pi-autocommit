import { describe, it } from "node:test";
import assert from "node:assert";
import { shouldCreateWipCommit } from "./commit-decider.js";

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

void describe("shouldCreateWipCommit", () => {
  void it("returns false for empty tool results", () => {
    assert.strictEqual(shouldCreateWipCommit([]), false);
  });

  void it("returns false for read-only tools", () => {
    assert.strictEqual(
      shouldCreateWipCommit([
        makeToolResult("read"),
        makeToolResult("grep"),
        makeToolResult("find"),
        makeToolResult("ls"),
      ]),
      false,
    );
  });

  void it("returns true for write tool", () => {
    assert.strictEqual(
      shouldCreateWipCommit([makeToolResult("write")]),
      true,
    );
  });

  void it("returns true for edit tool", () => {
    assert.strictEqual(
      shouldCreateWipCommit([makeToolResult("edit")]),
      true,
    );
  });

  void it("returns true for bash tool", () => {
    assert.strictEqual(
      shouldCreateWipCommit([makeToolResult("bash")]),
      true,
    );
  });

  void it("returns true when any tool is potentially mutating", () => {
    assert.strictEqual(
      shouldCreateWipCommit([
        makeToolResult("read"),
        makeToolResult("edit"),
        makeToolResult("grep"),
      ]),
      true,
    );
  });
});
