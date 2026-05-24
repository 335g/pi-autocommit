/**
 * Git command wrappers using pi.exec
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

class GitError extends Error {
	constructor(
		message: string,
		public readonly command: string,
		public readonly code: number,
	) {
		super(message);
		this.name = "GitError";
	}
}

export async function isGitRepository(pi: ExtensionAPI, cwd?: string): Promise<boolean> {
	const { code } = await pi.exec("git", ["rev-parse", "--git-dir"], { cwd });
	return code === 0;
}

export async function getStatus(pi: ExtensionAPI, cwd?: string): Promise<string> {
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"], { cwd });
	if (code !== 0) {
		throw new GitError("Failed to get git status", "git status --porcelain", code);
	}
	return stdout;
}

export async function getDiff(pi: ExtensionAPI, staged?: boolean, cwd?: string): Promise<string> {
	const args = staged ? ["diff", "--staged"] : ["diff"];
	const { stdout, code } = await pi.exec("git", args, { cwd });
	if (code !== 0) {
		throw new GitError(`Failed to get git diff${staged ? " --staged" : ""}`, `git ${args.join(" ")}`, code);
	}
	return stdout;
}

export async function hasChanges(pi: ExtensionAPI, cwd?: string): Promise<boolean> {
	const status = await getStatus(pi, cwd);
	return status.trim().length > 0;
}

export async function stageFiles(pi: ExtensionAPI, files: string[], cwd?: string): Promise<void> {
	if (files.length === 0) return;
	const { code } = await pi.exec("git", ["add", "--", ...files], { cwd });
	if (code !== 0) {
		throw new GitError(`Failed to stage files: ${files.join(", ")}`, "git add", code);
	}
}

export async function resetStaging(pi: ExtensionAPI, cwd?: string): Promise<void> {
	const { code } = await pi.exec("git", ["reset"], { cwd });
	if (code !== 0) {
		throw new GitError("Failed to reset staging area", "git reset", code);
	}
}

export async function commit(pi: ExtensionAPI, message: string, cwd?: string): Promise<number> {
	const { code } = await pi.exec("git", ["commit", "-m", message], { cwd });
	return code;
}

export async function commitWithNoVerify(pi: ExtensionAPI, message: string, cwd?: string): Promise<number> {
	const { code } = await pi.exec("git", ["commit", "--no-verify", "-m", message], { cwd });
	return code;
}

// ───────────────────────────────────────────────
// Diff & snapshot helpers for /git-diff
// ───────────────────────────────────────────────

/** Snapshot working tree changes via stash to freeze the diff. */
export async function stashSnapshot(pi: ExtensionAPI, cwd?: string): Promise<number> {
	const { code } = await pi.exec("git", ["stash", "push", "-u", "-m", "pi-git-diff-snapshot"], { cwd });
	return code;
}

/** Pop the snapshot stash to restore working tree. */
export async function unstashSnapshot(pi: ExtensionAPI, cwd?: string): Promise<number> {
	const { code } = await pi.exec("git", ["stash", "pop"], { cwd });
	return code;
}

/** Get diff of a snapshot stash. */
export async function getStashDiff(pi: ExtensionAPI, cwd?: string): Promise<string> {
	const { stdout: stashDiff, code: stashCode } = await pi.exec("git", ["stash", "show", "-p", "stash@{0}"], { cwd });
	let diff = stashDiff;
	if (stashCode !== 0) return "";

	// Get untracked files diff from stash (stash@{0}^3 contains untracked files when -u was used)
	const { stdout: untrackedDiff, code: untrackedCode } = await pi.exec("git", ["diff", "HEAD", "stash@{0}^3"], { cwd });
	if (untrackedCode === 0 && untrackedDiff.trim()) {
		diff += (diff ? "\n" : "") + untrackedDiff;
	}
	return diff;
}

/** Get changed files with their status codes. */
export async function getChangedFilesWithStatus(pi: ExtensionAPI, cwd?: string): Promise<{ path: string; status: string }[]> {
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"], { cwd });
	if (code !== 0) return [];
	return stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const status = line.slice(0, 2);
			const path = line.slice(3).trim();
			return { status, path };
		});
}

/** Get unified diff for a specific file (from working tree or staged). */
export async function getFileDiff(pi: ExtensionAPI, file: string, staged?: boolean, cwd?: string): Promise<string> {
	const args = staged ? ["diff", "--staged", "--", file] : ["diff", "--", file];
	const { stdout } = await pi.exec("git", args, { cwd });
	return stdout;
}

/** Stage a single file. */
export async function stageFile(pi: ExtensionAPI, file: string, cwd?: string): Promise<void> {
	const { code } = await pi.exec("git", ["add", "--", file], { cwd });
	if (code !== 0) {
		throw new GitError(`Failed to stage file: ${file}`, "git add", code);
	}
}

/** Unstage files (reset paths). */
export async function unstageFiles(pi: ExtensionAPI, files: string[], cwd?: string): Promise<void> {
	if (files.length === 0) return;
	const { code } = await pi.exec("git", "reset" in {} ? ["reset", "HEAD", "--", ...files] : ["reset", "--", ...files], { cwd });
	if (code !== 0) {
		throw new GitError(`Failed to unstage files: ${files.join(", ")}`, "git reset", code);
	}
}

/** Check if there are staged changes. */
export async function hasStagedChanges(pi: ExtensionAPI, cwd?: string): Promise<boolean> {
	const { stdout, code } = await pi.exec("git", ["diff", "--cached", "--stat"], { cwd });
	if (code !== 0) return false;
	return stdout.trim().length > 0;
}

/** Get diff stat for staged changes. */
export async function getStagedDiffStat(pi: ExtensionAPI, cwd?: string): Promise<string> {
	const { stdout, code } = await pi.exec("git", ["diff", "--cached", "--stat"], { cwd });
	if (code !== 0) return "";
	return stdout;
}

/** Split a unified diff into per-file diffs. */
export function splitDiffByFile(fullDiff: string): Map<string, string> {
	const result = new Map<string, string>();
	const lines = fullDiff.split("\n");
	let currentFile: string | null = null;
	let currentLines: string[] = [];

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			if (currentFile && currentLines.length > 0) {
				result.set(currentFile, currentLines.join("\n"));
			}
			const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
			currentFile = match ? match[2] : null;
			currentLines = [line];
		} else if (currentFile) {
			currentLines.push(line);
		}
	}
	if (currentFile && currentLines.length > 0) {
		result.set(currentFile, currentLines.join("\n"));
	}
	return result;
}
