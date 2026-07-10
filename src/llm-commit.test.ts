import assert from "node:assert";
import { describe, it } from "node:test";
import type { PiAutocommitConfig } from "./config.js";
import { resolveModel } from "./llm-commit.js";

/**
 * Minimal stub for the `ModelRegistry` surface used by `resolveModel`.
 */
interface RegistryStub {
  find(): unknown;
  hasConfiguredAuth(): boolean;
}

/**
 * Build a minimal `ExtensionContext`-shaped object with only the fields
 * `resolveModel` touches: `model` and `modelRegistry`.
 */
function makeCtx(
  model: unknown,
  registry: RegistryStub,
): { model: unknown; modelRegistry: RegistryStub } {
  return { model, modelRegistry: registry };
}

void describe("resolveModel", () => {
  void it("returns ctx.model when config.model is unset", () => {
    const sessionModel = { id: "session-model" };
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = { lang: "en", enable: true };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("returns ctx.model when config.model is an empty string", () => {
    const sessionModel = { id: "session-model" };
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = { lang: "en", enable: true, model: "" };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("returns the resolved model when found and configured", () => {
    const sessionModel = { id: "session-model" };
    const configuredModel = { id: "claude-sonnet-4" };
    const registry: RegistryStub = {
      find: () => configuredModel,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = {
      lang: "en",
      enable: true,
      model: "anthropic/claude-sonnet-4",
    };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, configuredModel);
  });

  void it("falls back to ctx.model when model is not found in registry", () => {
    const sessionModel = { id: "session-model" };
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = {
      lang: "en",
      enable: true,
      model: "anthropic/unknown-model",
    };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("falls back to ctx.model when model has no configured auth", () => {
    const sessionModel = { id: "session-model" };
    const unconfiguredModel = { id: "claude-sonnet-4" };
    const registry: RegistryStub = {
      find: () => unconfiguredModel,
      hasConfiguredAuth: () => false,
    };
    const config: PiAutocommitConfig = {
      lang: "en",
      enable: true,
      model: "anthropic/claude-sonnet-4",
    };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("falls back to ctx.model on invalid format (missing slash)", () => {
    const sessionModel = { id: "session-model" };
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = {
      lang: "en",
      enable: true,
      model: "invalid",
    };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("falls back to ctx.model on invalid format (leading slash)", () => {
    const sessionModel = { id: "session-model" };
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = {
      lang: "en",
      enable: true,
      model: "/foo",
    };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("falls back to ctx.model on invalid format (trailing slash)", () => {
    const sessionModel = { id: "session-model" };
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = {
      lang: "en",
      enable: true,
      model: "foo/",
    };

    const result = resolveModel(
      makeCtx(sessionModel, registry) as never,
      config,
    );

    assert.strictEqual(result, sessionModel);
  });

  void it("returns undefined when ctx.model is undefined and config.model unset", () => {
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = { lang: "en", enable: true };

    const result = resolveModel(makeCtx(undefined, registry) as never, config);

    assert.strictEqual(result, undefined);
  });

  void it("returns undefined when fallback triggered and ctx.model is undefined", () => {
    const registry: RegistryStub = {
      find: () => undefined,
      hasConfiguredAuth: () => true,
    };
    const config: PiAutocommitConfig = {
      lang: "en",
      enable: true,
      model: "anthropic/unknown",
    };

    const result = resolveModel(makeCtx(undefined, registry) as never, config);

    assert.strictEqual(result, undefined);
  });
});
