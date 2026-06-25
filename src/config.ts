import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

/**
 * Language configuration for commit messages.
 */
export interface PiGitConfig {
	/** Language for the commit message (subject and body). `"ja"` → Japanese, anything else → English */
	lang: string;
	/** When `true`, the commit message is generated without a body (subject-only). */
	noBody?: boolean;
}

const DEFAULT_CONFIG: PiGitConfig = { lang: "en", noBody: false };

/**
 * Load `.pi-git/config.toml` from the project root.
 *
 * Returns default config (English body) when the file is missing or unreadable.
 */
export function loadConfig(cwd: string): PiGitConfig {
	try {
		const configPath = join(cwd, ".pi-git", "config.toml");
		const raw = readFileSync(configPath, "utf-8");
		const parsed = parse(raw) as { lang?: string; no_body?: boolean };

		const lang = typeof parsed.lang === "string" && parsed.lang.trim().length > 0
			? parsed.lang.trim()
			: DEFAULT_CONFIG.lang;

		const noBody = typeof parsed.no_body === "boolean"
			? parsed.no_body
			: DEFAULT_CONFIG.noBody;

		return { lang, noBody };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
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
