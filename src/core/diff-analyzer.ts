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

const SYSTEM_PROMPT = `You are a git diff analyzer. Your task is to analyze a git diff and split the changes into logical hunks.

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

function buildPrompt(diff: string): string {
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
		// No model available, use file-based fallback
		return fallbackFileBasedHunks(diff);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		// Auth failed, use file-based fallback
		return fallbackFileBasedHunks(diff);
	}

	try {
		const context: Context = {
			systemPrompt: SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: buildPrompt(diff),
					timestamp: Date.now(),
				},
			],
		};

		const result = await completeSimple(model, context, {
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: ctx.signal,
		});

		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		const hunks = parseHunks(text);
		if (hunks.length === 0) {
			// Parse failed, fallback
			return fallbackFileBasedHunks(diff);
		}
		return hunks;
	} catch (error) {
		// AI call failed, fallback to file-based
		return fallbackFileBasedHunks(diff);
	}
}
