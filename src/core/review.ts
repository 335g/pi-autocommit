/**
 * Interactive hunk review component for --review mode.
 *
 * Renders an overlay where the user can inspect AI-generated hunks,
 * toggle inclusion, edit commit messages, and confirm/cancel the batch.
 */

import type { Component } from "@earendil-works/pi-tui";
import { Input } from "@earendil-works/pi-tui";
import type { Hunk, ReviewedHunk, ReviewResult } from "../types.js";
import { t } from "../utils/lang.js";

/** Maximum characters for a commit message line before truncation */
const MAX_MESSAGE_DISPLAY = 50;

/** Factory returned by createReviewComponent, compatible with ctx.ui.custom<T>() */
export type ReviewComponentFactory = (
  _tui: unknown,
  _theme: unknown,
  _keybindings: unknown,
  done: (result: ReviewResult) => void,
) => Component & { dispose?(): void };

/**
 * Create a review component factory for use with ctx.ui.custom().
 *
 * @param hunks - AI-generated hunks to review
 * @param lang - Display language ("en" or "ja")
 * @param unstagedFiles - Files not assigned to any hunk (info only)
 */
export function createReviewComponent(
  hunks: Hunk[],
  lang: string,
  unstagedFiles: string[],
): ReviewComponentFactory {
  return (_tui, _theme, _keybindings, done) =>
    new ReviewOverlay(hunks, lang, unstagedFiles, done);
}

// ───────────────────────────────────────────────
// ReviewOverlay — the interactive overlay component
// ───────────────────────────────────────────────

class ReviewOverlay implements Component {
  private reviewedHunks: ReviewedHunk[];
  private selectedIndex: number;
  private lang: string;
  private unstagedFiles: string[];
  private done: (result: ReviewResult) => void;

  /** Index of the hunk being edited, or null if in list mode */
  private editIndex: number | null = null;

  /** Input component active during edit mode */
  private editInput: Input | null = null;

  /** Whether this component still owns keyboard focus */
  private disposed = false;

  constructor(
    hunks: Hunk[],
    lang: string,
    unstagedFiles: string[],
    done: (result: ReviewResult) => void,
  ) {
    this.reviewedHunks = hunks.map((h) => ({ ...h, included: true }));
    this.selectedIndex = 0;
    this.lang = lang;
    this.unstagedFiles = unstagedFiles;
    this.done = done;
  }

  // ── Component interface ──────────────────────────────

  invalidate(): void {
    /* stateless render — no cache to invalidate */
  }

  handleInput(data: string): void {
    if (this.disposed) return;

    // Edit mode: forward all input to the Input component
    if (this.editInput !== null) {
      this.editInput.handleInput(data);
      return;
    }

    // List mode: interpret navigation / action keys
    this.handleListInput(data);
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Title bar
    const title = t(this.lang, "review.title");
    const titleBar = `── ${title} `.padEnd(width, "─");
    lines.push(titleBar);

    // Hunk list
    const maxHunks = Math.max(this.reviewedHunks.length, 4);
    const hasCommitButton = this.hasIncludedHunks();

    // Reserve lines: commit button (2) + separator (1) = 3
    // If unstaged files: unstaged divider (1) + unstaged line (1) = 2
    const reservedLines = 3 + (this.unstagedFiles.length > 0 ? 2 : 0);
    const visibleHunks = Math.min(maxHunks, Math.max(4, 12 - reservedLines));

    // Calculate scroll offset so selectedIndex is always visible
    let scrollOffset = 0;
    if (this.selectedIndex >= visibleHunks) {
      scrollOffset = this.selectedIndex - visibleHunks + 1;
    }
    if (this.selectedIndex < scrollOffset) {
      scrollOffset = this.selectedIndex;
    }

    // Render visible hunks
    for (let i = scrollOffset; i < Math.min(scrollOffset + visibleHunks, this.reviewedHunks.length); i++) {
      lines.push(this.renderHunkLine(i, width));
    }

    // Separator
    lines.push("");

    // Commit button
    if (hasCommitButton) {
      const includedCount = this.reviewedHunks.filter((h) => h.included).length;
      const btnText = t(this.lang, "review.commitButton", {
        count: String(includedCount),
      });
      const isSelected = this.selectedIndex === this.reviewedHunks.length;
      const prefix = isSelected ? "▶ " : "  ";
      const padded = (prefix + btnText).padEnd(width, " ");
      lines.push(padded);
    } else {
      const btnText = t(this.lang, "review.commitButtonNone");
      const padded = ("  " + btnText).padEnd(width, " ");
      lines.push(padded);
    }

    // Unstaged files info
    if (this.unstagedFiles.length > 0) {
      const fileList = this.unstagedFiles.slice(0, 3).join(", ");
      const suffix =
        this.unstagedFiles.length > 3
          ? ` ... (${this.unstagedFiles.length} files)`
          : "";
      const infoText = t(this.lang, "review.unstagedInfo", {
        count: String(this.unstagedFiles.length),
        files: fileList + suffix,
      });
      lines.push("");
      lines.push(`  ⚠ ${infoText}`.substring(0, width));
    }

    // Separator
    lines.push("");

    // Key hints
    const hints =
      this.editInput !== null
        ? t(this.lang, "review.keyHintsEditing")
        : t(this.lang, "review.keyHints");
    lines.push(`  ${hints}`.substring(0, width));

    return lines;
  }

