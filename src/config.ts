import { readFileSync } from "node:fs";
import { join } from "node:path";

// Known config keys (camelCase as they appear in JSON)
const KNOWN_KEYS = new Set(["lang", "enable", "model"]);

/** Config file name, relative to `.pi/`. */
const CONFIG_FILENAME = "pi-autocommit.json";

/**
 * Normalised configuration for the pi-autocommit extension.
 */
export interface PiAutocommitConfig {
  /** Language for the commit message (subject and body). `"ja"` → Japanese, anything else → English */
  lang: string;
  /** Whether auto-commit is enabled. Defaults to `true`. */
  enable: boolean;
  /**
   * LLM model for commit message generation, in `"provider/modelId"` format
   * (e.g. `"anthropic/claude-sonnet-4"`).
   * When omitted, the session's current model is used.
   */
  model?: string;
}

const DEFAULT_CONFIG: PiAutocommitConfig = {
  lang: "en",
  enable: true,
};

/**
 * Load `.pi/pi-autocommit.json` from the project root.
 *
 * Returns default config (English, auto-commit enabled) when the file is
 * missing or unreadable.
 */
export function loadConfig(cwd: string): PiAutocommitConfig {
  try {
    const configPath = join(cwd, ".pi", CONFIG_FILENAME);
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Warn about unknown (possibly misspelled) keys
    const unknownKeys = Object.keys(parsed).filter((k) => !KNOWN_KEYS.has(k));
    if (unknownKeys.length > 0) {
      console.warn(
        `[pi-autocommit] Unknown config key(s): ${unknownKeys.join(", ")}. ` +
          `Valid keys: ${[...KNOWN_KEYS].join(", ")}`,
      );
    }

    const lang =
      typeof parsed.lang === "string" && parsed.lang.trim().length > 0
        ? parsed.lang.trim()
        : DEFAULT_CONFIG.lang;

    const enable =
      typeof parsed.enable === "boolean"
        ? parsed.enable
        : DEFAULT_CONFIG.enable;

    const model =
      typeof parsed.model === "string" && parsed.model.trim().length > 0
        ? parsed.model.trim()
        : undefined;

    return { lang, enable, model };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Returns `true` when the commit message should be written in Japanese.
 */
export function isJapanese(config: PiAutocommitConfig): boolean {
  return config.lang === "ja";
}
