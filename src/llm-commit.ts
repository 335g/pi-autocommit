import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PiGitConfig } from "./config.js";
import { isJapanese } from "./config.js";
import { generateCommitMessage, formatFullMessage } from "./commit-message.js";

/**
 * Try to generate a commit message using pi's LLM.
 *
 * Calls the model directly via `completeSimple` so the prompt is not
 * visible in the chat history.
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

	const bodyLangInstruction =
		lang === "ja"
			? "Write the body in Japanese (日本語)."
			: "Write the body in English.";

	const systemPrompt = [
		"You are a commit message generator. Generate a Conventional Commits",
		"commit message for the given staged changes.",
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
		"Output ONLY the commit message — no explanations, no markdown fences, no extra text.",
	].join("\n");

	const userContent = [
		"--- Staged changes ---",
		diff,
		"",
		"Commit message:",
	].join("\n");

	// Direct LLM call — no visible message in chat history.
	// Wrapped in try-catch so any error gracefully falls back to heuristic.
	try {
		if (!ctx.model) {
			throw new Error("No model available");
		}

		// Dynamic import: avoids startup failure when pi-ai doesn't export
		// `./compat` (e.g. pi installed via Nix store with bundled pi-ai that
		// lacks this subpath). If the import fails, falls through to heuristic.
		const { completeSimple } = await import("@earendil-works/pi-ai/compat");

		const result = await completeSimple(ctx.model, {
			systemPrompt,
			messages: [
				{ role: "user", content: userContent, timestamp: Date.now() },
			],
		});

		const text = result.content
			.filter(
				(c): c is { type: "text"; text: string } => c.type === "text" && !!c.text,
			)
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (text) return cleanupResponse(text);
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
