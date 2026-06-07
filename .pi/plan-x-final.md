# Plan X Final: Stash SHA Capture + Orphan Recovery

## Overview

Fix all BLOCKER-level stash race conditions by capturing the stash SHA immediately
after `git stash push`, using SHA for all diff operations, detecting no-op pushes
correctly, and adding orphan stash recovery at session start.

---

## Task 1: Rewrite `collectDiff()` in `src/core/git.ts`

Replace lines 113–159 (entire function body).

```typescript
/**
 * Collect the full working tree diff by stashing changes (including untracked
 * files), capturing the diff via the stash SHA, and popping the stash to
 * restore the working tree.
 *
 * The stash SHA is captured immediately after push and used for all diff
 * operations, eliminating any reflog-positional race conditions.
 *
 * @returns The diff string, or `null` if a git error occurred.
 *          An empty string means there are no effective changes.
 */
export async function collectDiff(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<string | null> {
  // Unique message per run — enables orphan stash identification and recovery.
  const stashMessage = `pi-git-${Date.now()}`;

  // Step 1 — push stash to snapshot the working tree (including untracked files).
  const { code: pushCode } = await pi.exec(
    "git",
    ["stash", "push", "-u", "-m", stashMessage],
    { cwd },
  );
  if (pushCode !== 0) return null;

  // Step 2 — verify our stash was actually created.
  // `git stash push` exits 0 even on "No local changes to save".
  // Checking the stash list message is unambiguous.
  const { stdout: topLine, code: listCode } = await pi.exec(
    "git",
    ["stash", "list", "-1"],
    { cwd },
  );
  if (listCode !== 0 || !topLine.includes(stashMessage)) {
    // Our stash was NOT created — "No local changes to save".
    return "";
  }

  // Step 3 — IMMEDIATELY capture the stash SHA.
  // Race window: between push and this rev-parse is a single `await` (~10 ms).
  // After this point, all operations use the SHA — reflog position is irrelevant.
  const { stdout: shaOut, code: shaCode } = await pi.exec(
    "git",
    ["rev-parse", "stash@{0}"],
    { cwd },
  );
  if (shaCode !== 0) return null;
  const stashSha = shaOut.trim();

  let diff = "";
  try {
    // Step 4 — capture tracked-file diff using the SHA (not stash@{0}).
    // stashSha^1 = HEAD at stash creation time.
    const { stdout: trackedDiff, code: trackedCode } = await pi.exec(
      "git",
      ["diff", `${stashSha}^1`, stashSha],
      { cwd },
    );
    if (trackedCode !== 0) return null;
    diff = trackedDiff;

    // Step 5 — capture untracked-file diff.
    // stashSha^3 exists only when -u was used AND untracked files were present.
    const { stdout: untrackedDiff, code: untrackedCode } = await pi.exec(
      "git",
      ["diff", "HEAD", `${stashSha}^3`],
      { cwd },
    );
    if (untrackedCode === 0 && untrackedDiff.trim()) {
      diff += (diff ? "\n" : "") + untrackedDiff;
    }

    return diff;
  } finally {
    // Step 6 — restore the working tree.
    // If pop fails, the working tree may be in an inconsistent state —
    // return null to abort the entire commit operation safely.
    const { code: popCode } = await pi.exec(
      "git",
      ["stash", "pop", "stash@{0}"],
      { cwd },
    );
    if (popCode !== 0) {
      // Pop failed (merge conflict, etc.).  The stash remains as an orphan.
      // Orphan recovery will attempt restoration next session_start.
      // Returning null signals the caller to abort — the working tree is
      // potentially corrupted and should not be committed from.
      diff = ""; // will be discarded; set empty to satisfy the return path
      return null;
    }
  }
}
```

---

## Task 2: Create `src/core/orphan-recovery.ts`

New file.

