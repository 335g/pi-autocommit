import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { parseNameStatus } from "./git-parser.js";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Per-file details for the diff preview feature.
 */
export interface FileDetail {
  /** Staged diff content for this file */
  diff: string;
  /** Number of added lines */
  additions: number;
  /** Number of deleted lines */
  deletions: number;
}

/**
 * Options for customising the file selector.
 */
export interface FileSelectorOptions {
  /**
   * Pre-fetched diff and stat per file.
   * When provided, Space opens a QuickLook-style diff overlay.
   * When omitted, the preview feature is disabled.
   */
  fileDetails?: Map<string, FileDetail>;
  /**
   * Label for the confirm action shown in the help bar (default: "confirm").
   * E.g. "commit", "review".
   */
  confirmLabel?: string;
}

/**
 * An item representing a staged file with its selection state.
 */
export interface FileItem {
  status: string;
  path: string;
  selected: boolean;
}

/**
 * Status-label map for human-friendly display.
 */
const STATUS_LABELS: Record<string, string> = {
  A: "new",
  M: "mod",
  D: "del",
  R: "ren",
  C: "cpy",
};

/**
 * Foreground colour key per status.
 */
const STATUS_COLORS: Record<string, "success" | "warning" | "error" | "accent" | "dim" | "muted"> = {
  A: "success",
  M: "warning",
  D: "error",
  R: "accent",
  C: "accent",
};

/**
 * Show an interactive file selector for staged files.
 *
 * **TUI mode** – presents an interactive multi‑select list where the user can:
 *   - `↑↓` navigate
 *   - `→` select file, `←` deselect
 *   - `Space` open a full-screen diff preview (when `fileDetails` is provided)
 *   - `a`/`A` toggle all
 *   - `Enter` confirm selection
 *   - `Esc` / `Ctrl+C` cancel
 *
 * In the diff preview (`Space`):
 *   - `↑↓` scroll, `pgup`/`pgdn` jump, `Space` / `Esc` close
 *
 * **Non‑TUI mode** – prints the file list via `ctx.ui.notify` and returns
 * every path (no interactive selection possible).
 *
 * @returns The array of selected file paths, or `null` if cancelled.
 *          Returns `[]` when there are no staged files.
 */
