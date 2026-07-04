import { readFileSync } from "node:fs";
import { join } from "node:path";

// Known config keys (camelCase as they appear in JSON)
const KNOWN_KEYS = new Set(["lang", "noBody", "commitEveryTurn"]);

/**
 * Setting that controls the auto-commit behaviour.
 *
 * - `false`: disabled.
 * - `true`: legacy alias for `{ trigger: "agent_end" }`.
 * - `{ trigger: "agent_end" }`: commit once at the end of every agent loop.
 * - `{ trigger: "turn_end" }`: create lightweight checkpoint commits at the
 *   end of each turn that modifies files, then reorganise those checkpoints
 *   into logical Conventional Commits at `agent_end`.
 */
export type CommitEveryTurnConfig =
  | boolean
  | { trigger: "agent_end" | "turn_end" };

/**
 * Normalised, resolved auto-commit configuration.
 */
export interface ResolvedCommitEveryTurnConfig {
  /** Whether auto-commit is enabled. */
  enabled: boolean;
  /** Which strategy to use. */
  trigger: "agent_end" | "turn_end";
}

/**
 * Language configuration for commit messages.
 */
export interface PiGitConfig {
  /** Language for the commit message (subject and body). `"ja"` → Japanese, anything else → English */
  lang: string;
  /** When `true`, the commit message is generated without a body (subject-only). */
  noBody?: boolean;
  /** Controls automatic commit behaviour. See {@link CommitEveryTurnConfig}. */
  commitEveryTurn?: CommitEveryTurnConfig;
}

const DEFAULT_CONFIG: PiGitConfig = {
  lang: "en",
  noBody: false,
  commitEveryTurn: false,
};

/**
 * Load `.pi/pi-git.json` from the project root.
 *
 * Returns default config (English body) when the file is missing or unreadable.
 */
export function loadConfig(cwd: string): PiGitConfig {
  try {
    const configPath = join(cwd, ".pi", "pi-git.json");
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Warn about unknown (possibly misspelled) keys
    const unknownKeys = Object.keys(parsed).filter((k) => !KNOWN_KEYS.has(k));
    if (unknownKeys.length > 0) {
      console.warn(
        `[pi-git] Unknown config key(s): ${unknownKeys.join(", ")}. ` +
          `Valid keys: ${[...KNOWN_KEYS].join(", ")}`,
      );
    }

    const lang = typeof parsed.lang === "string" && parsed.lang.trim().length > 0
      ? parsed.lang.trim()
      : DEFAULT_CONFIG.lang;

    const noBody = typeof parsed.noBody === "boolean"
      ? parsed.noBody
      : DEFAULT_CONFIG.noBody;

    const commitEveryTurn =
      parsed.commitEveryTurn === undefined
        ? DEFAULT_CONFIG.commitEveryTurn
        : (parsed.commitEveryTurn as CommitEveryTurnConfig);

    return { lang, noBody, commitEveryTurn };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Resolve the raw `commitEveryTurn` config value into a normalised form.
 *
 * Backwards compatibility:
 * - `true`  → `{ enabled: true, trigger: "agent_end" }`
 * - `false` → `{ enabled: false, trigger: "agent_end" }`
 */
export function resolveCommitEveryTurnConfig(
  value: CommitEveryTurnConfig | undefined,
): ResolvedCommitEveryTurnConfig {
  if (value === undefined || value === false) {
    return { enabled: false, trigger: "agent_end" };
  }
  if (value === true) {
    return { enabled: true, trigger: "agent_end" };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    (value.trigger === "agent_end" || value.trigger === "turn_end")
  ) {
    return { enabled: true, trigger: value.trigger };
  }
  // Treat unexpected shapes as disabled to stay safe.
  return { enabled: false, trigger: "agent_end" };
}

/**
 * Returns `true` when the commit message should be written in Japanese.
 */
export function isJapanese(config: PiGitConfig): boolean {
  return config.lang === "ja";
}

/**
 * Returns `true` when the commit message should omit the body.
 */
export function hasNoBody(config: PiGitConfig): boolean {
  return config.noBody === true;
}
