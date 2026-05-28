/**
 * pi-git extension entry point
 *
 * Provides slash commands for git operations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleAggCommit, isAggCommitRunning, setAggCommitRunning } from "./commands/agg-commit.js";
import { handleAutoAggCommit } from "./commands/auto-agg-commit.js";
import { handleConfig } from "./commands/config.js";
import { isGitRepository, hasChanges, stageFiles, resetStaging } from "./core/git.js";
import { generateAutoCommitMessage } from "./core/auto-commit-message.js";
import { getAutoAggCommit, getLanguage } from "./utils/settings.js";
import { updateAutoAggCommitStatus } from "./utils/status.js";

export default function (pi: ExtensionAPI) {
	// Initialize status on session start
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			updateAutoAggCommitStatus(ctx.ui, getAutoAggCommit(ctx.cwd), ctx.cwd);
		}
	});

	// Register /git-agg-commit command
	pi.registerCommand("git-agg-commit", {
		description: "Auto stage and commit changes with AI-generated Conventional Commits messages",
		handler: async (args, ctx) => {
			await handleAggCommit(pi, ctx, args);
		},
	});

	// Register /git-config command
	pi.registerCommand("git-config", {
		description: "Get, set, or list pi-git configuration values",
		handler: async (args, ctx) => {
			await handleConfig(pi, ctx, args);
		},
	});

	// Register /git-auto-agg-commit command
	pi.registerCommand("git-auto-agg-commit", {
		description: "Toggle automatic git-agg-commit after assistant responses",
		handler: async (args, ctx) => {
			await handleAutoAggCommit(pi, ctx, args);
		},
	});

	// Auto-run git-agg-commit after assistant response when enabled
	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		if (isAggCommitRunning) {
			return;
		}

		if (!getAutoAggCommit(ctx.cwd)) {
			return;
		}

		if (!(await isGitRepository(pi))) {
			return;
		}

		if (!(await hasChanges(pi))) {
			return;
		}

		const STATUS_ID = "pi-git-agg-commit";
		const lang = getLanguage(ctx.cwd);
		const isJapanese =
			lang === "ja" || lang === "ja-JP" || lang === "japanese";

		// 自動実行モード: hunk解析をスキップし、会話履歴からコミットメッセージを生成
		setAggCommitRunning(true);
		ctx.ui.setStatus(
			STATUS_ID,
			isJapanese
				? "[pi-git: auto-commit] コミットメッセージ生成中..."
				: "[pi-git: auto-commit] Generating commit message...",
		);
		try {
			// 変更ファイル一覧を取得
			const { stdout: statusOutput } = await pi.exec(
				"git",
				["status", "--short"],
				{ cwd: ctx.cwd },
			);
			const changedFiles = statusOutput
				.split("\n")
				.filter(Boolean)
				.map((line) => line.slice(3).trim())
				.filter(Boolean);

			if (changedFiles.length === 0) {
				ctx.ui.setStatus(STATUS_ID, "");
				return;
			}

			// 会話履歴からコミットメッセージを生成
			const messages = ((event as any).messages || []) as {
				role: string;
				content: unknown;
			}[];
			const commitMessage = await generateAutoCommitMessage(
				pi,
				ctx,
				messages,
				changedFiles,
			);

			ctx.ui.setStatus(
				STATUS_ID,
				isJapanese
					? "[pi-git: auto-commit] コミット実行中..."
					: "[pi-git: auto-commit] Committing...",
			);

			// 全ファイルをステージングして1つのコミット
			await stageFiles(pi, changedFiles, ctx.cwd);
			const { code: exitCode, stderr } = await pi.exec(
				"git",
				["commit", "-m", commitMessage],
				{ cwd: ctx.cwd },
			);

			if (exitCode !== 0) {
				await resetStaging(pi, ctx.cwd);
				ctx.ui.notify(
					isJapanese
						? `コミットに失敗しました: ${stderr}`
						: `Commit failed: ${stderr}`,
					"warning",
				);
			} else {
				ctx.ui.notify(
					isJapanese
						? `コミットを作成しました: ${commitMessage}`
						: `Created commit: ${commitMessage}`,
					"info",
				);
			}
		} finally {
			ctx.ui.setStatus(STATUS_ID, "");
			setAggCommitRunning(false);
		}
	});
}
