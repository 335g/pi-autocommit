/**
 * /git-auto-agg-commit command
 *
 * Toggle auto-agg-commit feature: automatically run git-agg-commit
 * after the assistant finishes responding when there are changes.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { t } from "../utils/lang.js";
import {
  getAutoAggCommit,
  getLanguage,
  getLocalSettingsPath,
  saveGlobalSettings,
  saveLocalSettings,
} from "../utils/settings.js";
import { footerManager } from "../utils/footer-manager.js";

const P = "[pi-git]";

export async function handleAutoAggCommit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  const trimmed = args.trim().toLowerCase();
  const current = getAutoAggCommit();
  const lang = getLanguage(ctx.cwd);

  if (trimmed === "--help") {
    ctx.ui.notify(
      t(lang,
        "autoAggCommit.help",
      ),
      "info",
    );
    return;
  }

  let next: boolean;
  switch (trimmed) {
    case "on":
      next = true;
      break;
    case "off":
      next = false;
      break;
    case "toggle":
      next = !current;
      break;
    case "":
      ctx.ui.notify(
        t(lang,
          "autoAggCommit.status",
          { status: t(lang, current ? "autoAggCommit.enabled" : "autoAggCommit.disabled") },
        ),
        "info",
      );
      return;
    default:
      ctx.ui.notify(
        t(lang,
          "autoAggCommit.invalidArg",
        ),
        "warning",
      );
      return;
  }

  const localPath = getLocalSettingsPath(ctx.cwd);
  if (localPath) {
    saveLocalSettings({ auto_agg_commit: next }, ctx.cwd);
  } else {
    saveGlobalSettings({ auto_agg_commit: next });
  }

  await footerManager.refresh();

  const statusText = t(lang, next ? "autoAggCommit.enabled" : "autoAggCommit.disabled");
  if (localPath) {
    ctx.ui.notify(
      t(lang,
        "autoAggCommit.enabledLocal",
        { status: statusText },
      ),
      "info",
    );
  } else {
    ctx.ui.notify(
      t(lang,
        "autoAggCommit.enabledGlobal",
        { status: statusText },
      ),
      "info",
    );
  }
}
