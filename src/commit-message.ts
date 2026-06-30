import type { PiGitConfig } from "./config.js";
import { hasNoBody, isJapanese } from "./config.js";
import { type ParsedNameStatus, parseNameStatus } from "./git-parser.js";
import type { CommitType } from "./commit-types.js";

export interface CommitMessage {
	type: CommitType;
	scope: string | null;
	subject: string;
	body: string;
	footer: string | null;
}

/**
 * Determine the Conventional Commits type from the staged changes.
 *
 * Rules (matching SKILL.md):
 * - **docs** when only documentation files changed
 * - **test** when only test files changed
 * - **style** when changes look like formatting-only
 * - **chore** when only config/build files changed
 * - For code changes, analyze diff keywords to distinguish feat/fix/perf/refactor
 */
function determineType(
	nameStatusEntries: ParsedNameStatus[],
	diff: string,
	stat: string,
): CommitType {
	const paths = nameStatusEntries.map((e) => e.path);

	if (paths.length === 0) return "refactor";

	// --- Docs-only check ---
	if (paths.every((p) => /\.(md|txt)$/i.test(p) || /^docs\//i.test(p) || /^README/i.test(p))) {
		return "docs";
	}

	// --- Test-only check ---
	if (
		paths.length > 0 &&
		paths.every(
			(p) =>
				/\.(test|spec)\./i.test(p) ||
				p.includes("__tests__") ||
				/\/test\//i.test(p) ||
				/^test\//i.test(p),
		)
	) {
		return "test";
	}

	// --- Config-only check ---
	const isConfigOnly = paths.every((p) =>
		/package\.json|tsconfig|biome\.|\.github|\.gitignore|\.env|apm\.|Dockerfile|\.npmrc|\.prettier/i.test(
			p,
		),
	);
	if (isConfigOnly) return "chore";

	// --- Code change analysis via diff keywords ---
	const hasNewCode = /new file|@@ -0,0/.test(diff);
	const hasBugFixKeywords = /\b(fix|bug|error|crash|issue|wrong|incorrect|broken)\b/i.test(diff);
	const hasFeatureKeywords = /\b(add|new\s+(feature|function|class|interface|type|command|option|api|endpoint))\b/i.test(
		diff,
	);
	const hasPerfKeywords = /\b(perf|perform|optimize|slow|fast|bottleneck|latency|speed)\b/i.test(diff);
	const hasRefactorKeywords = /\b(refactor|renam|restructur|simplif|clean.?up|extract|consolidate|dedup)\b/i.test(
		diff,
	);
	const hasStyleKeywords = /^\s*[+-]\s*$|^[+-]\s*\/\/|^[+-]\s*\/\*|^[+-]\s*\*|;\s*$/m.test(diff);

	// Priority: feat > fix > perf > refactor > style > chore
	if (hasFeatureKeywords && hasNewCode) return "feat";
	if (hasBugFixKeywords) return "fix";
	if (hasPerfKeywords) return "perf";
	if (hasRefactorKeywords) return "refactor";
	if (hasStyleKeywords) return "style";

	// Default: if new files were added treat as feat, otherwise refactor
	if (hasNewCode) return "feat";
	return "refactor";
}

/**
 * Determine the scope from changed file paths.
 *
 * Uses the longest common directory prefix among the changed files.
 * Falls back to `null` when files span completely different areas.
 */
function determineScope(nameStatusEntries: ParsedNameStatus[]): string | null {
	const paths = nameStatusEntries.map((e) => e.path);
	if (paths.length === 0) return null;

	// Extract top-level directories
	const dirs = paths.map((p) => {
		const idx = p.indexOf("/");
		return idx >= 0 ? p.substring(0, idx) : p;
	});

	// If all files share the same top-level dir, use it as scope
	const uniqueDirs = [...new Set(dirs)];
	if (uniqueDirs.length === 1 && uniqueDirs[0] !== "") return uniqueDirs[0];

	// Try two-level scope
	const dirs2 = paths.map((p) => {
		const parts = p.split("/");
		return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts.length >= 2 ? `${parts[0]}` : p;
	});
	const uniqueDirs2 = [...new Set(dirs2)];
	if (uniqueDirs2.length === 1) return uniqueDirs2[0];

	// If a single file changed, use its name (without extension)
	if (paths.length === 1) {
		return paths[0].replace(/\.[^.]+$/, "");
	}

	return null;
}

/**
 * Extract a brief subject description from the diff content.
 *
 * The description:
 * - Uses imperative present tense
 * - Starts with a lowercase letter
 * - No trailing period
 * - 50 chars or fewer when possible
 */
function extractSubject(type: CommitType, nameStatusEntries: ParsedNameStatus[], diff: string, jp: boolean): string {
	const paths = nameStatusEntries.map((e) => e.path);
	const statuses = nameStatusEntries.map((e) => e.status);

	const hasAdditions = statuses.includes("A");
	const hasDeletions = statuses.includes("D");
	const hasModifications = statuses.includes("M");
	const hasRenames = statuses.includes("R");

	if (jp) {
		switch (type) {
			case "feat": {
				const newFiles = nameStatusEntries.filter((e) => e.status === "A").map((e) => e.path);
				if (newFiles.length === 1) {
					const name = newFiles[0].split("/").pop()?.replace(/\.[^.]+$/, "") ?? newFiles[0];
					return `追加 ${name}`;
				}
				if (newFiles.length > 1) {
					const dirs = [...new Set(newFiles.map((p) => p.split("/")[0]))];
					if (dirs.length === 1) return `追加 ${dirs[0]} 関連`;
					return "新規ファイルを追加";
				}
				return "新機能を追加";
			}

			case "fix": {
				const fixMatch = diff.match(/\b(fix|bug|error|issue|crash|修正|バグ|不具合)\s+(\S+)/i);
				if (fixMatch) {
					const target = fixMatch[2].replace(/[.:,;!?]$/, "").toLowerCase();
					return `修正 ${target}`;
				}
				return "不具合を修正";
			}

			case "docs": {
				const docFiles = paths.filter((p) => /\.md$/i.test(p));
				if (docFiles.length === 1) {
					const name = docFiles[0].split("/").pop()?.replace(/\.md$/, "") ?? docFiles[0];
					return `更新 ${name}`;
				}
				if (docFiles.length > 1) return "ドキュメントを更新";
				return "ドキュメントを更新";
			}

			case "test": {
				if (hasAdditions) return "テストを追加";
				return "テストを更新";
			}

			case "chore":
				return "設定を更新";

			case "style":
				return "コードスタイルを統一";

			case "perf":
				return "パフォーマンスを改善";

			case "refactor":
			default: {
				if (hasRenames) {
					const renamed = nameStatusEntries.filter((e) => e.status === "R");
					if (renamed.length === 1) {
						const from = renamed[0].oldPath?.split("/").pop() ?? "";
						const to = renamed[0].path.split("/").pop() ?? "";
						return `リネーム ${from} → ${to}`;
					}
					return "ファイルをリネーム";
				}
				if (hasDeletions && !hasAdditions) return "不要コードを削除";
				return "コードを整理";
			}
		}
	}

	switch (type) {
		case "feat": {
			// Look for a specific new file or feature name in the diff
			const newFiles = nameStatusEntries.filter((e) => e.status === "A").map((e) => e.path);
			if (newFiles.length === 1) {
				const name = newFiles[0].split("/").pop()?.replace(/\.[^.]+$/, "") ?? newFiles[0];
				return `add ${name}`;
			}
			if (newFiles.length > 1) {
				const dirs = [...new Set(newFiles.map((p) => p.split("/")[0]))];
				if (dirs.length === 1) return `add ${dirs[0]} files`;
				return "add new files";
			}
			// No new files — likely feature additions to existing files
			return "implement new functionality";
		}

		case "fix": {
			// Extract what was fixed from the diff
			const fixMatch = diff.match(/\b(fix|bug|error|issue|crash)\s+(\S+)/i);
			if (fixMatch) {
				const target = fixMatch[2].replace(/[.:,;!?]$/, "").toLowerCase();
				return `fix ${target}`;
			}
			return "fix issues";
		}

		case "docs": {
			const docFiles = paths.filter((p) => /\.md$/i.test(p));
			if (docFiles.length === 1) {
				const name = docFiles[0].split("/").pop()?.replace(/\.md$/, "") ?? docFiles[0];
				return `update ${name}`;
			}
			if (docFiles.length > 1) return "update documentation";
			return "update docs";
		}

		case "test": {
			if (hasAdditions) return "add tests";
			return "update tests";
		}

		case "chore":
			return "update configuration";

		case "style":
			return "format code";

		case "perf":
			return "improve performance";

		case "refactor":
		default: {
			// Try to derive a meaningful description
			if (hasRenames) {
				const renamed = nameStatusEntries.filter((e) => e.status === "R");
				if (renamed.length === 1) {
					const from = renamed[0].oldPath?.split("/").pop() ?? "";
					const to = renamed[0].path.split("/").pop() ?? "";
					return `rename ${from} to ${to}`;
				}
				return "rename files";
			}
			if (hasDeletions && !hasAdditions) return "remove dead code";
			return "refactor code";
		}
	}
}

/**
 * Generate a detailed body describing the changes.
 *
 * The body lists changed files with descriptions.
 * Language follows the `lang` config setting.
 */
function generateBody(
	nameStatusEntries: ParsedNameStatus[],
	stat: string,
	config: PiGitConfig,
	type: CommitType,
): string {
	if (hasNoBody(config)) return "";

	const jp = isJapanese(config);

	// Parse stat lines to get insertion/deletion counts per file
	const statLines = stat.split("\n").filter((l) => l.trim().length > 0);

	const lines: string[] = [];

	if (jp) {
		lines.push("変更内容:");
	} else {
		lines.push("Changes:");
	}

	for (const entry of nameStatusEntries) {
		// Find the matching stat line for this file
		const changeCount = statLines.find((l) => l.includes(entry.path));

		// Status label
		let statusLabel: string;
		if (jp) {
			switch (entry.status) {
				case "A":
					statusLabel = "新規作成";
					break;
				case "D":
					statusLabel = "削除";
					break;
				case "R":
					statusLabel = "リネーム";
					break;
				case "M":
				default:
					statusLabel = "変更";
					break;
			}
		} else {
			switch (entry.status) {
				case "A":
					statusLabel = "create";
					break;
				case "D":
					statusLabel = "delete";
					break;
				case "R":
					statusLabel = "rename";
					break;
				case "M":
				default:
					statusLabel = "update";
					break;
			}
		}

		const statSuffix = changeCount
			? changeCount.replace(entry.path, "").trim()
			: "";

		if (entry.status === "R" && entry.oldPath) {
			if (jp) {
				lines.push(`- ${entry.path} — ${entry.oldPath} から${statusLabel}`);
			} else {
				lines.push(`- ${entry.path} — ${statusLabel}d from ${entry.oldPath}`);
			}
		} else {
			lines.push(`- ${entry.path} — ${statusLabel}${statSuffix}`);
		}
	}

	// Add a summary line about the overall change
	lines.push("");
	const totalFiles = nameStatusEntries.length;
	if (jp) {
		lines.push(`計 ${totalFiles} ファイルを変更。`);
		switch (type) {
			case "feat":
				lines.push("新機能を追加。");
				break;
			case "fix":
				lines.push("バグを修正。");
				break;
			case "refactor":
				lines.push("コード構造を改善。");
				break;
			case "docs":
				lines.push("ドキュメントを更新。");
				break;
			case "test":
				lines.push("テストを更新。");
				break;
			case "chore":
				lines.push("設定・ビルド関連を更新。");
				break;
			case "style":
				lines.push("コードスタイルを統一。");
				break;
			case "perf":
				lines.push("パフォーマンスを改善。");
				break;
		}
	} else {
		lines.push(`Changed ${totalFiles} file${totalFiles > 1 ? "s" : ""}.`);
		switch (type) {
			case "feat":
				lines.push("Introduce new feature.");
				break;
			case "fix":
				lines.push("Fix bugs.");
				break;
			case "refactor":
				lines.push("Improve code structure.");
				break;
			case "docs":
				lines.push("Update documentation.");
				break;
			case "test":
				lines.push("Update tests.");
				break;
			case "chore":
				lines.push("Update configuration/build.");
				break;
			case "style":
				lines.push("Unify code style.");
				break;
			case "perf":
				lines.push("Improve performance.");
				break;
		}
	}

	return lines.join("\n");
}

/**
 * Format the subject line as `type(scope): summary`.
 */
function formatSubject(type: CommitType, scope: string | null, summary: string): string {
	const typePart = scope ? `${type}(${scope})` : type;
	return `${typePart}: ${summary}`;
}

/**
 * Detect whether the diff contains a BREAKING CHANGE.
 *
 * Looks for `BREAKING CHANGE:` or `!` after the type/scope prefix
 * in conventional commit format, or indicators in the diff content.
 */
function detectBreakingChange(
	nameStatusEntries: ParsedNameStatus[],
	diff: string,
): string | null {
	// Check diff for explicit BREAKING CHANGE markers
	const explicitMatch = diff.match(/BREAKING\s+CHANGE:\s*(.+)/i);
	if (explicitMatch) {
		return `BREAKING CHANGE: ${explicitMatch[1].trim()}`;
	}

	// Check for removal of public APIs (heuristic)
	const hasPublicApiRemoval = nameStatusEntries.some(
		(e) =>
			e.status === "D" &&
			/\/index\.(ts|js)$|public|api|export/.test(e.path),
	);
	if (hasPublicApiRemoval) {
		return "BREAKING CHANGE: remove public API";
	}

	return null;
}

/**
 * Wrap text at the specified width, respecting existing line breaks.
 */
function wrapText(text: string, width: number): string {
	return text
		.split("\n")
		.map((line) => {
			if (line.length <= width) return line;
			const wrapped: string[] = [];
			let current = "";
			for (const word of line.split(" ")) {
				if ((current + " " + word).trim().length > width) {
					wrapped.push(current.trim());
					current = word;
				} else {
					current += (current ? " " : "") + word;
				}
			}
			if (current.trim()) wrapped.push(current.trim());
			return wrapped.join("\n");
		})
		.join("\n");
}

/**
 * Generate the full Conventional Commits message.
 */
export function generateCommitMessage(
	nameStatusRaw: string,
	stat: string,
	diff: string,
	config: PiGitConfig,
): CommitMessage {
	const entries = parseNameStatus(nameStatusRaw);

	const type = determineType(entries, diff, stat);
	const scope = determineScope(entries);
	const summary = extractSubject(type, entries, diff, isJapanese(config));
	const subject = formatSubject(type, scope, summary);
	const body = wrapText(generateBody(entries, stat, config, type), 72);
	const breakingFooter = detectBreakingChange(entries, diff);
	const formattedFooter = breakingFooter ? wrapText(breakingFooter, 72) : null;

	return {
		type,
		scope,
		subject,
		body,
		footer: formattedFooter,
	};
}

/**
 * Format the full commit message string ready for `git commit -m`.
 */
export function formatFullMessage(msg: CommitMessage): string {
	let full = msg.body
		? `${msg.subject}\n\n${msg.body}`
		: msg.subject;
	if (msg.footer) {
		full += `\n\n${msg.footer}`;
	}
	return full;
}
