import assert from "node:assert";
import { describe, it } from "node:test";
import type { PiAutocommitConfig } from "./config.js";
import {
  completeCommitGroups,
  type CompleteFn,
} from "./commit-prompt.js";

/** Minimal model stub for fake adapters. */
const stubModel = { id: "test-model" } as unknown as Parameters<CompleteFn>[0];

function fakeCompleteReturning(text: string): CompleteFn {
  return async () =>
    ({
      role: "assistant",
      content: [{ type: "text", text }],
    }) as never;
}

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
  return { lang: "en", enable: true, ...over };
}

void describe("completeCommitGroups parsing", () => {
  void it("returns an empty array when the LLM returns empty groups", async () => {
    const complete = fakeCompleteReturning("");
    await assert.rejects(
      completeCommitGroups(
        makeCtx(stubModel),
        config(),
        { diff: "diff", reasoning: "" },
        complete,
      ),
      /Empty reorganiser response/,
    );
  });

  void it("parses a single commit group", async () => {
    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login

Implement login with JWT.
=== FILES ===
src/auth/login.ts
src/auth/types.ts
=== END ===
`.trim();
    const complete = fakeCompleteReturning(input);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      config(),
      { diff: "diff", reasoning: "" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat(auth): add JWT login\n\nImplement login with JWT.",
        files: ["src/auth/login.ts", "src/auth/types.ts"],
      },
    ]);
  });

  void it("parses multiple commit groups", async () => {
    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login

Implement login.
=== FILES ===
src/auth/login.ts
=== END ===
=== COMMIT 2 ===
refactor(db): extract query builder

Move query logic.
=== FILES ===
src/db/query.ts
=== END ===
`.trim();
    const complete = fakeCompleteReturning(input);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      config(),
      { diff: "diff", reasoning: "" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat(auth): add JWT login\n\nImplement login.",
        files: ["src/auth/login.ts"],
      },
      {
        message: "refactor(db): extract query builder\n\nMove query logic.",
        files: ["src/db/query.ts"],
      },
    ]);
  });

  void it("ignores blocks without a files section", async () => {
    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login
=== FILES ===
src/auth/login.ts
=== END ===
=== COMMIT 2 ===
invalid commit without files
=== END ===
`.trim();
    const complete = fakeCompleteReturning(input);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      config(),
      { diff: "diff", reasoning: "" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "feat(auth): add JWT login",
        files: ["src/auth/login.ts"],
      },
    ]);
  });

  void it("ignores empty file lines and comments", async () => {
    const input = `
=== COMMIT 1 ===
chore(deps): update lockfile
=== FILES ===

# this is a comment
package-lock.json

=== END ===
`.trim();
    const complete = fakeCompleteReturning(input);

    const groups = await completeCommitGroups(
      makeCtx(stubModel),
      config(),
      { diff: "diff", reasoning: "" },
      complete,
    );

    assert.deepStrictEqual(groups, [
      {
        message: "chore(deps): update lockfile",
        files: ["package-lock.json"],
      },
    ]);
  });
});