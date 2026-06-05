/**
 * Language utilities for i18n support
 */

/**
 * Check if the language is Japanese
 */
export function isJapanese(lang: string): boolean {
  return lang === "ja" || lang === "ja-JP" || lang === "japanese";
}

/**
 * Get localized message based on language.
 * Usage: t(lang)`日本語|English` or t(lang, "日本語", "English")
 */
export function t(lang: string, ja: string, en: string): string {
  return isJapanese(lang) ? ja : en;
}
