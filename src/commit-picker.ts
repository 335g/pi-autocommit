import {
  DynamicBorder,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  matchesKey,
  Key,
  truncateToWidth,
} from "@earendil-works/pi-tui";

// ── Public types ─────────────────────────────────────────

/** A single commit entry in the picker list. */
export interface CommitItem {
  sha: string;
  subject: string;
  isCheckpoint: boolean;
}

/** Index range the user selected, 0-based from HEAD. */
export interface PickerResult {
  /** Start index (inclusive) — closer to HEAD. */
  startIndex: number;
  /** End index (inclusive) — further from HEAD. */
  endIndex: number;
}

// ── Constants ────────────────────────────────────────────

const CHECKPOINT_PREFIX = "wip(checkpoint):";
const MAX_VISIBLE = 15;

// ── Build items ──────────────────────────────────────────

/**
 * Parse `git log --pretty=format:"%H%x00%s"` output into CommitItem[].
 */
export function buildCommitItems(rawGitLog: string): CommitItem[] {
  const items: CommitItem[] = [];
  const lines = rawGitLog.trim().split("\n");
  for (const line of lines) {
    if (!line) continue;
    const [sha, subject] = line.split("\0");
    if (!sha || subject === undefined) continue;
    items.push({
      sha,
      subject,
      isCheckpoint: subject.startsWith(CHECKPOINT_PREFIX),
    });
  }
  return items;
}

/**
 * Compute the default range: [1] at HEAD, [2] at the last checkpoint.
 * Falls back to both at HEAD when there are no checkpoints.
 */
export function defaultRange(
  items: CommitItem[],
): { startIndex: number; endIndex: number } {
  const startIndex = 0;
  let endIndex = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].isCheckpoint) {
      endIndex = i;
    }
  }
  return { startIndex, endIndex };
}

/**
 * Compute a readable label for a commit item.
 * Strips the `wip(checkpoint): ` prefix from checkpoint commits.
 */
export function formatSubject(subject: string): string {
  if (subject.startsWith(CHECKPOINT_PREFIX)) {
    const rest = subject.slice(CHECKPOINT_PREFIX.length).trim();
    return rest ? `wip(checkpoint) ${rest}` : "wip(checkpoint)";
  }
  return subject;
}

// ── CommitPicker component ───────────────────────────────

/**
 * Interactive commit range picker.
 *
 * Renders as a centered popup listing recent commits. The user sets
 * range markers [1] (start) and [2] (end) by pressing `1` / `2` at the
 * cursor position. The highlighted region shows the selected range.
 *
 * On Enter the picker validates that at least one checkpoint commit falls
 * inside the range, then calls `onConfirm` with the result.
 */
export class CommitPicker {
  private items: CommitItem[];
  private cursorIndex: number;
  private startIndex: number;
  private endIndex: number;
  private scrollOffset: number;
  private maxVisible: number;
  private errorMessage: string | null = null;
  /** Stored theme reference for render(). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private theme: { fg: (color: any, text: string) => string; bg: (color: any, text: string) => string };

  public onConfirm?: (result: PickerResult) => void;
  public onCancel?: () => void;

  constructor(
    items: CommitItem[],
    defaultStart: number,
    defaultEnd: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    theme: { fg: (color: any, text: string) => string; bg: (color: any, text: string) => string },
    maxVisible = MAX_VISIBLE,
  ) {
    this.items = items;
    this.cursorIndex = defaultEnd;
    this.startIndex = defaultStart;
    this.endIndex = defaultEnd;
    this.maxVisible = maxVisible;
    this.scrollOffset = 0;
    this.theme = theme;
    this.ensureCursorVisible();
  }

  // ── Navigation helpers ─────────────────────────────────

  private ensureCursorVisible(): void {
    if (this.cursorIndex < this.scrollOffset) {
      this.scrollOffset = this.cursorIndex;
    } else if (this.cursorIndex >= this.scrollOffset + this.maxVisible) {
      this.scrollOffset = this.cursorIndex - this.maxVisible + 1;
    }
  }

  private get visibleSlice(): CommitItem[] {
    return this.items.slice(
      this.scrollOffset,
      this.scrollOffset + this.maxVisible,
    );
  }

  /** The inclusive lower index of the range. */
  private get lo(): number {
    return Math.min(this.startIndex, this.endIndex);
  }

  /** The inclusive upper index of the range. */
  private get hi(): number {
    return Math.max(this.startIndex, this.endIndex);
  }

  /** Whether the cursor is on the start marker. */
  private isAtStart(): boolean {
    return this.cursorIndex === this.startIndex;
  }

  /** Whether the cursor is on the end marker. */
  private isAtEnd(): boolean {
    return this.cursorIndex === this.endIndex;
  }

  /** Build the display text for one item with markers. */
  private formatLine(absIndex: number): string {
    const item = this.items[absIndex];
    const isStart = absIndex === this.startIndex;
    const isEnd = absIndex === this.endIndex;
    const marker = isStart ? "1" : isEnd ? "2" : " ";
    const cursor = absIndex === this.cursorIndex ? "▸" : " ";
    const label = formatSubject(item.subject);
    return `${cursor} [${marker}] ${label}`;
  }

  // ── Input handling ─────────────────────────────────────

