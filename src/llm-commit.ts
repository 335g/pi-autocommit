import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PiGitConfig } from "./config.js";
import { isJapanese } from "./config.js";
import { generateCommitMessage, formatFullMessage } from "./commit-message.js";

/**
 * Try to generate a commit message using pi's LLM.
 *
 * Sends a well-crafted prompt to the model via `sendUserMessage`,
 * waits for the response, and extracts the generated message from
 * the assistant's reply.
 *
 * Falls back to the heuristic `commit-message.ts` generator when
 * the LLM is unavailable or the response can't be parsed.
 */
export async function generateCommitMessageWithLLM(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	nameStatus: string,
	stat: string,
	diff: string,
	config: PiGitConfig,
): Promise<string> {
	const lang = isJapanese(config) ? "ja" : "en";

	// Build the prompt
	const bodyLangInstruction =
		lang === "ja"
			? "Write the body in Japanese (日本語)."
			: "Write the body in English.";

	const prompt = [
		"Generate a Conventional Commits commit message for the following staged changes.",
		"",
		"Output ONLY the commit message — no explanations, no markdown fences, no extra text.",
		"",
		"--- Rules ---",
		"Subject format: `type(scope): brief summary`",
		"Subject: English, imperative present tense, lowercase, no period, 50 chars or fewer.",
		`Body: list each changed file, describe what changed and why. ${bodyLangInstruction}`,
		"Footer: add `BREAKING CHANGE: ...` when there is a breaking change.",
		"",
		"Type reference (pick the most significant one):",
		"  feat     — New feature, new command/option/API",
		"  fix      — Bug fix, correction of unintended behavior",
		"  refactor — Improve code structure without behavior change",
		"  chore    — Build config, dependencies, CI, repository setup",
		"  docs     — Documentation-only (README, SKILL.md, comments)",
		"  test     — Adding or modifying tests",
		"  style    — Code formatting (no behavioral impact)",
		"  perf     — Performance improvements",
		"",
		"When a change spans multiple types, select the most significant one and",
		"describe the rest in the body.",
		"",
		"Scope: describe the affected area in parentheses if meaningful.",
		"There is no fixed list; infer from the changed paths.",
		"",
		"--- Staged diff ---",
		diff,
		"",
		"Commit message:",
	].join("\n");

	// Send to LLM and wait for response.
	// Wrapped in try-catch so any error gracefully falls back to heuristic.
	try {
		pi.sendUserMessage(prompt);
		await ctx.waitForIdle();

		// Extract the last assistant message from the session
		const generated = extractLastAssistantResponse(ctx);
		if (generated) {
			return cleanupResponse(generated);
		}
	} catch {
		// LLM path failed — fall through to heuristic
	}

	// Fallback: heuristic generation
	const fallback = generateCommitMessage(nameStatus, stat, diff, config);
	return formatFullMessage(fallback);
}

/**
 * Strip common LLM artifacts from the raw response:
 * - Markdown code fences (```...```)
 * - Leading/trailing whitespace per line
 * - Extra empty lines
 * - "Commit message:" prefix the model sometimes echoes
 */
function cleanupResponse(raw: string): string {
	let text = raw;

	// Remove markdown code fences (```...```)
	text = text.replace(/^```[\s\S]*?\n/, "");
	text = text.replace(/\n```\s*$/, "");

	// Remove inline backtick wrapping around the whole message
	text = text.replace(/^`([\s\S]*)`$/, "$1");

	// Remove echoed "Commit message:" prefix
	text = text.replace(/^Commit message:\s*/i, "");

	// Collapse 3+ consecutive newlines to 2
	text = text.replace(/\n{3,}/g, "\n\n");

	return text.trim();
}

/**
 * Extract the last assistant message text from the session.
 */
function extractLastAssistantResponse(ctx: ExtensionCommandContext): string | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as {
			type: string;
			message?: { role: string; content: Array<{ type: string; text?: string }> };
		};

		if (entry.type === "message" && entry.message?.role === "assistant") {
			const content = entry.message.content;
			if (Array.isArray(content)) {
				const text = content
					.filter((c): c is { type: "text"; text: string } => c.type === "text" && !!c.text)
					.map((c) => c.text)
					.join("\n")
					.trim();

				if (text) return text;
			}
		}
	}
	return null;
}
