/**
 * Footer status manager for pi-git extension
 *
 * Manages footer display in a unified way:
 * - Base display: auto-commit on/off + clean/changed state
 * - Running display: command execution phase
 *
 * Singleton instance is exported as `footerManager`.
 */

import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { t } from "./lang.js";
import { getAutoAggCommit, getLanguage } from "./settings.js";

const STATUS_KEY = "pi-git-agg-commit";

type Phase =
  | "prepare"
  | "collectDiff"
  | "analyze"
  | "generateMessage"
  | "review"
  | "commit";

/**
 * Singleton class that manages footer status display.
 *
 * When `ui` is null (hasUI = false), all methods become no-op.
 */
class FooterManager {
  private pi: ExtensionAPI | null = null;
  private ui: ExtensionUIContext | null = null;
  private cwd: string | undefined;
  private running: {
    command: string;
    phase: Phase;
    lang?: string;
    phaseStartedAt: number;
    /** Commit progress: current hunk index (1-based) */
    commitCurrent?: number;
    /** Commit progress: total hunks */
    commitTotal?: number;
  } | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Initialize the manager with pi API, UI context, and working directory.
   * Call this once at session_start.
   *
   * @param pi - Extension API for executing git commands
   * @param ui - UI context (null if hasUI is false)
   * @param cwd - Working directory
   */
  initialize(
    pi: ExtensionAPI,
    ui: ExtensionUIContext | null,
    cwd?: string,
  ): void {
    this.pi = pi;
    this.ui = ui;
    this.cwd = cwd;
  }

  /**
   * Check if a command is currently running.
   */
  isRunning(): boolean {
    return this.running !== null;
  }

  /**
   * Refresh the base display (auto-commit on/off + clean/changed).
   * Does nothing if a command is running or if UI is not available.
   */
  async refresh(): Promise<void> {
    if (!this.pi || !this.ui) return;
    if (this.running) return;

    const enabled = getAutoAggCommit(this.cwd);
    const lang = getLanguage(this.cwd);

    // Check if inside a git repository
    const { code } = await this.pi.exec("git", ["rev-parse", "--git-dir"], {
      cwd: this.cwd,
    });
    if (code !== 0) {
      this.ui.setStatus(STATUS_KEY, t(lang, "footer.autoCommit.off"));
      return;
    }

    // Evaluate clean/changed state
    const { stdout } = await this.pi.exec("git", ["status", "--porcelain"], {
      cwd: this.cwd,
    });
    if (!enabled) {
      this.ui.setStatus(STATUS_KEY, t(lang, "footer.autoCommit.off"));
    } else if (stdout.trim().length > 0) {
      this.ui.setStatus(STATUS_KEY, t(lang, "footer.autoCommit.onChanged"));
    } else {
      this.ui.setStatus(STATUS_KEY, t(lang, "footer.autoCommit.onClean"));
    }
  }

  /**
   * Start running display. Sets the running flag and shows phase text.
   *
   * @param command - Command name ("agg-commit" or "auto-commit")
   * @param phase - Initial phase
   * @param lang - Optional language override (for --lang flag)
   */
  setRunning(command: string, phase: Phase, lang?: string): void {
    if (!this.ui) return;
    this.running = { command, phase, lang, phaseStartedAt: Date.now() };
    this.startElapsedTimer();
    this.renderPhase();
  }

  /**
   * Update the phase of the currently running command.
   * Does nothing if no command is running.
   *
   * @param phase - New phase
   * @param lang - Optional language override (for --lang flag)
   */
  setPhase(phase: Phase, lang?: string): void {
    if (!this.ui || !this.running) return;
    this.running.phase = phase;
    this.running.phaseStartedAt = Date.now();
    this.running.commitCurrent = undefined;
    this.running.commitTotal = undefined;
    if (lang !== undefined) {
      this.running.lang = lang;
    }
    this.renderPhase();
  }

  /**
   * Set commit progress for the current phase.
   * @param current - Current hunk index (1-based)
   * @param total - Total number of hunks
   */
  setCommitProgress(current: number, total: number): void {
    if (!this.ui || !this.running) return;
    this.running.commitCurrent = current;
    this.running.commitTotal = total;
    this.renderPhase();
  }

  /**
   * End the running display. Clears the running flag and refreshes base display.
   */
  async clearRunning(): Promise<void> {
    this.stopElapsedTimer();
    this.running = null;
    await this.refresh();
  }

  /**
   * Render the current phase text to the footer.
   */
  private renderPhase(): void {
    if (!this.ui || !this.running) return;
    const lang = this.running.lang ?? getLanguage(this.cwd);
    const autoCommit = this.running.command === "auto-commit";
    const elapsed = Math.floor(
      (Date.now() - this.running.phaseStartedAt) / 1000,
    );

    let status = phaseStatusText(lang, this.running.phase, autoCommit);

    // Append commit progress if available
    if (
      this.running.commitCurrent !== undefined &&
      this.running.commitTotal !== undefined
    ) {
      status += ` (${this.running.commitCurrent}/${this.running.commitTotal})`;
    } else {
      // Show elapsed time for phases that take a while
      status += ` (${elapsed}s)`;
    }

    this.ui.setStatus(STATUS_KEY, status);
  }

  /** Start a periodic timer to refresh the elapsed-time display */
  private startElapsedTimer(): void {
    this.stopElapsedTimer();
    this.elapsedTimer = setInterval(() => {
      if (this.running) this.renderPhase();
    }, 1000);
  }

  /** Stop the elapsed-time refresh timer */
  private stopElapsedTimer(): void {
    if (this.elapsedTimer !== null) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }
}

/**
 * Generate localized status text for each phase of the commit workflow.
 */
function phaseStatusText(
  lang: string,
  key: Phase,
  autoCommit: boolean,
): string {
  const prefix = autoCommit ? "[pi-git: auto-commit]" : "[pi-git]";
  switch (key) {
    case "prepare":
      return t(lang, "footer.prepare", { prefix });
    case "collectDiff":
      return t(lang, "footer.collectDiff", { prefix });
    case "analyze":
      return t(lang, "footer.analyze", { prefix });
    case "generateMessage":
      return t(lang, "footer.generateMessage", { prefix });
    case "review":
      return t(lang, "footer.review", { prefix });
    case "commit":
      return t(lang, "footer.commit", { prefix });
  }
}

/** Singleton instance */
export const footerManager = new FooterManager();
