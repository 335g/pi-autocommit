/**
 * /git-diff command
 *
 * Interactive diff review with AI-assisted hunk decomposition.
 * Displays a file tree (left), diff viewer (right), and commit controls.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Hunk } from "../types.js";
import {
	isGitRepository,
	hasChanges,
	stashSnapshot,
	unstashSnapshot,
	getStashDiff,
	getChangedFilesWithStatus,
	stageFiles,
	commit,
	splitDiffByFile,
} from "../core/git.js";
import { analyzeDiff } from "../core/diff-analyzer.js";
import { sanitizeHunk } from "../core/commit-message.js";
import { getLanguage } from "../utils/settings.js";

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

interface FileEntry {
	path: string;
	status: string; // 2-char git status code, e.g. "M ", "??"
	inHunk: boolean;
}

interface ViewerState {
	hunks: Hunk[];
	currentHunkIdx: number;
	unassigned: Set<string>;
	files: FileEntry[];
	selectedFileIdx: number;
	fileDiffs: Map<string, string>;
	messageEditMode: boolean;
	editBuffer: string;
	editCursor: number;
	statusMsg: string | null;
	errorMsg: string | null;
	showHelp: boolean;
	done: boolean;
	committed: boolean;
	isProcessing: boolean;
}

// ───────────────────────────────────────────────
// ANSI helpers
// ───────────────────────────────────────────────

const ESC = "\x1b[";

function dim(s: string): string { return `${ESC}2m${s}${ESC}0m`; }
function bold(s: string): string { return `${ESC}1m${s}${ESC}0m`; }
function fgGreen(s: string): string { return `${ESC}32m${s}${ESC}0m`; }
function fgRed(s: string): string { return `${ESC}31m${s}${ESC}0m`; }
function fgYellow(s: string): string { return `${ESC}33m${s}${ESC}0m`; }
function fgCyan(s: string): string { return `${ESC}36m${s}${ESC}0m`; }
function bgSelected(s: string): string { return `${ESC}7m${s}${ESC}0m`; }

function visibleLen(s: string): number {
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padOrTruncate(s: string, width: number): string {
	const len = visibleLen(s);
	if (len > width) {
		const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
		return plain.slice(0, Math.max(0, width - 3)) + "...";
	}
	return s + " ".repeat(Math.max(0, width - len));
}

// ───────────────────────────────────────────────
// DiffViewer Component
// ───────────────────────────────────────────────

class DiffViewer implements Component {
	private state: ViewerState;
	private cwd: string;
	private pi: ExtensionAPI;
	private ctx: ExtensionContext;
	private lang: string;
	private isJa: boolean;
	private tui?: TUI;
	private onDone?: () => void;

	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		lang: string,
		hunks: Hunk[],
		changedFiles: { path: string; status: string }[],
		fileDiffs: Map<string, string>,
		cwd: string,
	) {
		this.pi = pi;
		this.ctx = ctx;
		this.cwd = cwd;
		this.lang = lang;
		this.isJa = lang === "ja" || lang === "ja-JP" || lang === "japanese";

		const allPaths = new Set(changedFiles.map((f) => f.path));
		const firstHunk = hunks[0];
		const hunkPaths = new Set(firstHunk?.files ?? []);
		const unassigned = new Set<string>();
		for (const p of allPaths) {
			if (!hunkPaths.has(p)) unassigned.add(p);
		}

		const files: FileEntry[] = changedFiles.map((f) => ({
			path: f.path,
			status: f.status,
			inHunk: hunkPaths.has(f.path),
		}));

		this.state = {
			hunks,
			currentHunkIdx: 0,
			unassigned,
			files,
			selectedFileIdx: 0,
			fileDiffs,
			messageEditMode: false,
			editBuffer: firstHunk?.message ?? "",
			editCursor: (firstHunk?.message ?? "").length,
			statusMsg: null,
			errorMsg: null,
			showHelp: false,
			done: false,
			committed: false,
			isProcessing: false,
		};
	}

	setTUI(tui: TUI): void {
		this.tui = tui;
	}

	setOnDone(fn: () => void): void {
		this.onDone = fn;
	}

	private requestRender(): void {
		this.tui?.requestRender();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	// ── Render ──

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines = this.buildLines(width);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private buildLines(width: number): string[] {
		if (this.state.showHelp) {
			return this.buildHelpLines(width);
		}

		const treeWidth = Math.min(35, Math.max(20, Math.floor(width * 0.28)));
		const diffWidth = Math.max(10, width - treeWidth - 1);

		const lines: string[] = [];

		// 1. Top bar: commit message + file count
		lines.push(...this.renderTopBar(width));

		// 2. Separator
		lines.push("─".repeat(width));

		// 3. Content area: tree + diff side by side
		const treeLines = this.renderTree(treeWidth);
		const diffLines = this.renderDiff(diffWidth);

		const maxContentLines = Math.max(treeLines.length, diffLines.length);
		for (let i = 0; i < maxContentLines; i++) {
			const treeLine = treeLines[i] ?? "";
			const diffLine = diffLines[i] ?? "";
			const divider = "│";
			const combined = padOrTruncate(treeLine, treeWidth) + divider + padOrTruncate(diffLine, diffWidth).slice(0, diffWidth);
			lines.push(truncateToWidth(combined, width));
		}

		// 4. Bottom separator
		lines.push("─".repeat(width));

		// 5. Guide / status
		lines.push(...this.renderGuide(width));

		return lines;
	}

	private renderTopBar(width: number): string[] {
		const hunk = this.state.hunks[this.state.currentHunkIdx];
		const totalFiles = this.state.files.length;
		const hunkFiles = this.state.files.filter((f) => f.inHunk).length;

		let message = hunk?.message ?? "";
		if (this.state.messageEditMode) {
			message = this.state.editBuffer;
		}

		const prefix = this.isJa ? "コミット: " : "Commit: ";
		const msgLine = prefix + message;
		const countText = this.isJa
			? ` (${hunkFiles}/${totalFiles} ファイル)`
			: ` (${hunkFiles}/${totalFiles} files)`;

		const msgLen = visibleLen(msgLine);
		const countLen = visibleLen(countText);
		let line1: string;
		if (msgLen + countLen > width) {
			line1 = truncateToWidth(msgLine, width - countLen) + countText;
		} else {
			line1 = msgLine + " ".repeat(width - msgLen - countLen) + countText;
		}

		if (this.state.messageEditMode) {
			// Show cursor in edit mode: rebuild with cursor at editCursor position
			const plainPrefix = prefix;
			const cursorPos = plainPrefix.length + this.state.editCursor;
			const before = line1.slice(0, cursorPos);
			const at = line1.slice(cursorPos, cursorPos + 1) || " ";
			const after = line1.slice(cursorPos + 1);
			line1 = before + `${ESC}7m${at}${ESC}0m` + after;
		}

		return [line1];
	}

	private renderTree(width: number): string[] {
		const lines: string[] = [];
		const hunkNum = this.state.currentHunkIdx + 1;
		const hunkTotal = this.state.hunks.length;
		const title = this.isJa
			? ` ファイル (${hunkNum}/${hunkTotal})`
			: ` Files (${hunkNum}/${hunkTotal})`;
		lines.push(bold(truncateToWidth(title, width)));
		lines.push("");

		for (let i = 0; i < this.state.files.length; i++) {
			const f = this.state.files[i];
			const isSelected = i === this.state.selectedFileIdx;
			const statusChar = this.statusChar(f.status);
			const prefix = f.inHunk ? "● " : "○ ";
			const label = prefix + statusChar + " " + f.path;

			let styled: string;
			if (!f.inHunk) {
				styled = dim(label);
			} else if (f.status.startsWith("A") || f.status.endsWith("A")) {
				styled = fgGreen(label);
			} else if (f.status.startsWith("D") || f.status.endsWith("D")) {
				styled = fgRed(label);
			} else if (f.status.startsWith("M") || f.status.endsWith("M") || f.status === "??") {
				styled = fgYellow(label);
			} else {
				styled = label;
			}

			if (isSelected) {
				styled = bgSelected(styled);
			}

			lines.push(truncateToWidth(styled, width));
		}

		return lines;
	}

	private statusChar(status: string): string {
		if (status === "??") return "?";
		if (status.startsWith("A")) return "A";
		if (status.startsWith("M")) return "M";
		if (status.startsWith("D")) return "D";
		if (status.startsWith("R")) return "R";
		if (status.startsWith("C")) return "C";
		return status.trim().charAt(0) || " ";
	}

	private renderDiff(width: number): string[] {
		const file = this.state.files[this.state.selectedFileIdx];
		if (!file) return [];

		const lines: string[] = [];
		const title = this.isJa ? " 差分: " : " Diff: ";
		lines.push(bold(truncateToWidth(title + file.path, width)));
		lines.push("");

		const diff = this.state.fileDiffs.get(file.path);
		if (!diff) {
			lines.push(this.isJa ? " 差分を読み込み中..." : " Loading diff...");
			return lines;
		}

		if (diff.startsWith("差分なし") || diff.startsWith("No diff") || diff.startsWith("差分の取得に失敗")) {
			lines.push(" " + diff);
			return lines;
		}

		const diffLines = diff.split("\n");
		for (const line of diffLines) {
			let styled: string;
			if (line.startsWith("+")) {
				styled = fgGreen(truncateToWidth(line, width));
			} else if (line.startsWith("-")) {
				styled = fgRed(truncateToWidth(line, width));
			} else if (line.startsWith("@@")) {
				styled = fgCyan(truncateToWidth(line, width));
			} else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("Binary ")) {
				styled = dim(truncateToWidth(line, width));
			} else {
				styled = truncateToWidth(line, width);
			}
			lines.push(styled);
		}

		return lines;
	}

	private renderGuide(width: number): string[] {
		if (this.state.errorMsg) {
			return [fgRed(truncateToWidth(this.state.errorMsg, width))];
		}
		if (this.state.statusMsg) {
			return [truncateToWidth(this.state.statusMsg, width)];
		}
		if (this.state.messageEditMode) {
			const guide = this.isJa
				? "Enter:確定  Escape:キャンセル  ←→:カーソル"
				: "Enter:confirm  Escape:cancel  ←→:cursor";
			return [truncateToWidth(guide, width)];
		}
		const guide = this.isJa
			? "↑↓:移動  Space:選択  c:コミット  s:スキップ  n:次のhunk  e:編集  q:終了  ?:ヘルプ"
			: "↑↓:move  Space:toggle  c:commit  s:skip  n:next hunk  e:edit  q:quit  ?:help";
		return [truncateToWidth(guide, width)];
	}

	private buildHelpLines(width: number): string[] {
		const lines: string[] = [];
		const title = this.isJa ? " キーバインド" : " Keybindings";
		lines.push(bold(title));
		lines.push("");

		const bindings = this.isJa ? [
			"↑ / ↓        ファイルツリーの移動",
			"Space        ファイルをhunkに含める/含めないをトグル",
			"c            現在のhunkをコミット",
			"s            現在のhunkをスキップ",
			"n            残りの変更で次のhunk候補を生成",
			"a            未割り当てファイルをすべて現在のhunkに追加",
			"r            現在のhunkからすべてのファイルを除外",
			"e            コミットメッセージを編集",
			"Enter        編集モードでメッセージを確定",
			"Escape       編集モードをキャンセル",
			"q / Escape   git-diffを終了",
			"?            このヘルプを表示/非表示",
		] : [
			"↑ / ↓        Move in file tree",
			"Space        Toggle file in/out of current hunk",
			"c            Commit current hunk",
			"s            Skip current hunk",
			"n            Generate next hunk from remaining changes",
			"a            Add all unassigned files to current hunk",
			"r            Remove all files from current hunk",
			"e            Edit commit message",
			"Enter        Confirm message in edit mode",
			"Escape       Cancel edit mode",
			"q / Escape   Quit git-diff",
			"?            Toggle this help",
		];

		for (const b of bindings) {
			lines.push("  " + truncateToWidth(b, width - 2));
		}
		lines.push("");
		lines.push(truncateToWidth(this.isJa ? " どのキーを押してもヘルプを閉じます" : " Press any key to close help", width));
		return lines;
	}

	// ── Input handling ──

	handleInput(data: string): void {
		if (this.state.isProcessing) return;

		if (this.state.showHelp) {
			this.state.showHelp = false;
			this.invalidate();
			this.requestRender();
			return;
		}

		if (this.state.messageEditMode) {
			this.handleEditModeInput(data);
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1);
		} else if (matchesKey(data, Key.down)) {
			this.moveSelection(1);
		} else if (matchesKey(data, Key.space)) {
			this.toggleFileInHunk();
		} else if (data === "c" || data === "C") {
			void this.commitHunk();
		} else if (data === "s" || data === "S") {
			void this.skipHunk();
		} else if (data === "n" || data === "N") {
			void this.nextHunk();
		} else if (data === "a" || data === "A") {
			this.addAllToHunk();
		} else if (data === "r" || data === "R") {
			this.removeAllFromHunk();
		} else if (data === "e" || data === "E") {
			this.enterEditMode();
		} else if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.quit();
		} else if (data === "?") {
			this.state.showHelp = true;
			this.invalidate();
			this.requestRender();
		}
	}

	private handleEditModeInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			const hunk = this.state.hunks[this.state.currentHunkIdx];
			if (hunk) {
				hunk.message = this.state.editBuffer;
			}
			this.state.messageEditMode = false;
			this.state.statusMsg = this.isJa ? "メッセージを更新しました" : "Message updated";
			this.invalidate();
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.state.messageEditMode = false;
			this.invalidate();
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
			if (this.state.editCursor > 0) {
				this.state.editBuffer = this.state.editBuffer.slice(0, this.state.editCursor - 1) + this.state.editBuffer.slice(this.state.editCursor);
				this.state.editCursor--;
				this.invalidate();
				this.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.left)) {
			if (this.state.editCursor > 0) {
				this.state.editCursor--;
				this.invalidate();
				this.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.right)) {
			if (this.state.editCursor < this.state.editBuffer.length) {
				this.state.editCursor++;
				this.invalidate();
				this.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.state.editCursor = 0;
			this.invalidate();
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.state.editCursor = this.state.editBuffer.length;
			this.invalidate();
			this.requestRender();
			return;
		}

		// Insert printable character
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.state.editBuffer = this.state.editBuffer.slice(0, this.state.editCursor) + data + this.state.editBuffer.slice(this.state.editCursor);
			this.state.editCursor++;
			this.invalidate();
			this.requestRender();
		}
	}

	private moveSelection(delta: number): void {
		const newIdx = this.state.selectedFileIdx + delta;
		if (newIdx >= 0 && newIdx < this.state.files.length) {
			this.state.selectedFileIdx = newIdx;
			this.invalidate();
			this.requestRender();
		}
	}

	private toggleFileInHunk(): void {
		const file = this.state.files[this.state.selectedFileIdx];
		if (!file) return;
		file.inHunk = !file.inHunk;
		if (file.inHunk) {
			this.state.unassigned.delete(file.path);
		} else {
			this.state.unassigned.add(file.path);
		}
		const hunk = this.state.hunks[this.state.currentHunkIdx];
		if (hunk) {
			hunk.files = this.state.files.filter((f) => f.inHunk).map((f) => f.path);
		}
		this.invalidate();
		this.requestRender();
	}

	private addAllToHunk(): void {
		for (const f of this.state.files) {
			f.inHunk = true;
			this.state.unassigned.delete(f.path);
		}
		const hunk = this.state.hunks[this.state.currentHunkIdx];
		if (hunk) {
			hunk.files = this.state.files.map((f) => f.path);
		}
		this.invalidate();
		this.requestRender();
	}

	private removeAllFromHunk(): void {
		for (const f of this.state.files) {
			f.inHunk = false;
			this.state.unassigned.add(f.path);
		}
		const hunk = this.state.hunks[this.state.currentHunkIdx];
		if (hunk) {
			hunk.files = [];
		}
		this.invalidate();
		this.requestRender();
	}

	private enterEditMode(): void {
		const hunk = this.state.hunks[this.state.currentHunkIdx];
		if (!hunk) return;
		this.state.editBuffer = hunk.message;
		this.state.editCursor = hunk.message.length;
		this.state.messageEditMode = true;
		this.invalidate();
		this.requestRender();
	}

	private async commitHunk(): Promise<void> {
		if (this.state.isProcessing) return;
		const hunk = this.state.hunks[this.state.currentHunkIdx];
		if (!hunk || hunk.files.length === 0) {
			this.state.errorMsg = this.isJa ? "コミットするファイルがありません" : "No files to commit";
			this.invalidate();
			this.requestRender();
			return;
		}

		this.state.isProcessing = true;
		this.state.statusMsg = this.isJa ? "コミット中..." : "Committing...";
		this.state.errorMsg = null;
		this.invalidate();
		this.requestRender();

		try {
			await stageFiles(this.pi, hunk.files, this.cwd);
			const exitCode = await commit(this.pi, hunk.message, this.cwd);
			if (exitCode !== 0) {
				this.state.errorMsg = this.isJa
					? `コミットに失敗しました (exit ${exitCode})`
					: `Commit failed (exit ${exitCode})`;
				this.state.statusMsg = null;
				this.state.isProcessing = false;
				this.invalidate();
				this.requestRender();
				return;
			}

			// Success: remove committed files from the list
			for (const fp of hunk.files) {
				this.state.unassigned.delete(fp);
			}
			this.state.committed = true;

			this.state.files = this.state.files.filter((f) => !hunk.files.includes(f.path));
			this.state.selectedFileIdx = Math.min(this.state.selectedFileIdx, this.state.files.length - 1);
			this.state.selectedFileIdx = Math.max(0, this.state.selectedFileIdx);

			if (this.state.files.length === 0) {
				this.state.statusMsg = this.isJa ? "すべてコミットしました" : "All changes committed";
				this.invalidate();
				this.requestRender();
				await this.delay(800);
				this.state.isProcessing = false;
				this.quit();
				return;
			}

			this.state.statusMsg = this.isJa
				? `コミットしました: ${hunk.message}`
				: `Committed: ${hunk.message}`;
			this.invalidate();
			this.requestRender();
			await this.delay(1000);

			await this.proceedToNextHunk();
		} catch (err) {
			this.state.errorMsg = String(err);
			this.state.statusMsg = null;
			this.state.isProcessing = false;
			this.invalidate();
			this.requestRender();
		}
	}

	private async skipHunk(): Promise<void> {
		if (this.state.isProcessing) return;
		const hunk = this.state.hunks[this.state.currentHunkIdx];
		if (hunk) {
			for (const fp of hunk.files) {
				this.state.unassigned.add(fp);
			}
		}
		await this.proceedToNextHunk();
	}

	private async nextHunk(): Promise<void> {
		if (this.state.isProcessing) return;
		if (this.state.unassigned.size === 0) {
			this.state.errorMsg = this.isJa ? "未割り当てファイルがありません" : "No unassigned files";
			this.invalidate();
			this.requestRender();
			return;
		}
		await this.proceedToNextHunk();
	}

	private async proceedToNextHunk(): Promise<void> {
		if (this.state.isProcessing) return;
		this.state.isProcessing = true;

		if (this.state.files.length === 0) {
			this.state.isProcessing = false;
			this.quit();
			return;
		}

		// Mark current files based on inHunk flag
		for (const f of this.state.files) {
			if (!f.inHunk) {
				this.state.unassigned.add(f.path);
			}
		}

		// If there are unassigned files, re-analyze
		if (this.state.unassigned.size > 0) {
			this.state.statusMsg = this.isJa ? "残りを解析中..." : "Analyzing remaining...";
			this.state.errorMsg = null;
			this.invalidate();
			this.requestRender();

			try {
				const unassignedPaths = Array.from(this.state.unassigned);
				// Build a synthetic diff for remaining files from cached diffs
				let remainingDiff = "";
				for (const path of unassignedPaths) {
					const diff = this.state.fileDiffs.get(path) || "";
					if (diff) remainingDiff += diff + "\n";
				}

				if (!remainingDiff.trim()) {
					this.state.isProcessing = false;
					this.quit();
					return;
				}

				const newHunks = await analyzeDiff(this.pi, this.ctx, remainingDiff);
				let hunks: Hunk[];
				if (newHunks.length === 0) {
					hunks = [{
						files: unassignedPaths,
						message: this.isJa ? "chore: 残りの変更" : "chore: remaining changes",
					}];
				} else {
					hunks = newHunks.map(sanitizeHunk);
				}

				// Deduplicate files across hunks
				const seen = new Set<string>();
				hunks = hunks
					.map((h) => ({
						...h,
						files: h.files.filter((f) => {
							if (seen.has(f)) return false;
							seen.add(f);
							return true;
						}),
					}))
					.filter((h) => h.files.length > 0);

				this.state.hunks = hunks;
				this.state.currentHunkIdx = 0;

				// Update file entries
				const firstHunkPaths = new Set(hunks[0]?.files ?? []);
				for (const f of this.state.files) {
					f.inHunk = firstHunkPaths.has(f.path);
					if (f.inHunk) this.state.unassigned.delete(f.path);
					else this.state.unassigned.add(f.path);
				}
				this.state.selectedFileIdx = 0;
				this.state.editBuffer = hunks[0]?.message ?? "";
				this.state.editCursor = this.state.editBuffer.length;
			} catch (err) {
				this.state.errorMsg = String(err);
			}
		} else {
			this.state.isProcessing = false;
			this.quit();
			return;
		}

		this.state.statusMsg = null;
		this.state.isProcessing = false;
		this.invalidate();
		this.requestRender();
	}

	private quit(): void {
		this.state.done = true;
		this.onDone?.();
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

// ───────────────────────────────────────────────
// Command handler
// ───────────────────────────────────────────────

export async function handleDiff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: string,
): Promise<void> {
	const lang = getLanguage(ctx.cwd);
	const isJa = lang === "ja" || lang === "ja-JP" || lang === "japanese";

	if (/--help/.test(args)) {
		const lines = isJa
			? [
					"/git-diff [--lang=<lang>] [--help]",
					"",
					"インタラクティブな差分レビューとコミット",
					"",
					"オプション:",
					"  --lang=<lang>  一時的に言語を上書き（保存されません）",
					"  --help         このヘルプを表示",
				]
			: [
					"/git-diff [--lang=<lang>] [--help]",
					"",
					"Interactive diff review and commit",
					"",
					"Options:",
					"  --lang=<lang>  Temporarily override language (not saved)",
					"  --help         Show this help message",
				];
		if (ctx.hasUI) {
			ctx.ui.notify(lines.join("\n"), "info");
		}
		return;
	}

	// Parse language argument
	const langMatch = args.match(/--lang(?:uage)?[\s=]+(\S+)/);
	const runLang = langMatch?.[1] || lang;
	const runIsJa = runLang === "ja" || runLang === "ja-JP" || runLang === "japanese";

	// 1. Check git repository
	if (!(await isGitRepository(pi, ctx.cwd))) {
		if (ctx.hasUI) {
			ctx.ui.notify(runIsJa ? "Gitリポジトリではありません" : "Not a git repository", "warning");
		}
		return;
	}

	// 2. Check for changes
	if (!(await hasChanges(pi, ctx.cwd))) {
		if (ctx.hasUI) {
			ctx.ui.notify(runIsJa ? "変更がありません" : "No changes", "info");
		}
		return;
	}

	if (!ctx.hasUI) {
		return;
	}

	const STATUS_ID = "pi-git-diff";
	ctx.ui.setStatus(STATUS_ID, runIsJa ? "[pi-git] diffを準備中..." : "[pi-git] Preparing diff...");

	// 3. Snapshot changes via stash
	const stashCode = await stashSnapshot(pi, ctx.cwd);
	if (stashCode !== 0) {
		ctx.ui.setStatus(STATUS_ID, "");
		ctx.ui.notify(runIsJa ? "stashに失敗しました" : "Failed to stash changes", "warning");
		return;
	}

	try {
		// 4. Get diff and changed files
		ctx.ui.setStatus(STATUS_ID, runIsJa ? "[pi-git] diffを収集中..." : "[pi-git] Collecting diff...");
		const diff = await getStashDiff(pi, ctx.cwd);
		const changedFiles = await getChangedFilesWithStatus(pi, ctx.cwd);

		if (!diff.trim() || changedFiles.length === 0) {
			ctx.ui.setStatus(STATUS_ID, "");
			ctx.ui.notify(runIsJa ? "変更がありません" : "No changes", "info");
			return;
		}

		// Pre-split diff by file for the viewer
		const fileDiffs = splitDiffByFile(diff);

		// 5. Analyze diff into hunks
		ctx.ui.setStatus(STATUS_ID, runIsJa ? "[pi-git] hunkを解析中..." : "[pi-git] Analyzing hunks...");
		let hunks = await analyzeDiff(pi, ctx, diff);
		if (hunks.length === 0) {
			hunks = [{
				files: changedFiles.map((f) => f.path),
				message: runIsJa ? "chore: 変更の更新" : "chore: update changes",
			}];
		}

		// Sanitize and deduplicate
		hunks = hunks.map(sanitizeHunk);
		const seenFiles = new Set<string>();
		hunks = hunks
			.map((h) => ({
				...h,
				files: h.files.filter((f) => {
					if (seenFiles.has(f)) return false;
					seenFiles.add(f);
					return true;
				}),
			}))
			.filter((h) => h.files.length > 0);

		ctx.ui.setStatus(STATUS_ID, "");

		// 6. Show interactive diff viewer
		await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
			const viewer = new DiffViewer(pi, ctx, runLang, hunks, changedFiles, fileDiffs, ctx.cwd);
			viewer.setTUI(tui);
			viewer.setOnDone(() => {
				done(undefined);
			});
			return viewer;
		}, {
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "100%",
				margin: 0,
			},
		});
	} finally {
		// 7. Always pop stash
		await unstashSnapshot(pi, ctx.cwd);
		ctx.ui.setStatus(STATUS_ID, "");
	}
}
