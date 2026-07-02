import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Show `git status` output in a scrollable full-screen TUI viewer.
 *
 * Navigation:
 *   ↑↓        scroll one line
 *   pgup/pgdn scroll 20 lines
 *   esc/^c    close
 */
export async function showStatusViewer(
  ctx: ExtensionContext,
  statusOutput: string,
): Promise<void> {
  const lines = statusOutput.trimEnd().split("\n");
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    ctx.ui.notify("No changes — working tree clean.", "info");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    let scrollOffset = 0;
    const maxVisible = Math.min(lines.length, 40);

    return {
      invalidate() {
        // No caching needed.
      },

      handleInput(data: string) {
        if (
          matchesKey(data, Key.escape) ||
          matchesKey(data, Key.ctrl("c"))
        ) {
          done(undefined);
          return;
        }

        if (matchesKey(data, Key.up)) {
          if (scrollOffset > 0) {
            scrollOffset--;
            tui.requestRender();
          }
        } else if (matchesKey(data, Key.down)) {
          if (scrollOffset < lines.length - 1) {
            scrollOffset++;
            tui.requestRender();
          }
        } else if (
          matchesKey(data, Key.pageUp) ||
          matchesKey(data, Key.ctrl("b"))
        ) {
          scrollOffset = Math.max(0, scrollOffset - 20);
          tui.requestRender();
        } else if (
          matchesKey(data, Key.pageDown) ||
          matchesKey(data, Key.ctrl("f"))
        ) {
          scrollOffset = Math.min(
            Math.max(0, lines.length - 1),
            scrollOffset + 20,
          );
          tui.requestRender();
        }
      },

      render(width: number): string[] {
        const result: string[] = [];

        // Title
        result.push(
          theme.fg("accent", theme.bold(" git status")),
        );
        result.push(
          theme.fg(
            "dim",
            " " + "─".repeat(Math.min(width - 1, 60)),
          ),
        );
        result.push("");

        // Content
        const endLine = Math.min(
          scrollOffset + maxVisible,
          lines.length,
        );
        const visible = lines.slice(scrollOffset, endLine);

        for (const line of visible) {
          // Colour-coded lines
          let styled = line;
          if (
            line.startsWith("\tdeleted:")
          ) {
            styled = theme.fg("error", line);
          } else if (
            line.startsWith("\tnew file:") ||
            line.startsWith("\tcopied:")
          ) {
            styled = theme.fg("success", line);
          } else if (
            line.startsWith("\tmodified:") ||
            line.startsWith("\trenamed:")
          ) {
            styled = theme.fg("warning", line);
          } else if (
            line.includes("Changes not staged for commit") ||
            line.includes("Changes to be committed") ||
            line.includes("Untracked files")
          ) {
            styled = theme.fg("accent", line);
          }
          result.push(truncateToWidth(styled, width));
        }

        // Scroll indicator
        if (lines.length > maxVisible) {
          result.push("");
          const scrollPercent = Math.round(
            (scrollOffset /
              Math.max(1, lines.length - maxVisible)) *
              100,
          );
          const scrollInfo = theme.fg(
            "dim",
            `  ${scrollPercent}%  (${scrollOffset + 1}–${endLine}/${lines.length})`,
          );
          result.push(scrollInfo);
        }

        // Help bar
        result.push("");
        result.push(
          theme.fg(
            "dim",
            "  esc/^c close  ↑↓ scroll  pgup/pgdn ±20行",
          ),
        );

        return result;
      },
    };
  });
}