export async function selectFiles(
  ctx: ExtensionContext,
  nameStatusRaw: string,
  options?: FileSelectorOptions,
): Promise<string[] | null> {
  const entries = parseNameStatus(nameStatusRaw);
  if (entries.length === 0) return [];

  // ── Non‑TUI: show as notification, return everything ──────────────
  if (ctx.mode !== "tui") {
    const fileList = entries
      .map((e) => `  ${e.status}\t${e.path}`)
      .join("\n");
    ctx.ui.notify(`Files to commit:\n${fileList}`, "info");
    return entries.map((e) => e.path);
  }

  // ── TUI: interactive multi‑select ─────────────────────────────────
  const items: FileItem[] = entries.map((e) => ({
    status: e.status,
    path: e.path,
    selected: true,
  }));

  const fileDetails = options?.fileDetails;
  const confirmLabel = options?.confirmLabel ?? "confirm";
  const hasPreview = !!fileDetails;

  return ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
    let cursor = 0;
    let scrollOffset = 0;
    const maxVisible = Math.min(items.length, 20);

    // ── Diff overlay state ────────────────────────────────────────
    let mode: "select" | "diff" = "select";
    let diffScrollOffset = 0;
    let diffLines: string[] = [];

    // ── Mutable selection copy ────────────────────────────────────
    const currentItems = items.map((i) => ({ ...i }));

    /**
     * Format the stat string for a file, e.g. "+10/-2".
     */
    function getStatStr(path: string): string {
      const detail = fileDetails?.get(path);
      if (!detail) return "";
      if (detail.additions === 0 && detail.deletions === 0) return "";
      return `+${detail.additions}/-${detail.deletions}`;
    }

    return {
      invalidate() {
        // No caching – render always recomputes
      },

      handleInput(data: string) {
        if (mode === "diff") {
          // ── Diff mode: navigation only ─────────────────────
          if (
            matchesKey(data, Key.space) ||
            matchesKey(data, Key.escape) ||
            matchesKey(data, Key.ctrl("c"))
          ) {
            mode = "select";
            diffScrollOffset = 0;
            tui.requestRender();
          } else if (
            matchesKey(data, Key.up) ||
            matchesKey(data, Key.ctrl("p"))
          ) {
            if (diffScrollOffset > 0) {
              diffScrollOffset--;
              tui.requestRender();
            }
          } else if (
            matchesKey(data, Key.down) ||
            matchesKey(data, Key.ctrl("n"))
          ) {
            if (diffScrollOffset < diffLines.length - 1) {
              diffScrollOffset++;
              tui.requestRender();
            }
          } else if (
            matchesKey(data, Key.pageUp) ||
            matchesKey(data, Key.ctrl("b"))
          ) {
            diffScrollOffset = Math.max(0, diffScrollOffset - 20);
            tui.requestRender();
          } else if (
            matchesKey(data, Key.pageDown) ||
            matchesKey(data, Key.ctrl("f"))
          ) {
            diffScrollOffset = Math.min(
              Math.max(0, diffLines.length - 1),
              diffScrollOffset + 20,
            );
            tui.requestRender();
          }
          return;
        }

        // ── Select mode: keyboard navigation ───────────────────
        if (matchesKey(data, Key.up)) {
          if (cursor > 0) {
            cursor--;
            if (cursor < scrollOffset) scrollOffset = cursor;
            tui.requestRender();
          }
        } else if (matchesKey(data, Key.down)) {
          if (cursor < currentItems.length - 1) {
            cursor++;
            if (cursor >= scrollOffset + maxVisible) {
              scrollOffset = cursor - maxVisible + 1;
            }
            tui.requestRender();
          }
        } else if (matchesKey(data, Key.right)) {
          // → : select file
          currentItems[cursor].selected = true;
          tui.requestRender();
        } else if (matchesKey(data, Key.left)) {
          // ← : deselect file
          currentItems[cursor].selected = false;
          tui.requestRender();
        } else if (matchesKey(data, Key.space)) {
          // Space : QuickLook-style diff preview
          if (hasPreview) {
            const detail = fileDetails.get(currentItems[cursor].path);
            if (detail?.diff) {
              diffLines = detail.diff.split("\n");
              diffScrollOffset = 0;
              mode = "diff";
              tui.requestRender();
            }
          }
        } else if (data === "a" || data === "A") {
          const anyUnselected = currentItems.some((i) => !i.selected);
          for (const item of currentItems) {
            item.selected = anyUnselected;
          }
          tui.requestRender();
        } else if (matchesKey(data, Key.enter)) {
          // Enter : confirm and proceed
          const selected = currentItems
            .filter((i) => i.selected)
            .map((i) => i.path);
          done(selected.length > 0 ? selected : []);
          return;
        } else if (
          matchesKey(data, Key.escape) ||
          matchesKey(data, Key.ctrl("c"))
        ) {
          done(null);
          return;
        }
      },

      render(width: number): string[] {
        // ── Diff overlay (QuickLook) ───────────────────────────
        if (mode === "diff") {
          return renderDiffOverlay(
            theme,
            width,
            currentItems[cursor].path,
            fileDetails?.get(currentItems[cursor].path),
            diffLines,
            diffScrollOffset,
          );
        }

        // ── File list (select mode) ────────────────────────────
        const lines: string[] = [];

        // Title line
        const selectedCount = currentItems.filter((i) => i.selected).length;
        const title = theme.fg(
          "accent",
          theme.bold(
            ` Select files to ${confirmLabel}  (${selectedCount}/${currentItems.length})`,
          ),
        );
        lines.push(title);
        lines.push("");

        // Column headers
        if (hasPreview) {
          lines.push(theme.fg("dim", "   select   stat    type  file"));
          lines.push(theme.fg("dim", "  ─────── ─────── ──── ────"));
        } else {
          lines.push(theme.fg("dim", "   select  type  file"));
          lines.push(theme.fg("dim", "  ────── ──── ────"));
        }

        // File entries
        const visibleItems = currentItems.slice(
          scrollOffset,
          scrollOffset + maxVisible,
        );

        for (let i = 0; i < visibleItems.length; i++) {
          const item = visibleItems[i];
          const idx = scrollOffset + i;
          const isCursor = idx === cursor;

          const cursorMark = isCursor ? theme.fg("accent", "▸") : " ";
          const checkbox = item.selected
            ? theme.fg("success", "●")
            : theme.fg("dim", "○");
          const statusColor = STATUS_COLORS[item.status] ?? "muted";
          const statusLabel = STATUS_LABELS[item.status] ?? item.status;
          const statusStr = theme.fg(statusColor, statusLabel.padEnd(3));

          let line: string;
          if (hasPreview) {
            const statStr = getStatStr(item.path);
            line = `${cursorMark} ${checkbox}  ${statStr.padEnd(7)}  ${statusStr} ${item.path}`;
          } else {
            line = `${cursorMark} ${checkbox} ${statusStr} ${item.path}`;
          }
          lines.push(truncateToWidth(line, width));
        }

        // Scroll hint
        if (currentItems.length > maxVisible) {
          const end = Math.min(scrollOffset + maxVisible, currentItems.length);
          const hint = theme.fg(
            "dim",
            `  (${scrollOffset + 1}–${end}/${currentItems.length})`,
          );
          lines.push(hint);
        }

        lines.push("");

        // Help bar
        const helpItems: string[] = [
          "↑↓ navigate",
          "→ select",
          "← deselect",
        ];
        if (hasPreview) {
          helpItems.push("space preview");
        }
        helpItems.push("a all");
        helpItems.push(`enter ${confirmLabel}`);
        helpItems.push("esc cancel");
        lines.push(theme.fg("dim", `  ${helpItems.join("  ")}`));

        return lines;
      },
    };
  });
}