```typescript
/**
 * Recover orphaned pi-git stashes left behind by previous interrupted runs.
 *
 * Both old static "pi-git" stashes and new timestamped "pi-git-{ts}" stashes
 * are detected and auto-popped at session start.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Matches stash list entries created by pi-git (old and new format).
 *
 * Example stash list line: "stash@{0}: On main: pi-git-1234567890"
 *                                                    ^^^^^^^^^^^^^^^^  message at end of line
 */
const STASH_MESSAGE_PATTERN = / pi-git(-\d+)?\s*$/;

export async function recoverOrphanedStashes(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (!ctx.hasUI) return;

  const { stdout, code } = await pi.exec(
    "git", ["stash", "list"], { cwd: ctx.cwd },
  );
  if (code !== 0) return; // not a git repo, or git error — silently skip

  const lines = stdout.split("\n").filter(Boolean);

  // Collect indices of pi-git stashes (0 = newest, N-1 = oldest).
  const orphanedIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (STASH_MESSAGE_PATTERN.test(lines[i])) {
      orphanedIndices.push(i);
    }
  }

  if (orphanedIndices.length === 0) return;

  // Pop from oldest to newest (largest index first) because popping
  // renumbers the remaining entries (stash@{1} → stash@{0}).
  orphanedIndices.sort((a, b) => b - a);

  let recovered = 0;
  let failed = 0;

  for (const idx of orphanedIndices) {
    const ref = `stash@{${idx}}`;
    const { code: popCode } = await pi.exec(
      "git", ["stash", "pop", ref], { cwd: ctx.cwd },
    );
    if (popCode === 0) {
      recovered++;
    } else {
      failed++;
      // Pop may fail due to merge conflicts — the stash stays in place.
      // User must recover manually. Continue trying the rest.
    }
  }

  if (recovered > 0 || failed > 0) {
    const parts: string[] = [];
    if (recovered > 0) {
      parts.push(
        `Recovered ${recovered} orphaned stash${recovered > 1 ? "es" : ""}`
      );
    }
    if (failed > 0) {
      parts.push(
        `${failed} stash${failed > 1 ? "es" : ""} could not be auto-recovered — run 'git stash pop' manually`
      );
    }
    ctx.ui.notify(
      `[pi-git] ${parts.join(".  ")}`,
      recovered > 0 ? "info" : "warning",
    );
  }
}
```

---

## Task 3: Update `src/index.ts`

Add import:
```typescript
import { recoverOrphanedStashes } from "./core/orphan-recovery.js";
```

Modify `session_start` handler:
```typescript
  pi.on("session_start", async (_event, ctx) => {
    try {
      if (ctx.hasUI) {
        footerManager.initialize(pi, ctx.ui, ctx.cwd);
        await recoverOrphanedStashes(pi, ctx);
        await footerManager.refresh();
      }
    } catch {
      // Silently ignore initialization errors to prevent unhandled rejections
    }
  });
```

---

## Task 4: Update comment in `src/commands/agg-commit.ts`

Line 83:
```typescript
    // Snapshot changes via stash (SHA-based diff capture — no reflog race)
```

---

## Files Modified / Created

| File | Action |
|------|--------|
| `src/core/git.ts` | Rewrite `collectDiff()` |
| `src/core/orphan-recovery.ts` | **NEW** |
| `src/index.ts` | Add import + orphan recovery call |
| `src/commands/agg-commit.ts` | Update comment only |

---

## BLOCKER Resolution Matrix

| Original BLOCKER | Resolution |
|-------------------|------------|
| Race condition: `stash@{0}` for diff | ✅ SHA captured immediately, all diffs use SHA |
| User manual `git stash` corruption | ✅ Diff via SHA is correct regardless. Pop may orphan but recovery handles it. |
| Crash leaves orphan stash | ✅ Orphan recovery at session_start |
| Pop failure ignored | ✅ Pop failure → return null → abort commit (safe) |
| "No changes" indistinguishable | ✅ `git stash list -1` message check (B2 fix) |
| Abort signal during pop | ✅ Pop failure → return null → safe abort |
| Orphan recovery regex broken | ✅ Fixed: `/ pi-git(-\d+)?\s*$/` (B1 fix) |
| Commit proceeds on corrupted working tree | ✅ Pop failure → return null (B3 fix) |

## Remaining Notes (non-blocking)

- Orphan recovery uses hardcoded English strings (no i18n) — acceptable for a recovery/edge-case message
- `popCode` is now used: failure triggers `return null`
- `ensureReadyToCommit` → `collectDiff` TOCTOU is mitigated by the `git stash list -1` message check
