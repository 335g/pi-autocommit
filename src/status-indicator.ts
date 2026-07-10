import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitOperations } from "./git-operations.js";

/**
 * Shared footer-status updater for the checkpoint pipeline and organiser.
 *
 * Used exclusively by the presenter in index.ts, both in the success and
 * error paths.
 */
export class StatusIndicator {
  constructor(
    private git: GitOperations,
    private ctx: ExtensionContext,
  ) {}

  async updateFooter(): Promise<void> {
    try {
      if (!(await this.git.isInsideGitRepo())) {
        this.ctx.ui.setStatus("pi-autocommit-uncommitted", undefined);
        return;
      }
      const hasChanges = await this.git.checkUncommittedChanges();
      this.ctx.ui.setStatus(
        "pi-autocommit-uncommitted",
        hasChanges ? "[has changes]" : undefined,
      );
    } catch {
      this.ctx.ui.setStatus("pi-autocommit-uncommitted", undefined);
    }
  }
}