/**
 * Render the full-screen diff overlay (QuickLook style).
 */
function renderDiffOverlay(
  theme: Theme,
  width: number,
  filePath: string,
  detail: FileDetail | undefined,
  diffLines: string[],
  scrollOffset: number,
): string[] {
  const lines: string[] = [];

  // Blank line for top margin
  lines.push("");

  // Header: filename with stat
  const statStr = detail
    ? theme.fg("dim", `  (+${detail.additions}/-${detail.deletions})`)
    : "";
  lines.push(theme.fg("accent", theme.bold(` ${filePath}`)) + statStr);
  lines.push(theme.fg("dim", " " + "─".repeat(Math.min(width - 1, 60))));
  lines.push("");

  if (diffLines.length === 0) {
    lines.push(theme.fg("dim", "  (no diff content — binary or unchanged)"));
    lines.push("");
    lines.push(theme.fg("dim", "  space/esc 閉じる"));
    return lines;
  }

  // Render visible portion of the diff
  const availableHeight = estimateVisibleHeight(diffLines.length, scrollOffset);
  const endLine = Math.min(scrollOffset + availableHeight, diffLines.length);
  const visibleDiff = diffLines.slice(scrollOffset, endLine);

  for (const line of visibleDiff) {
    let styledLine: string;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      styledLine = theme.fg("success", line);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      styledLine = theme.fg("error", line);
    } else if (line.startsWith("@@")) {
      styledLine = theme.fg("toolDiffContext", line);
    } else {
      styledLine = line;
    }
    lines.push(truncateToWidth(styledLine, width));
  }

  // Scroll indicator for long diffs
  const totalDiffLines = diffLines.length;
  if (totalDiffLines > availableHeight) {
    lines.push("");
    const scrollPercent = Math.round(
      (scrollOffset / Math.max(1, totalDiffLines - availableHeight)) * 100,
    );
    const scrollInfo = theme.fg(
      "dim",
      `  ${scrollPercent}%  (${scrollOffset + 1}–${endLine}/${totalDiffLines})`,
    );
    lines.push(scrollInfo);
  }

  // Help bar
  lines.push("");
  lines.push(theme.fg("dim", "  space/esc 閉じる  ↑↓ スクロール  pgup/pgdn ±20行"));

  return lines;
}

/**
 * Estimate how many diff lines fit in the visible area.
 * We reserve ~6 lines for header/footer/margins.
 */
function estimateVisibleHeight(totalLines: number, scrollOffset: number): number {
  const reserved = 6;
  return Math.max(5, Math.min(totalLines - scrollOffset, 40 - reserved));
}