  // ── Render helpers ────────────────────────────────────

  /**
   * Render a single hunk line, or the edit Input if this hunk is being edited.
   */
  private renderHunkLine(index: number, width: number): string {
    // Edit mode: render Input inline
    if (index === this.editIndex && this.editInput) {
      const inputLines = this.editInput.render(width - 2);
      const inputText =
        inputLines.length > 0 ? `> ${inputLines[0]}` : "> ";
      return inputText.substring(0, width);
    }

    const hunk = this.reviewedHunks[index];
    const isSelected = index === this.selectedIndex;
    const cursor = isSelected ? "▶" : " ";

    const check = hunk.included ? "✓" : " ";
    const fileCount = `${hunk.files.length} file${hunk.files.length > 1 ? "s" : ""}`;
    const message = this.truncateMessage(hunk.message);

    const prefix = `${cursor} [${check}] ${fileCount}  `;
    const available = width - prefix.length;
    const msgDisplay =
      available > 10
        ? message.substring(0, available)
        : message.substring(0, width - prefix.length);

    return prefix + msgDisplay;
  }

  private truncateMessage(message: string): string {
    if (message.length <= MAX_MESSAGE_DISPLAY) return message;
    return message.substring(0, MAX_MESSAGE_DISPLAY - 3) + "...";
  }

  // ── Input handling (list mode) ────────────────────────

  private handleListInput(data: string): void {
    const maxIndex = this.hasIncludedHunks()
      ? this.reviewedHunks.length // commit button is selectable
      : this.reviewedHunks.length - 1; // commit button is not selectable

    switch (data) {
      // ── Navigation ──────────────────────────────
      case "j":
      case "\x1b[B": // Arrow Down
        if (this.selectedIndex < maxIndex) {
          this.selectedIndex++;
        }
        return;

      case "k":
      case "\x1b[A": // Arrow Up
        if (this.selectedIndex > 0) {
          this.selectedIndex--;
        }
        return;

      // ── Toggle inclusion ────────────────────────
      case " ":
        if (this.selectedIndex < this.reviewedHunks.length) {
          this.reviewedHunks[this.selectedIndex].included =
            !this.reviewedHunks[this.selectedIndex].included;

          // If all hunks become excluded, move cursor off commit button
          if (
            !this.hasIncludedHunks() &&
            this.selectedIndex === this.reviewedHunks.length
          ) {
            this.selectedIndex = Math.max(0, this.reviewedHunks.length - 1);
          }
        }
        return;

      // ── Edit message ────────────────────────────
      case "e":
        if (this.selectedIndex < this.reviewedHunks.length) {
          this.enterEditMode(this.selectedIndex);
        }
        return;

      // ── Confirm / Cancel ────────────────────────
      case "\r": // Enter
        this.confirm();
        return;

      case "\x1b": // Escape
        this.cancel();
        return;
    }
  }

  // ── Edit mode ─────────────────────────────────────────

  private enterEditMode(index: number): void {
    this.editIndex = index;
    this.editInput = new Input();
    this.editInput.setValue(this.reviewedHunks[index].message);

    this.editInput.onSubmit = (newMessage: string) => {
      if (newMessage.trim()) {
        this.reviewedHunks[index].message = newMessage.trim();
      }
      this.exitEditMode();
    };

    this.editInput.onEscape = () => {
      this.exitEditMode();
    };

    // Input needs focus to render cursor marker
    this.editInput.focused = true;
  }

  private exitEditMode(): void {
    if (this.editInput) {
      this.editInput.focused = false;
    }
    this.editInput = null;
    this.editIndex = null;
  }

  // ── Commit / Cancel ───────────────────────────────────

  private confirm(): void {
    // Enter only commits when the commit button is selected
    if (this.selectedIndex === this.reviewedHunks.length) {
      if (!this.hasIncludedHunks()) return;
      this.disposed = true;
      this.done({ hunks: [...this.reviewedHunks], cancelled: false });
      return;
    }
    // Enter on a hunk: enter edit mode (convenience alternative to 'e')
    this.enterEditMode(this.selectedIndex);
  }

  private cancel(): void {
    this.disposed = true;
    this.done({ hunks: [...this.reviewedHunks], cancelled: true });
  }

  // ── Helpers ───────────────────────────────────────────

  private hasIncludedHunks(): boolean {
    return this.reviewedHunks.some((h) => h.included);
  }

  dispose?(): void {
    this.disposed = true;
  }
}
