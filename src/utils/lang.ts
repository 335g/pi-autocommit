/**
 * Language utilities for i18n support.
 *
 * The `t()` function resolves a message key against the catalog in
 * src/i18n/messages.ts and replaces `{placeholder}` params.
 */

import { messages, type MessageKey } from "../i18n/messages.js";

/**
 * Get a localized message by key, with optional placeholder interpolation.
 *
 * Placeholders use `{key}` syntax and are replaced in a single pass to
 * prevent cross-contamination when param values themselves contain braces.
 *
 * Unsupported languages fall back to English.
 * Unknown keys return the key itself as a last-resort fallback.
 */
export function t(
  lang: string,
  key: MessageKey,
  params?: Record<string, string>,
): string {
  const langKey = lang in messages ? lang : "en";
  let text: string =
    (messages as Record<string, Record<string, string>>)[langKey]?.[key] ??
    (messages as Record<string, Record<string, string>>)["en"]?.[key] ??
    key;

  if (params) {
    text = text.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
  }

  return text;
}
