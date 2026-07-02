import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Result of the commit message confirmation loop.
 *
 * - `commit`: proceed with the original message
 * - `edit`: proceed with an edited version
 * - `cancel`: abort the entire commit flow
 */
export type MessageAction =
  | { action: "commit" }
  | { action: "edit"; message: string }
  | { action: "cancel" };

/**
 * Present the generated commit message to the user and let them
 * confirm, edit, or cancel.
 *
 * **dryRun mode**: shows the message via `ctx.ui.notify` and returns
 * `{ action: "commit" }` immediately (pipeline will skip actual commit).
 *
 * **TUI mode**: sets a widget with the message lines, then opens a
 * select dialog with Y/N/Edit choices.
 *
 * **Non-TUI mode**: notifies the message and returns `{ action: "commit" }`
 * (no interactive confirmation possible).
 *
 * @param ctx - Extension context (used for UI interactions)
 * @param message - The proposed commit message
 * @param widgetId - Widget identifier (different per command, e.g. "pi-git-commit")
 * @param dryRun - When true, only display without interactive confirmation
 */
export async function confirmCommitMessage(
  ctx: ExtensionContext,
  message: string,
  widgetId: string,
  dryRun?: boolean,
): Promise<MessageAction> {
  if (dryRun) {
    ctx.ui.notify(
      `[DRY RUN] Would commit with the following message:\n\n${message}`,
      "info",
    );
    return { action: "commit" };
  }

  // ── Non-TUI mode ──────────────────────────────────────
  if (!ctx.hasUI) {
    ctx.ui.notify(
      `Proposed commit message:\n\n${message}\n\nReply with "y" to commit, or provide changes.`,
      "info",
    );
    return { action: "commit" };
  }

  // ── TUI mode: interactive confirmation ────────────────
  const widgetLines = ["", ...message.split("\n"), ""];
  ctx.ui.setWidget(widgetId, widgetLines);

  const choice = await ctx.ui.select("Commit with the following message?", [
    "Y - Execute commit",
    "N - Cancel",
    "Edit - Modify the message",
  ]);

  ctx.ui.setWidget(widgetId, []);

  switch (choice) {
    case "Y - Execute commit":
      return { action: "commit" };

    case "Edit - Modify the message": {
      const edited = await ctx.ui.input(
        "Edit the commit message (full message):",
        message,
      );
      if (edited != null && edited !== message) {
        return { action: "edit", message: edited.trim() };
      }
      // User cancelled editor or left unchanged → re-confirm
      return {
        action: "edit",
        message,
      };
    }

    default:
      return { action: "cancel" };
  }
}
