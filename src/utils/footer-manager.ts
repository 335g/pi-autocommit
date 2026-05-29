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
import { isJapanese } from "./lang.js";
import { getAutoAggCommit, getLanguage } from "./settings.js";

const STATUS_KEY = "pi-git-agg-commit";

type Phase =
  | "prepare"
  | "collectDiff"
  | "analyze"
  | "generateMessage"
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
  private running: { command: string; phase: Phase; lang?: string } | null =
    null;

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
    const onOff = enabled ? "on" : "off";

    // Check if inside a git repository
    const { code } = await this.pi.exec("git", ["rev-parse", "--git-dir"], {
      cwd: this.cwd,
    });
    if (code !== 0) {
      this.ui.setStatus(STATUS_KEY, `auto-commit: ${onOff}`);
      return;
    }

    // Evaluate clean/changed state
    const { stdout } = await this.pi.exec("git", ["status", "--porcelain"], {
      cwd: this.cwd,
    });
    const state = stdout.trim().length > 0 ? "changed" : "clean";
    this.ui.setStatus(STATUS_KEY, `auto-commit: ${onOff} (${state})`);
  }

  /**
   * Start running display. Sets the running flag and shows phase text.
   *
   * @param command - Command name ("agg-commit" or "auto-commit")
   * @param phase - Initial phase
   * @param lang - Optional language override (for --lang flag)
   */
  async setRunning(
    command: string,
    phase: Phase,
    lang?: string,
  ): Promise<void> {
    if (!this.ui) return;
    this.running = { command, phase, lang };
    this.renderPhase();
  }

  /**
   * Update the phase of the currently running command.
   * Does nothing if no command is running.
   *
   * @param phase - New phase
   * @param lang - Optional language override (for --lang flag)
   */
  async setPhase(phase: Phase, lang?: string): Promise<void> {
    if (!this.ui || !this.running) return;
    this.running.phase = phase;
    if (lang !== undefined) {
      this.running.lang = lang;
    }
    this.renderPhase();
  }

  /**
   * End the running display. Clears the running flag and refreshes base display.
   */
  async clearRunning(): Promise<void> {
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
    this.ui.setStatus(
      STATUS_KEY,
      phaseStatusText(lang, this.running.phase, autoCommit),
    );
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
  const ja = isJapanese(lang);
  const prefix = autoCommit ? "[pi-git: auto-commit]" : "[pi-git]";
  switch (key) {
    case "prepare":
      return ja ? `${prefix} 準備中...` : `${prefix} Preparing...`;
    case "collectDiff":
      return ja ? `${prefix} diff収集中...` : `${prefix} Collecting diff...`;
    case "analyze":
      return ja ? `${prefix} hunk解析中...` : `${prefix} Analyzing hunks...`;
    case "generateMessage":
      return ja
        ? `${prefix} コミットメッセージ生成中...`
        : `${prefix} Generating messages...`;
    case "commit":
      return ja ? `${prefix} コミット実行中...` : `${prefix} Committing...`;
  }
}

/** Singleton instance */
export const footerManager = new FooterManager();
