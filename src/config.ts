import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Known config keys (camelCase as they appear in JSON)
const KNOWN_KEYS = new Set(["lang", "enable", "model", "scope", "commitPickerMaxCommits"]);

/** Config file name, relative to `.pi/`. */
const CONFIG_FILENAME = "pi-autocommit.json";

/**
 * Normalised configuration for the pi-autocommit extension.
 */
export interface PiAutocommitConfig {
  /** Language for the commit message (subject and body). `"ja"` → Japanese, anything else → English */
  lang: string;
  /** Whether auto-commit is enabled. Defaults to `false`. */
  enable: boolean;
  /**
   * LLM model for commit message generation, in `"provider/modelId"` format
   * (e.g. `"anthropic/claude-sonnet-4"`).
   * When omitted, the session's current model is used.
   */
  model?: string;
  /**
   * Path-to-scope mapping that fixes the Conventional Commits scope
   * deterministically. Keys are picomatch globs evaluated against changed
   * file paths; values are the scope to apply. When set, the LLM is told to
   * omit scope and the scope is injected by `scope-resolver.ts`.
   * When unset (or empty), the LLM infers the scope as before.
   */
  scope?: Record<string, string>;

  /**
   * Maximum number of recent commits to fetch from HEAD for the commit picker
   * popup shown at `agent_end`. Defaults to `30`.
   */
  commitPickerMaxCommits: number;
}

const DEFAULT_CONFIG: PiAutocommitConfig = {
  lang: "en",
  enable: false,
  commitPickerMaxCommits: 30,
};

/**
 * Load `.pi/pi-autocommit.json` from the project root.
 *
 * Returns default config (English, auto-commit disabled) when the file is
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

    const scope =
      parsed.scope !== null &&
      typeof parsed.scope === "object" &&
      !Array.isArray(parsed.scope)
        ? normaliseScope(parsed.scope as Record<string, unknown>)
        : undefined;

    const commitPickerMaxCommits =
      typeof parsed.commitPickerMaxCommits === "number" &&
      Number.isInteger(parsed.commitPickerMaxCommits) &&
      parsed.commitPickerMaxCommits > 0
        ? parsed.commitPickerMaxCommits
        : DEFAULT_CONFIG.commitPickerMaxCommits;

    return { lang, enable, model, scope, commitPickerMaxCommits };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Normalise a raw `scope` object into a `path → scope` record.
 *
 * Drops entries whose value is not a non-empty string. Returns `undefined`
 * when the result would be empty, so an absent/empty scope is treated the
 * same as no scope at all.
 */
function normaliseScope(
  raw: Record<string, unknown>,
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim().length > 0) {
      result[key] = value.trim();
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Persist `enable` to `.pi/pi-autocommit.json`, preserving every other key.
 *
 * Reads the existing file (if any) and replaces only the `enable` field,
 * so unknown keys and other known keys (`lang`, `model`) are kept intact.
 * When the file does not exist, it is created with default values
 * (`lang: "en"`, no `model`) and the given `enable` value.
 */
export function saveEnable(cwd: string, enable: boolean): void {
  const configPath = join(cwd, ".pi", CONFIG_FILENAME);

  let parsed: Record<string, unknown> = {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Missing or unreadable file — start from defaults.
    parsed = { lang: DEFAULT_CONFIG.lang };
  }

  parsed.enable = enable;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

/**
 * Persist `model` to `.pi/pi-autocommit.json`, preserving every other key.
 *
 * Reads the existing file (if any) and replaces only the `model` field,
 * so unknown keys and other known keys (`lang`, `enable`) are kept intact.
 * Pass `undefined` to clear the `model` key entirely (fall back to the
 * session model). When the file does not exist, it is created with default
 * values (`lang: "en"`, `enable: true`) and the given `model` value.
 */
export function saveModel(cwd: string, model: string | undefined): void {
  const configPath = join(cwd, ".pi", CONFIG_FILENAME);

  let parsed: Record<string, unknown> = {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Missing or unreadable file — start from defaults.
    parsed = { lang: DEFAULT_CONFIG.lang, enable: DEFAULT_CONFIG.enable };
  }

  if (model === undefined) {
    delete parsed.model;
  } else {
    parsed.model = model;
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}

/**
 * Returns `true` when the commit message should be written in Japanese.
 */
export function isJapanese(config: PiAutocommitConfig): boolean {
  return config.lang === "ja";
}
