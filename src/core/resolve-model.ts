/**
 * Model resolution helper for pi-git commands.
 *
 * Resolves the AI model to use based on configuration or session context.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAnalysisModel } from "../utils/settings.js";

/** Model name patterns indicating cheap/small models (shared across all modules) */
export const CHEAP_MODEL_PATTERNS: RegExp[] = [
  /mini/i, /flash/i, /nano/i, /lite/i, /small/i, /haiku/i,
];

/** Check if a model ID matches known cheap/small model patterns */
export function isCheapModel(modelId: string | undefined): boolean {
  if (!modelId) return true; // unknown → conservative
  return CHEAP_MODEL_PATTERNS.some((p) => p.test(modelId));
}

/**
 * Resolve the model to use for AI operations.
 *
 * Priority:
 * 1. Configured `analysis_model` in settings (format: "provider/model-id")
 * 2. Current session model (`ctx.model`)
 *
 * @returns The resolved model, or undefined if no model is available
 */
export function resolveModel(ctx: ExtensionContext): Model<Api> | undefined {
  // Try configured model first
  const configuredModel = getAnalysisModel(ctx.cwd);
  if (configuredModel) {
    let found: Model<Api> | undefined;

    const slashIndex = configuredModel.indexOf("/");
    if (slashIndex > 0) {
      // provider/model-id format
      const provider = configuredModel.substring(0, slashIndex);
      const modelId = configuredModel.substring(slashIndex + 1);
      found = ctx.modelRegistry.find(provider, modelId);
    } else {
      // No "/" — search across all providers by model ID
      const available = ctx.modelRegistry.getAvailable();
      found = available.find((m) => m.id === configuredModel);
    }

    if (found) {
      console.log(
        `[pi-git] Using analysis_model: ${found.provider}/${found.id}`,
      );
      return found;
    }

    // Configured model not found — warn and fall back
    console.warn(
      `[pi-git] Configured analysis_model "${configuredModel}" not found. ` +
        `Falling back to session model.`,
    );
  }

  // Fall back to session model
  return ctx.model;
}
