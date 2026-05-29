/**
 * pi-git extension entry point
 *
 * Provides slash commands for git operations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentEndEvent } from "./types.js";
import { handleAggCommit } from "./commands/agg-commit.js";
import { handleAutoAggCommit } from "./commands/auto-agg-commit.js";
import { handleBranch } from "./commands/branch.js";
import { handleConfig } from "./commands/config.js";
import { handleGitDiff } from "./commands/git-diff.js";
import { handleAutoCommit } from "./core/auto-commit.js";
import { getAutoAggCommit } from "./utils/settings.js";
import { updateAutoAggCommitStatus } from "./utils/status.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      updateAutoAggCommitStatus(ctx.ui, getAutoAggCommit(ctx.cwd), ctx.cwd);
    }
  });

  pi.registerCommand("git-agg-commit", {
    description:
      "Auto stage and commit changes with AI-generated Conventional Commits messages",
    handler: async (args, ctx) => {
      await handleAggCommit(pi, ctx, args);
    },
  });

  pi.registerCommand("git-config", {
    description: "Get, set, or list pi-git configuration values",
    handler: async (args, ctx) => {
      await handleConfig(pi, ctx, args);
    },
  });

  pi.registerCommand("git-auto-agg-commit", {
    description: "Toggle automatic git-agg-commit after assistant responses",
    handler: async (args, ctx) => {
      await handleAutoAggCommit(pi, ctx, args);
    },
  });

  pi.registerCommand("git-branch", {
    description: "Manage git branches: list, switch, create, and delete",
    handler: async (args, ctx) => {
      await handleBranch(pi, ctx, args);
    },
  });

  pi.registerCommand("git-diff", {
    description:
      "Interactively review AI-generated hunks and commit approved ones",
    handler: async (args, ctx) => {
      await handleGitDiff(pi, ctx, args);
    },
  });

  pi.on("agent_end", async (event, ctx) => {
    await handleAutoCommit(pi, ctx, event as AgentEndEvent);
  });
}
