import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCheckpointMessage } from "./pipeline.js";

describe("buildCheckpointMessage", () => {
  const msg = "wip(checkpoint): auto-commit at turn 3";

  it("returns the plain message when nothing is available", () => {
    assert.equal(buildCheckpointMessage(msg), msg);
  });

  it("appends only the session trailer when no branch is available", () => {
    assert.equal(
      buildCheckpointMessage(msg, "session-abc"),
      `${msg}\n\nCheckpoint-Session: session-abc`,
    );
  });

  it("appends session and branch trailers together", () => {
    assert.equal(
      buildCheckpointMessage(msg, "session-abc", "wt/task1"),
      `${msg}\n\nCheckpoint-Session: session-abc\nCheckpoint-Branch: wt/task1`,
    );
  });

  it("appends only the branch trailer when no session is available", () => {
    assert.equal(
      buildCheckpointMessage(msg, undefined, "wt/task1"),
      `${msg}\n\nCheckpoint-Branch: wt/task1`,
    );
  });

  it("skips empty branch and empty session", () => {
    assert.equal(buildCheckpointMessage(msg, "session-abc", ""), `${msg}\n\nCheckpoint-Session: session-abc`);
    assert.equal(buildCheckpointMessage(msg, "", "wt/task1"), `${msg}\n\nCheckpoint-Branch: wt/task1`);
  });
});
