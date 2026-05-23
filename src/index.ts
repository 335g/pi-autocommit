/**
 * pi-git extension entry point
 *
 * Provides slash commands for git operations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleAutoCommit } from "./commands/auto-commit.js";

export default function (pi: ExtensionAPI) {
	// Register /git-auto-commit command
	pi.registerCommand("git-auto-commit", {
		description: "Auto stage and commit changes with AI-generated Conventional Commits messages",
		handler: async (args, ctx) => {
			await handleAutoCommit(pi, ctx, args);
		},
	});
}
