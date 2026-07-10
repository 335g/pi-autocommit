import assert from "node:assert";
import { describe, it } from "node:test";
import { parseCommitGroups } from "./commit-organizer.js";

void describe("parseCommitGroups", () => {
  void it("returns an empty array for empty input", () => {
    assert.deepStrictEqual(parseCommitGroups(""), []);
  });

  void it("parses a single commit group", () => {
    const input = `
=== COMMIT 1 ===
feat(auth): add JWT login

Implement login with JWT.
=== FILES ===
src/auth/login.ts
src/auth/types.ts
=== END ===
`.trim();

    assert.deepStrictEqual(parseCommitGroups(input), [
      {
        message: "feat(auth): add JWT login\n\nImplement login with JWT.",
        files: ["src/auth/login.ts", "src/auth/types.ts"],
      },
    ]);
  });

  void it("parses multiple commit groups", () => {
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

    assert.deepStrictEqual(parseCommitGroups(input), [
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

  void it("ignores blocks without a files section", () => {
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

    assert.deepStrictEqual(parseCommitGroups(input), [
      {
        message: "feat(auth): add JWT login",
        files: ["src/auth/login.ts"],
      },
    ]);
  });

  void it("ignores empty file lines and comments", () => {
    const input = `
=== COMMIT 1 ===
chore(deps): update lockfile
=== FILES ===

# this is a comment
package-lock.json

=== END ===
`.trim();

    assert.deepStrictEqual(parseCommitGroups(input), [
      {
        message: "chore(deps): update lockfile",
        files: ["package-lock.json"],
      },
    ]);
  });
});
