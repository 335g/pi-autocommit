import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GitOperations } from "./git-operations.js";

/**
 * Shared footer-status updater for the commit pipeline and organiser.
 *
 * Pipeline and organiser never import this class — it is used exclusively
 * by the presenter in index.ts, both in the success and error paths.
 */
export class StatusIndicator {
  constructor(
    private git: GitOperations,
    private ctx: ExtensionContext,
  ) {}

  async updateFooter(): Promise<void> {
    try {
      if (!(await this.git.isInsideGitRepo())) {
        this.ctx.ui.setStatus("pi-git-uncommitted", undefined);
        return;
      }
      const hasChanges = await this.git.checkUncommittedChanges();
      this.ctx.ui.setStatus(
        "pi-git-uncommitted",
        hasChanges ? "[has changes]" : undefined,
      );
    } catch {
      this.ctx.ui.setStatus("pi-git-uncommitted", undefined);
    }
  }
}
