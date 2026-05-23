/**
 * Diff analysis and hunk splitting logic
 *
 * Uses the current AI model to analyze git diff and split changes into
 * logical hunks with Conventional Commits messages.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import type { Hunk } from "../types.js";
import { getCommitMessageLanguage } from "../utils/settings.js";

function getSystemPrompt(lang: string): string {
	const isJapanese = lang === "ja" || lang === "ja-JP" || lang === "japanese";

	if (isJapanese) {
		return `あなたはgit diff解析ツールです。git diffを分析し、変更を論理的なhunkに分割してください。

ルール:
- 各hunkは単一の論理的な変更を表す（例：「機能Xを追加」「バグYを修正」「Zをリファクタリング」）
- 同じ論理的な変更に属するファイル変更はグループ化する
- 1つのファイルに複数の独立した変更が含まれる場合は、別々のhunkに分割する
- 新規ファイルの場合は、内容から論理的な目的を推定する

各hunkに対して以下を提供してください:
- files: このhunkに含まれるファイルパスの配列
- message: Conventional Commits形式のメッセージ。typeは feat, fix, docs, style, refactor, test, chore から選択
  - サブジェクトは50文字以内に収める
  - 命令形を使用する（例：「追加」でなく「追加する」→英語のimperative moodに相当する日本語表現）
  - スコープはリポジトリの文脈から明確に推定できる場合のみ含める
  - 日本語でメッセージを記述する

以下の形式のJSON配列のみを返してください。マークダウンのコードフェンスや追加のテキストは不要です:
[
  {
    "files": ["path/to/file1.ts", "path/to/file2.ts"],
    "message": "feat: ユーザー認証機能を追加"
  }
]`;
	}

	return `You are a git diff analyzer. Your task is to analyze a git diff and split the changes into logical hunks.

Rules:
- Each hunk should represent a single logical change (e.g., "add feature X", "fix bug Y", "refactor Z")
- Group related file changes together if they belong to the same logical change
- If a single file contains multiple independent changes, split them into separate hunks
- For new files, infer the logical purpose from the content

For each hunk, provide:
- files: array of file paths included in this hunk
- message: a Conventional Commits style message. Choose type from: feat, fix, docs, style, refactor, test, chore
  - Keep the subject under 50 characters
  - Use imperative mood (e.g., "add" not "added")
  - Include scope only if clearly inferable from the repository context

Return ONLY a JSON array in this exact format, with no markdown code fences or additional text:
[
  {
    "files": ["path/to/file1.ts", "path/to/file2.ts"],
    "message": "feat(scope): add user authentication"
  }
]`;
}

function buildPrompt(diff: string, lang: string): string {
	const isJapanese = lang === "ja" || lang === "ja-JP" || lang === "japanese";

	if (isJapanese) {
		return `以下のgit diffを分析し、論理的なhunkに分割してください:

\`\`\`diff
${diff}
\`\`\`

指定された形式のJSON配列のみを返してください。`;
	}

	return `Here is the git diff to analyze. Split it into logical hunks:

\`\`\`diff
${diff}
\`\`\`

Respond with ONLY a JSON array of hunks as specified.`;
}

function parseHunks(text: string): Hunk[] {
	// Extract JSON from the response (handle code fences)
	let jsonText = text.trim();
	const codeFenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeFenceMatch) {
		jsonText = codeFenceMatch[1].trim();
	}

	try {
		const parsed = JSON.parse(jsonText);
		if (!Array.isArray(parsed)) {
			throw new Error("Response is not an array");
		}
		return parsed.map((item: unknown) => {
			if (typeof item !== "object" || item === null) {
				throw new Error("Invalid hunk item");
			}
			const hunk = item as Record<string, unknown>;
			const files = Array.isArray(hunk.files) ? hunk.files.filter((f): f is string => typeof f === "string") : [];
			const message = typeof hunk.message === "string" ? hunk.message : "chore: update files";
			return { files, message } as Hunk;
		});
	} catch {
		return [];
	}
}

function fallbackFileBasedHunks(diff: string): Hunk[] {
	// Parse diff to extract file paths
	const hunks: Hunk[] = [];
	const fileRegex = /^diff --git a\/(.+) b\/(.+)$/gm;
	let match: RegExpExecArray | null;

	while ((match = fileRegex.exec(diff)) !== null) {
		const filePath = match[2]; // Use 'b/' path (new version)
		hunks.push({
			files: [filePath],
			message: `chore: update ${filePath}`,
		});
	}

	return hunks;
}

export async function analyzeDiff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	diff: string,
): Promise<Hunk[]> {
	const model = ctx.model;
	if (!model) {
		console.warn("[pi-git] No model configured, using file-based fallback");
		return fallbackFileBasedHunks(diff);
	}
	console.log(`[pi-git] Using model: ${model.provider}/${model.id}`);

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		console.warn(`[pi-git] Auth failed: ${auth.error}, using file-based fallback`);
		return fallbackFileBasedHunks(diff);
	}
	console.log("[pi-git] API key resolved successfully");

	try {
		const lang = getCommitMessageLanguage();
		console.log(`[pi-git] Requesting AI analysis (language: ${lang})...`);
		const context: Context = {
			systemPrompt: getSystemPrompt(lang),
			messages: [
				{
					role: "user",
					content: buildPrompt(diff, lang),
					timestamp: Date.now(),
				},
			],
		};

		const result = await completeSimple(model, context, {
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: ctx.signal,
		});

		console.log(`[pi-git] AI response received (stopReason: ${result.stopReason}, tokens: ${result.usage?.totalTokens ?? "unknown"})`);

		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		console.log(`[pi-git] AI response text length: ${text.length} chars`);

		const hunks = parseHunks(text);
		if (hunks.length === 0) {
			console.warn("[pi-git] Failed to parse AI response, using file-based fallback");
			return fallbackFileBasedHunks(diff);
		}
		console.log(`[pi-git] Parsed ${hunks.length} hunk(s) from AI response`);
		return hunks;
	} catch (error) {
		console.error(`[pi-git] AI call failed: ${error instanceof Error ? error.message : String(error)}`);
		return fallbackFileBasedHunks(diff);
	}
}
