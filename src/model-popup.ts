import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";

/**
 * Sentinel value for the "use session model" (clear) popup entry.
 *
 * A non-empty, model-namespace-safe sentinel so it can never collide with a
 * real `"provider/modelId"` value returned by the registry.
 */
export const CLEAR_VALUE = "\u0000pi-autocommit-clear";

/** Label for the "use session model" (clear) popup entry. */
export const CLEAR_LABEL = "Use session model (clear)";

/**
 * Max rows the model popup shows before scrolling.
 *
 * Bounds the rendered height so the popup never overflows the terminal,
 * even when hundreds of models are registered. The actual height is
 * `Math.min(items.length, MAX_VISIBLE_MODELS)`; `SelectList` handles the
 * scrolling window and shows a `(n/total)` indicator when truncated.
 */
export const MAX_VISIBLE_MODELS = 10;

/**
 * Build the popup option list as `SelectList` items: clear entry first,
 * then the available models. The current value is marked with `(current)`.
 *
 * The `value` is the raw `"provider/modelId"` string (or `CLEAR_VALUE`), so
 * the selected item round-trips directly into `saveModel` without label
 * parsing.
 */
export function buildModelSelectItems(
  ctx: ExtensionContext,
  currentModel: string | undefined,
): SelectItem[] {
  const labelFor = (label: string, value: string | undefined): string =>
    value === currentModel ? `${label} (current)` : label;

  const items: SelectItem[] = [
    {
      value: CLEAR_VALUE,
      label: labelFor(CLEAR_LABEL, undefined),
      description: "Fall back to the session model.",
    },
  ];

  for (const model of ctx.modelRegistry.getAvailable()) {
    const value = `${model.provider}/${model.id}`;
    items.push({
      value,
      label: labelFor(value, value),
      description: model.name,
    });
  }

  // Mention the current value in case it's no longer in the available list,
  // so the user can see what is configured and switch away from it.
  if (currentModel && !items.some((i) => i.value === currentModel)) {
    items.push({
      value: currentModel,
      label: `${currentModel} (current, unavailable)`,
      description: "Configured model no longer available.",
    });
  }

  return items;
}

/**
 * The number of visible rows the popup should render. Exposed for tests so
 * the bounded-viewport invariant can be asserted independently of the
 * `SelectList` implementation.
 */
export function modelPopupMaxVisible(items: SelectItem[]): number {
  return Math.min(items.length, MAX_VISIBLE_MODELS);
}
