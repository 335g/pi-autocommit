/**
 * Hunk review TUI component
 * 
 * Displays a hunk with its files and commit message, allowing the user to:
 * - Navigate through files
 * - View diff for each file
 * - Approve, skip, or exclude files
 * - Edit the commit message
 */

import type { Component } from "@earendil-works/pi-tui";
import {
  Container,
  Text,
  matchesKey,
  Key,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { FileStats, Hunk } from "../types.js";

export type HunkReviewAction =
  | { type: "approve"; message: string; excludedFiles: string[] }
  | { type: "edit_message"; currentMessage: string; excludedFiles: string[] }
  | { type: "skip"; excludedFiles: string[] }
  | { type: "quit" };

export class HunkReviewComponent implements Component {
  private container: Container;
  private selectedIndex = 0;
  private excludedFiles: Set<string> = new Set();
  private mode: "list" | "diff" = "list";
  private diffScrollOffset = 0;

  constructor(
    private hunk: Hunk,
    private hunkIndex: number,
    private totalHunks: number,
    private fileStats: Map<string, FileStats>,
    private fileDiffs: Map<string, string[]>,
    private tui: any,
    private theme: any,
    private onComplete: (action: HunkReviewAction) => void,
  ) {
    this.container = new Container();
    this.renderList();
  }

  private renderList(): void {
    this.container.clear();

    const border = new DynamicBorder((s: string) => this.theme.fg("border", s));
    this.container.addChild(border);

    // Header
    const header = this.theme.fg(
      "accent",
      this.theme.bold(`Hunk ${this.hunkIndex + 1}/${this.totalHunks}`),
    );
    this.container.addChild(new Text(header, 1, 0));

    // Commit message
    const messageLabel = this.theme.fg("muted", "Message: ");
    const messageText = this.theme.fg("text", this.hunk.message);
    this.container.addChild(new Text(messageLabel + messageText, 1, 0));

    // Empty line
    this.container.addChild(new Text("", 0, 0));

    // File list
    const files = this.hunk.files.filter((f) => !this.excludedFiles.has(f));
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const stats = this.fileStats.get(file);
      const isSelected = i === this.selectedIndex;

      let line = "";
      if (isSelected) {
        line += this.theme.fg("accent", "● ");
      } else {
        line += "  ";
      }

      line += this.theme.fg("text", file);

      if (stats) {
        const statsText = ` +${stats.additions} -${stats.deletions}`;
        line += this.theme.fg("muted", statsText);
      }

      this.container.addChild(new Text(line, 1, 0));
    }

    // Empty line
    this.container.addChild(new Text("", 0, 0));

    // Help text - keybindings
    const helpLines = [
      this.theme.fg("muted", "Navigation:"),
      this.theme.fg("text", "  ↑↓        ") + this.theme.fg("muted", "Navigate files"),
      this.theme.fg("text", "  Enter     ") + this.theme.fg("muted", "View diff"),
      this.theme.fg("muted", "Actions:"),
      this.theme.fg("text", "  a         ") + this.theme.fg("muted", "Approve & commit"),
      this.theme.fg("text", "  e         ") + this.theme.fg("muted", "Edit message"),
      this.theme.fg("text", "  x         ") + this.theme.fg("muted", "Exclude file"),
      this.theme.fg("text", "  s         ") + this.theme.fg("muted", "Skip hunk"),
      this.theme.fg("text", "  q         ") + this.theme.fg("muted", "Quit"),
    ];

    for (const line of helpLines) {
      this.container.addChild(new Text(line, 1, 0));
    }

    this.container.addChild(border);
  }

  private renderDiff(): void {
    this.container.clear();

    const files = this.hunk.files.filter((f) => !this.excludedFiles.has(f));
    const file = files[this.selectedIndex];
    if (!file) {
      this.mode = "list";
      this.renderList();
      return;
    }

    const diffLines = this.fileDiffs.get(file) || [];

    const border = new DynamicBorder((s: string) => this.theme.fg("border", s));
    this.container.addChild(border);

    // Header
    const header = this.theme.fg(
      "accent",
      this.theme.bold(`Diff: ${file}`),
    );
    this.container.addChild(new Text(header, 1, 0));

    // Empty line
    this.container.addChild(new Text("", 0, 0));

    // Diff content (with scrolling)
    const visibleLines = 20; // TODO: calculate from terminal height
    const start = this.diffScrollOffset;
    const end = Math.min(start + visibleLines, diffLines.length);

    for (let i = start; i < end; i++) {
      const line = diffLines[i];
      let colored = line;

      if (line.startsWith("+")) {
        colored = this.theme.fg("toolDiffAdded", line);
      } else if (line.startsWith("-")) {
        colored = this.theme.fg("toolDiffRemoved", line);
      } else {
        colored = this.theme.fg("toolDiffContext", line);
      }

      this.container.addChild(new Text(colored, 1, 0));
    }

    // Scroll indicator
    if (diffLines.length > visibleLines) {
      const scrollInfo = this.theme.fg(
        "muted",
        `Lines ${start + 1}-${end} of ${diffLines.length}`,
      );
      this.container.addChild(new Text(scrollInfo, 1, 0));
    }

    // Empty line
    this.container.addChild(new Text("", 0, 0));

    // Help text - keybindings
    const helpLines = [
      this.theme.fg("muted", "Navigation:"),
      this.theme.fg("text", "  ↑↓        ") + this.theme.fg("muted", "Scroll line by line"),
      this.theme.fg("text", "  Shift+↑↓  ") + this.theme.fg("muted", "Scroll ¾ page"),
      this.theme.fg("text", "  Home/End  ") + this.theme.fg("muted", "Jump to top/bottom"),
      this.theme.fg("text", "  Esc       ") + this.theme.fg("muted", "Back to file list"),
    ];

    for (const line of helpLines) {
      this.container.addChild(new Text(line, 1, 0));
    }

    this.container.addChild(border);
  }

  render(width: number): string[] {
    return this.container
      .render(width)
      .map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    if (this.mode === "list") {
      this.handleListInput(data);
    } else {
      this.handleDiffInput(data);
    }
  }

  private handleListInput(data: string): void {
    const files = this.hunk.files.filter((f) => !this.excludedFiles.has(f));

    if (matchesKey(data, Key.up)) {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.renderList();
        this.tui.requestRender();
      }
    } else if (matchesKey(data, Key.down)) {
      if (this.selectedIndex < files.length - 1) {
        this.selectedIndex++;
        this.renderList();
        this.tui.requestRender();
      }
    } else if (matchesKey(data, Key.enter)) {
      // Switch to diff view
      if (files.length > 0) {
        this.mode = "diff";
        this.diffScrollOffset = 0;
        this.renderDiff();
        this.tui.requestRender();
      }
    } else if (data === "a") {
      // Approve
      this.onComplete({
        type: "approve",
        message: this.hunk.message,
        excludedFiles: Array.from(this.excludedFiles),
      });
    } else if (data === "e") {
      // Edit message
      this.onComplete({
        type: "edit_message",
        currentMessage: this.hunk.message,
        excludedFiles: Array.from(this.excludedFiles),
      });
    } else if (data === "s") {
      // Skip
      this.onComplete({
        type: "skip",
        excludedFiles: Array.from(this.excludedFiles),
      });
    } else if (data === "x") {
      // Exclude selected file
      if (files.length > 0) {
        const file = files[this.selectedIndex];
        this.excludedFiles.add(file);

        // Adjust selection if needed
        const newFiles = this.hunk.files.filter(
          (f) => !this.excludedFiles.has(f),
        );
        if (this.selectedIndex >= newFiles.length && this.selectedIndex > 0) {
          this.selectedIndex--;
        }

        // If all files excluded, auto-skip
        if (newFiles.length === 0) {
          this.onComplete({
            type: "skip",
            excludedFiles: Array.from(this.excludedFiles),
          });
          return;
        }

        this.renderList();
        this.tui.requestRender();
      }
    } else if (data === "q") {
      // Quit
      this.onComplete({ type: "quit" });
    }
  }

  private handleDiffInput(data: string): void {
    const files = this.hunk.files.filter((f) => !this.excludedFiles.has(f));
    const file = files[this.selectedIndex];
    if (!file) {
      this.mode = "list";
      this.renderList();
      this.tui.requestRender();
      return;
    }

    const diffLines = this.fileDiffs.get(file) || [];
    const visibleLines = 20;

    if (matchesKey(data, Key.up)) {
      if (this.diffScrollOffset > 0) {
        this.diffScrollOffset--;
        this.renderDiff();
        this.tui.requestRender();
      }
    } else if (matchesKey(data, Key.down)) {
      if (this.diffScrollOffset < diffLines.length - visibleLines) {
        this.diffScrollOffset++;
        this.renderDiff();
        this.tui.requestRender();
      }
    } else if (matchesKey(data, Key.shift("up"))) {
      if (this.diffScrollOffset > 0) {
        const jump = Math.floor(visibleLines * 3 / 4);
        this.diffScrollOffset = Math.max(0, this.diffScrollOffset - jump);
        this.renderDiff();
        this.tui.requestRender();
      }
    } else if (matchesKey(data, Key.shift("down"))) {
      if (this.diffScrollOffset < diffLines.length - visibleLines) {
        const jump = Math.floor(visibleLines * 3 / 4);
        this.diffScrollOffset = Math.min(
          diffLines.length - visibleLines,
          this.diffScrollOffset + jump,
        );
        this.renderDiff();
        this.tui.requestRender();
      }
    } else if (matchesKey(data, Key.home)) {
      if (this.diffScrollOffset > 0) {
        this.diffScrollOffset = 0;
        this.renderDiff();
        this.tui.requestRender();
      }
    } else if (matchesKey(data, Key.end)) {
      const maxOffset = Math.max(0, diffLines.length - visibleLines);
      if (this.diffScrollOffset < maxOffset) {
        this.diffScrollOffset = maxOffset;
        this.renderDiff();
        this.tui.requestRender();
      }
    } else if (matchesKey(data, Key.escape)) {
      // Back to list
      this.mode = "list";
      this.renderList();
      this.tui.requestRender();
    }
  }

  invalidate(): void {
    this.container.invalidate();
  }
}
