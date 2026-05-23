/**
 * Conventional Commits message validation and sanitization
 *
 * Since diff-analyzer.ts already generates Conventional Commits messages via AI,
 * this module focuses on post-processing: validation, cleanup, and fallback.
 */

import type { Hunk } from "../types.js";

/** Valid Conventional Commits types */
const VALID_TYPES = ["feat", "fix", "docs", "style", "refactor", "test", "chore", "perf", "ci", "build", "revert"];

/** Pattern: type(scope)!: subject or type!: subject */
const CONVENTIONAL_COMMIT_PATTERN = /^(\w+)(\([^)]+\))?(!)?:\s*(.+)$/;

const MAX_SUBJECT_LENGTH = 50;

/**
 * Check if a message follows Conventional Commits format.
 */
export function isConventionalCommit(message: string): boolean {
	const match = CONVENTIONAL_COMMIT_PATTERN.exec(message);
	if (!match) return false;
	const type = match[1];
	return VALID_TYPES.includes(type);
}

/**
 * Extract the subject part (after type/scope) from a conventional commit message.
 */
function extractSubject(message: string): string | undefined {
	const match = CONVENTIONAL_COMMIT_PATTERN.exec(message);
	return match?.[4];
}

/**
 * Build a conventional commit message with a valid type.
 */
function buildMessage(type: string, scope: string | undefined, subject: string, breaking = false): string {
	const scopePart = scope ? `(${scope})` : "";
	const breakingPart = breaking ? "!" : "";
	return `${type}${scopePart}${breakingPart}: ${subject}`;
}

/**
 * Infer commit type from file paths and content.
 */
function inferTypeFromFiles(files: string[]): string {
	const allPaths = files.join(" ").toLowerCase();

	if (/test|spec|\.test\.|\.spec\./.test(allPaths)) return "test";
	if (/readme|\.md$|docs?\//.test(allPaths)) return "docs";
	if (/\.css$|\.scss$|\.less$|\.svg$|\.png$|\.jpg$/.test(allPaths)) return "style";
	if (/package\.json|package-lock|yarn\.lock|pnpm-lock|cargo\.lock|\.lock$|makefile|dockerfile|\.yml$|\.yaml$|\.toml$/.test(allPaths)) {
		return "chore";
	}
	if (/\.github|\.ci|\.ci\//.test(allPaths)) return "ci";
	if (/\.config\.|config\/|\.env|\.rc/.test(allPaths)) return "chore";

	return "chore";
}

/**
 * Sanitize and validate a commit message.
 * Returns a clean, valid Conventional Commits message.
 */
export function sanitizeCommitMessage(message: string, files?: string[]): string {
	const originalMessage = message.trim();
	console.log(`[pi-git] Sanitizing message: "${originalMessage.substring(0, 80)}${originalMessage.length > 80 ? '...' : ''}"`);

	let sanitized = originalMessage;

	// Remove trailing period from subject
	sanitized = sanitized.replace(/\.$/, "");

	// Check if already valid
	if (isConventionalCommit(sanitized)) {
		const match = CONVENTIONAL_COMMIT_PATTERN.exec(sanitized)!;
		let type = match[1];
		const scope = match[2]?.slice(1, -1); // remove parentheses
		let subject = match[4];

		// Normalize type
		if (!VALID_TYPES.includes(type)) {
			console.log(`[pi-git] Normalizing type "${type}" -> "chore"`);
			type = "chore";
		}

		// Truncate subject if too long
		if (subject.length > MAX_SUBJECT_LENGTH) {
			const truncated = subject.slice(0, MAX_SUBJECT_LENGTH - 3) + "...";
			console.log(`[pi-git] Truncating subject: "${subject.substring(0, 50)}..." -> "${truncated}"`);
			subject = truncated;
		}

		const result = buildMessage(type, scope, subject, match[3] === "!");
		console.log(`[pi-git] Valid conventional commit: "${result}"`);
		return result;
	}

	// Not a conventional commit - try to fix or fallback
	console.warn(`[pi-git] Not a conventional commit: "${sanitized.substring(0, 60)}"`);

	// If it has a colon, maybe it's an unknown format
	const colonIndex = sanitized.indexOf(":");
	if (colonIndex > 0) {
		const possibleSubject = sanitized.slice(colonIndex + 1).trim();
		if (possibleSubject.length > 0) {
			const type = files ? inferTypeFromFiles(files) : "chore";
			console.log(`[pi-git] Extracted subject after colon, inferred type: "${type}"`);
			return buildMessage(type, undefined, possibleSubject);
		}
	}

	// Fallback: treat entire message as subject
	const fallbackType = files ? inferTypeFromFiles(files) : "chore";
	console.log(`[pi-git] Inferred type from files: "${fallbackType}"`);
	const subject = sanitized.length > MAX_SUBJECT_LENGTH
		? sanitized.slice(0, MAX_SUBJECT_LENGTH - 3) + "..."
		: sanitized;
	const result = buildMessage(fallbackType, undefined, subject || "update files");
	console.log(`[pi-git] Fallback message: "${result}"`);
	return result;
}

/**
 * Generate a fallback message when AI generation fails entirely.
 */
export function generateFallbackMessage(files: string[]): string {
	const type = inferTypeFromFiles(files);
	if (files.length === 1) {
		const fileName = files[0].split("/").pop() || files[0];
		return `${type}: update ${fileName}`;
	}
	return `${type}: update ${files.length} files`;
}

/**
 * Sanitize a hunk's message in place.
 */
export function sanitizeHunk(hunk: Hunk): Hunk {
	return {
		...hunk,
		message: sanitizeCommitMessage(hunk.message, hunk.files),
	};
}
