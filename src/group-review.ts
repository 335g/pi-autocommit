import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommitGroup } from "./commit-prompt.js";

/** How many files of one group the preview lists before summarising. */
const MAX_PREVIEW_FILES = 8;

/**
 * Render one proposed group for a dialog: the message, then its files.
 * Long file lists are cut with a "+N more" summary so the dialog stays
 * readable.
 */
export function formatGroupPreview(group: CommitGroup): string {
  const shown = group.files.slice(0, MAX_PREVIEW_FILES);
  const rest = group.files.length - shown.length;
  const files = shown.map((file) => `  ${file}`).join("\n");
  const suffix = rest > 0 ? `\n  …他 ${rest} ファイル` : "";
  return `${group.message}\n\n${files}${suffix}`;
}

/**
 * Walk the proposed groups with the user before anything is committed.
 *
 * Each group is offered as a confirm dialog; rejecting it opens pi's
 * multi-line editor prefilled with the proposed message, so the message can be
 * rewritten instead of accepted. Cancelling the editor aborts the whole
 * review: no commit is made and the caller leaves the changes staged.
 *
 * The file partition is never touched — only messages change — so the
 * coverage guard in `commitGroups` still holds.
 *
 * @returns the (possibly edited) groups, or `null` when the user aborted.
 */
export async function reviewCommitGroups(
  ctx: ExtensionContext,
  groups: CommitGroup[],
): Promise<CommitGroup[] | null> {
  // Dialogs need a UI; headless runs commit the proposal as-is.
  if (ctx.mode !== "tui" || groups.length === 0) {
    return groups;
  }

  // The caller may be showing the "Reorganising…" working indicator, which
  // would otherwise sit behind the dialogs.
  ctx.ui.setWorkingVisible(false);
  try {
    const reviewed: CommitGroup[] = [];
    for (const [index, group] of groups.entries()) {
      const title = `pi-autocommit: コミット ${index + 1}/${groups.length} を作成しますか？`;
      const ok = await ctx.ui.confirm(title, formatGroupPreview(group));
      if (ok) {
        reviewed.push(group);
        continue;
      }

      const message = await ctx.ui.editor(
        "コミットメッセージを編集（空でキャンセル → 整理を中止）",
        group.message,
      );
      if (message === undefined || message.trim().length === 0) {
        return null;
      }
      reviewed.push({ ...group, message: message.trim() });
    }
    return reviewed;
  } finally {
    ctx.ui.setWorkingVisible(true);
  }
}
