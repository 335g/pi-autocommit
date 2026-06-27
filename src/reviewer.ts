import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * A single comment from a crit review.
 */
export interface CritComment {
	id: string;
	/** The comment body text */
	body: string;
	/** The text the user selected when commenting (if any) */
	quote?: string;
	/** The file path the comment is on (if applicable) */
	file?: string;
	/** Whether the comment has been resolved */
	resolved: boolean;
}

/**
 * Result of a completed crit review.
 */
export interface CritReviewResult {
	/** True when all comments are resolved */
	approved: boolean;
	/** Review comments */
	comments: CritComment[];
	/** Free‑form instructions from the reviewer (set via the "prompt" field) */
	prompt?: string;
}

/**
 * Write a review document and launch crit on it.
 *
 * Creates a temporary markdown file with the diff summary, opens crit in the
 * browser, and blocks until the user clicks "Finish Review". The temp file
 * is cleaned up when the function returns (even on error).
 *
 * @throws If `crit` is not installed or returns unparseable output.
 */
export async function runCritReview(
	pi: ExtensionAPI,
	diffContent: string,
	fileEntries: { path: string; additions: number; deletions: number }[],
): Promise<CritReviewResult> {
	const timestamp = Date.now();
	const reviewPath = join(tmpdir(), `pi-git-review-${timestamp}.md`);

	try {
		const document = buildReviewDocument(diffContent, fileEntries);
		writeFileSync(reviewPath, document, "utf-8");

		try {
			const { stdout } = await pi.exec("crit", [reviewPath]);
			return parseCritOutput(stdout);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (
				message.includes("not found") ||
				message.includes("ENOENT") ||
				message.includes("command not found")
			) {
				throw new Error(
					"`crit` is not available. Install it first (npm install -g crit) or use `/commit` instead.",
				);
			}
			throw new Error(`crit review failed: ${message}`);
		}
	} finally {
		try {
			unlinkSync(reviewPath);
		} catch {
			// Best-effort cleanup
		}
	}
}

/**
 * Build a structured markdown document for crit review.
 */
function buildReviewDocument(
	diffContent: string,
	fileEntries: { path: string; additions: number; deletions: number }[],
): string {
	const lines: string[] = [];
	lines.push("# Review");
	lines.push("");
	lines.push(
		`Total: ${fileEntries.length} file${fileEntries.length !== 1 ? "s" : ""}`,
	);
	lines.push("");
	lines.push("| File | Additions | Deletions |");
	lines.push("|------|-----------|-----------|");
	for (const entry of fileEntries) {
		lines.push(
			`| \`${entry.path}\` | +${entry.additions} | -${entry.deletions} |`,
		);
	}
	lines.push("");
	lines.push("## Diff");
	lines.push("");
	lines.push("```diff");
	lines.push(diffContent);
	lines.push("```");
	return lines.join("\n");
}

/**
 * Parse crit's stdout JSON output.
 *
 * Crit may print startup messages before the JSON payload,
 * so we find the first JSON object in the output.
 */
function parseCritOutput(stdout: string): CritReviewResult {
	// Find JSON in the output (may have startup messages before it)
	const jsonMatch = stdout.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		throw new Error(`Could not parse crit output:\n${stdout}`);
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
	} catch {
		throw new Error(`Invalid JSON from crit:\n${stdout}`);
	}

	const rawComments = (parsed.comments ?? []) as Array<Record<string, unknown>>;

	return {
		approved: (parsed.approved as boolean) ?? false,
		prompt: parsed.prompt as string | undefined,
		comments: rawComments.map((c) => ({
			id: (c.id as string) ?? "",
			body: (c.body as string) ?? "",
			quote: c.quote as string | undefined,
			file: c.file as string | undefined,
			resolved: (c.resolved as boolean) ?? false,
		})),
	};
}