  handleInput(data: string): void {
    // Any key clears the error.
    this.errorMessage = null;

    if (matchesKey(data, Key.up)) {
      if (this.cursorIndex > 0) {
        this.cursorIndex--;
        this.ensureCursorVisible();
      }
    } else if (matchesKey(data, Key.down)) {
      if (this.cursorIndex < this.items.length - 1) {
        this.cursorIndex++;
        this.ensureCursorVisible();
      }
    } else if (data === "1") {
      this.startIndex = this.cursorIndex;
    } else if (data === "2") {
      this.endIndex = this.cursorIndex;
    } else if (matchesKey(data, Key.enter)) {
      // Validate that at least one checkpoint is in range.
      const hasCheckpoint = this.items
        .slice(this.lo, this.hi + 1)
        .some((item) => item.isCheckpoint);
      if (!hasCheckpoint) {
        this.errorMessage = "チェックポイントが範囲に含まれていません";
        return;
      }
      this.onConfirm?.({ startIndex: this.lo, endIndex: this.hi });
    } else if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
    }
  }

  // ── Rendering ─────────────────────────────────────────

  render(width: number): string[] {
    const t = this.theme;
    const lines: string[] = [];

    // ── Commit list (scrolled window) ─────────────────
    const visible = this.visibleSlice;
    for (let i = 0; i < this.maxVisible; i++) {
      let label: string;
      if (i < visible.length) {
        const absIndex = this.scrollOffset + i;
        const item = visible[i];
        const inRange = absIndex >= this.lo && absIndex <= this.hi;
        const isCursor = absIndex === this.cursorIndex;

        let text = this.formatLine(absIndex);
        const avail = width - 2;
        text = truncateToWidth(text, avail);

        // Apply colours.
        if (inRange && isCursor) {
          label = t.bg("selectedBg", t.fg("accent", text));
        } else if (inRange) {
          label = t.fg("accent", text);
        } else if (isCursor) {
          label = t.bg("selectedBg", text);
        } else if (item.isCheckpoint) {
          label = t.fg("dim", text);
        } else {
          label = text;
        }
      } else {
        label = "";
      }
      lines.push(`  ${label}`);
    }

    // ── Scroll info ────────────────────────────────────
    if (this.items.length > this.maxVisible) {
      const total = this.items.length;
      const from = this.scrollOffset + 1;
      const to = Math.min(this.scrollOffset + this.maxVisible, total);
      lines.push(`  ${t.fg("dim", `(${from}-${to}/${total})`)}`);
    }

    // ── Error row ──────────────────────────────────────
    if (this.errorMessage) {
      lines.push(`  ${t.fg("error", this.errorMessage)}`);
    }

    // ── Blank spacer ──────────────────────────────────
    lines.push("");

    return lines;
  }

  invalidate(): void {
    // No caching.
  }
}

// ── Show the picker ──────────────────────────────────────

/**
 * Show the commit range picker popup and return the user's selection.
 *
 * In TUI mode, renders a centered overlay popup. In non-TUI mode,
 * falls back to `ctx.ui.select()` with simplified options.
 *
 * @returns The selected range, or `null` if cancelled.
 */
export async function showCommitPicker(
  ctx: ExtensionContext,
  items: CommitItem[],
): Promise<PickerResult | null> {
  if (items.length === 0) return null;

  if (ctx.mode !== "tui") {
    return showCommitPickerNonTUI(ctx, items);
  }

  const { startIndex, endIndex } = defaultRange(items);

  return ctx.ui.custom<PickerResult | null>((tui, theme, _kb, done) => {
    const container = new Container();

    // Top border
    container.addChild(
      new DynamicBorder((s: string) => theme.fg("accent", s)),
    );

    // Title
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold("pi-autocommit: 整理するコミットの範囲を選択")),
        1,
        0,
      ),
    );

    // Help text
    container.addChild(
      new Text(
        theme.fg("dim", "↑↓ 移動 · 1 始点 · 2 終点 · Enter 確認 · Esc キャンセル"),
        1,
        0,
      ),
    );

    const picker = new CommitPicker(items, startIndex, endIndex, theme);
    picker.onConfirm = (result) => done(result);
    picker.onCancel = () => done(null);
    container.addChild(picker);

    // Bottom border
    container.addChild(
      new DynamicBorder((s: string) => theme.fg("accent", s)),
    );

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        picker.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/**
 * Non-TUI fallback: show a simple select menu for picking the range.
 */
async function showCommitPickerNonTUI(
  ctx: ExtensionContext,
  items: CommitItem[],
): Promise<PickerResult | null> {
  const { startIndex, endIndex } = defaultRange(items);

  const options = items.map((item, i) => {
    const marker =
      i === startIndex && i === endIndex
        ? "[1][2]"
        : i === startIndex
          ? "[1]"
          : i === endIndex
            ? "[2]"
            : "   ";
    const prefix = item.isCheckpoint ? "⚡" : " ";
    const label = `${marker} ${prefix} ${formatSubject(item.subject)}`;
    // Truncate for display.
    const maxLen = 80;
    return label.length > maxLen ? label.slice(0, maxLen - 3) + "..." : label;
  });

  // Show description so the user knows what to do.
  const choice = await ctx.ui.select(
    "Select the range end (oldest commit to include)",
    options,
  );

  if (choice === undefined) return null;

  const chosenIndex = options.indexOf(choice);
  if (chosenIndex === -1) return null;

  const result: PickerResult = {
    startIndex: 0,
    endIndex: chosenIndex,
  };

  // Validate checkpoint presence.
  const hasCheckpoint = items
    .slice(0, chosenIndex + 1)
    .some((item) => item.isCheckpoint);
  if (!hasCheckpoint) {
    ctx.ui.notify("チェックポイントが範囲に含まれていません", "error");
    return null;
  }

  return result;
}
