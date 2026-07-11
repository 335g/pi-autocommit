import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatFullMessage, generateCommitMessage } from "./commit-message.js";
import { COMMIT_TYPES } from "./commit-types.js";
import type { PiAutocommitConfig } from "./config.js";
import { isJapanese } from "./config.js";
import { parseNameStatus } from "./git-parser.js";
import { hasScopeMapping, injectScopeIntoMessage, resolveScope } from "./scope-resolver.js";

/**
 * Commit prompt module — the deep module owning prompt assembly, the LLM-call
 * adapter, response cleanup, and deterministic scope injection for commit
 * messages.
 *
 * Two interface methods:
 * - {@link completeSingleMessage} — single-commit generation, falls back to
 *   the heuristic when the LLM is unavailable.
 * - {@link completeCommitGroups} — commit-group proposition; throws on
 *   inference failure.
 *
 * Behind the seam: language switching rules, the COMMIT_TYPES reference, the
 * scope-mapping subject-format rule, the LLM adapter (lazily imported by
 * default, injectable for tests), response cleanup, group parsing, scope
 * injection, and the heuristic fallback.
 */

// ── Port: the LLM adapter (ports & adapters — two adapters ⇒ real seam) ──

/**
 * Adapter for the LLM completion call.
 *
 * Production: lazily imported `completeSimple` from `@earendil-works/pi-ai/compat`.
 * Tests: an in-memory fake implementing the same shape. Accepting this as an
 * optional injected dependency keeps the seam real (two adapters) while
 * letting production callers omit it for zero ceremony.
 */
export type CompleteFn = (
  model: Model<Api>,
  context: {
    systemPrompt: string;
    messages: { role: "user"; content: string; timestamp: number }[];
  },
) => Promise<{ content: Array<{ type: "string"; text?: string }> }>;

/** Lazily load the production `completeSimple` adapter. */
async function loadDefaultComplete(): Promise<CompleteFn> {
  const { completeSimple } = await import("@earendil-works/pi-ai/compat");
  return completeSimple as unknown as CompleteFn;
}

// ── Input types ───────────────────────────────────────────

/** Raw git materials for the single-commit path (the high-frequency caller). */
export interface SingleCommitInput {
  /** `git diff --cached` output. */
  diff: string;
  /** `git diff --cached --name-status` output. Used for scope injection and heuristic. */
  nameStatus: string;
  /** `git diff --cached --stat` output. Used by the heuristic fallback. */
  stat: string;
}

/** Raw git materials for the commit-group proposition path. */
export interface GroupsInput {
  /** `git diff --cached` output. */
  diff: string;
  /** Assistant reasoning from the agent loop (build via {@link extractAssistantContext}). */
  reasoning: string;
}

/** One logical commit produced by the reorganiser. */
export interface CommitGroup {
  /** Full Conventional Commits message (subject + optional body/footer). */
  message: string;
  /** Files that belong exclusively to this commit. */
  files: string[];
}

// ── Shared private helpers ────────────────────────────────

/** Language-aware subject instruction. */
function subjectLangInstruction(config: PiAutocommitConfig): string {
  return isJapanese(config)
    ? "Write the subject in Japanese (日本語). No period, 50 chars or fewer."
    : "English, imperative present tense, lowercase, no period, 50 chars or fewer.";
}

/** Language-aware body instruction. */
function bodyLangInstruction(config: PiAutocommitConfig): string {
  return isJapanese(config)
    ? "Write the body in Japanese (日本語)."
    : "Write the body in English.";
}

/** The type reference block shared by both prompt variants. */
function typeReferenceBlock(): string[] {
  return [
    "",
    "Type reference (pick the most significant one):",
    ...Object.entries(COMMIT_TYPES).map(
      ([type, desc]) => `  ${type.padEnd(9)}— ${desc}`,
    ),
  ];
}

/**
 * Extract non-empty text blocks from a content array.
 *
 * Shared by adapter-response cleanup and assistant-context extraction.
 * Uses a structural type so it works for both the adapter's content shape
 * and the agent-loop message content shape without importing either.
 */
function extractTextBlocks(
  blocks: ReadonlyArray<unknown>,
): Array<{ type: "text"; text: string }> {
  return blocks.filter(
    (c): c is { type: "text"; text: string } =>
      typeof c === "object" &&
      c !== null &&
      (c as { type?: string }).type === "text" &&
      !!(c as { text?: string }).text,
  );
}

/** Extract text from an adapter response (filter·map·join·trim). */
function extractText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return extractTextBlocks(result.content)
    .map((c) => c.text)
    .join("\n")
    .trim();
}

/**
 * Strip common LLM artifacts from the raw response:
 * - Markdown code fences (```...```)
 * - Inline backtick wrapping
 * - "Commit message:" prefix
 * - Extra empty lines
 */
function cleanupResponse(raw: string): string {
  let text = raw;

  // Remove markdown code fences (```...```)
  text = text.replace(/^```[\s\S]*?\n/, "");
  text = text.replace(/\n```\s*$/, "");

  // Remove inline backtick wrapping around the whole message
  text = text.replace(/^`([\s\S]*)`$/, "$1");

  // Remove echoed "Commit message:" prefix
  text = text.replace(/^Commit message:\s*/i, "");

  // Collapse 3+ consecutive newlines to 2
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// ── Public helper ─────────────────────────────────────────

/**
 * Extract assistant reasoning text from agent-loop messages.
 *
 * Uses a structural type so the module does not import pi-coding-agent types;
 * `AgentEndEvent["messages"]` satisfies this shape and can be passed through
 * without conversion. Assistant messages are joined with a `---` separator so
 * the reorganiser can see the agent's intended reasoning across turns.
 */
export function extractAssistantContext(
  messages: ReadonlyArray<unknown>,
): string {
  const parts: string[] = [];

  for (const raw of messages) {
    const message = raw as { role?: string; content?: unknown };
    if (message.role !== "assistant") {
      continue;
    }

    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = extractTextBlocks(blocks)
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (text) {
      parts.push(text);
    }
  }

  return parts.join("\n\n---\n\n");
}

// ── Interface method 2: completeCommitGroups ───────────────

/**
 * Parse an LLM response into commit groups.
 *
 * Expected format (N starts at 1):
 *
 *   === COMMIT N ===
 *   type(scope): description
 *
 *   Body line.
 *   === FILES ===
 *   path/to/file1.ts
 *   path/to/file2.ts
 *   === END ===
 */
function parseCommitGroups(text: string): CommitGroup[] {
  const groups: CommitGroup[] = [];

  const parts = text.split(/===\s*COMMIT\s*\d+\s*===/);
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    if (!block) continue;

    const [messageAndFilesRaw] = block.split("=== END ===");
    if (!messageAndFilesRaw) continue;

    const [messageRaw, filesRaw] = messageAndFilesRaw.split("=== FILES ===");
    if (!messageRaw || !filesRaw) continue;

    const message = messageRaw.trim();
    const files = filesRaw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    if (message && files.length > 0) {
      groups.push({ message, files });
    }
  }

  return groups;
}

/** Build the commit-group-proposition system prompt. */
function buildGroupsSystemPrompt(config: PiAutocommitConfig): string {
  const scopeManaged = hasScopeMapping(config);

  const subjectFormat = scopeManaged
    ? "Subject format: `type: brief summary` — do NOT add a scope; the scope is applied automatically from the changed paths."
    : "Subject format: `type(scope): brief summary`";

  const rules = [
    "You are reorganising checkpoint commits into logical Conventional Commits.",
    "",
    "Rules:",
    "- Split changes into coherent groups. Each group should represent one self-contained change.",
    "- Order groups by dependency: foundational changes first, dependent changes later.",
    "- Every file must appear in exactly ONE group. No overlaps, no omissions.",
    "- If the diff is too small to split meaningfully, output a single group.",
    "",
    subjectFormat,
    `Subject: ${subjectLangInstruction(config)}`,
    `Body: describe what changed and why. ${bodyLangInstruction(config)}`,
    "Footer: add `BREAKING CHANGE: ...` when there is a breaking change.",
  ];

  rules.push(
    ...typeReferenceBlock(),
    "",
    "Output format — repeat for each group:",
    "",
    "=== COMMIT N ===",
    scopeManaged
      ? "type: description (no scope — it will be added automatically)"
      : "type(scope): description",
    "",
    "Body paragraph(s).",
    "=== FILES ===",
    "relative/path/to/file1.ts",
    "relative/path/to/file2.ts",
    "=== END ===",
    "",
    "Output ONLY the commit groups. No explanations, no markdown fences.",
  );

  return rules.join("\n");
}

/** Build the commit-group-proposition user content. */
function buildGroupsUserContent(diff: string, reasoning: string): string {
  const sections: string[] = [];

  if (reasoning) {
    sections.push("--- Agent reasoning ---");
    sections.push(reasoning);
    sections.push("");
  }

  sections.push("--- Staged changes ---");
  sections.push(diff);
  sections.push("");
  sections.push("Split the staged changes into logical Conventional Commits.");

  return sections.join("\n");
}

/**
 * Propose a split of the staged change set into logical commit groups.
 *
 * Invariants:
 * - Returns `CommitGroup[]` (maybe empty). Never null/undefined.
 * - Group count is decided by the LLM (no heuristic for groups).
 * - When a scope mapping is configured (ADR-0003), each group's message has
 *   the scope injected deterministically from that group's files.
 * - `complete` omitted → lazily imports `completeSimple` for production.
 *
 * Error modes: throws on LLM response unparseable/empty or model
 * unavailable. The caller (reorganiser) catches and falls back to a single
 * commit via {@link completeSingleMessage} — so the silent double-LLM
 * roundtrip disappears as a consequence of depth.
 */
export async function completeCommitGroups(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  input: GroupsInput,
  complete?: CompleteFn,
): Promise<CommitGroup[]> {
  const scopeManaged = hasScopeMapping(config);
  const systemPrompt = buildGroupsSystemPrompt(config);
  const userContent = buildGroupsUserContent(input.diff, input.reasoning);

  const adapter = complete ?? (await loadDefaultComplete());

  const model = await resolveModelForConfig(ctx, config);
  if (!model) {
    throw new Error("No model available");
  }

  const result = await adapter(model, {
    systemPrompt,
    messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
  });

  const text = extractText(result);
  if (!text) {
    throw new Error("Empty reorganiser response");
  }

  const cleaned = cleanupResponse(text);
  const groups = parseCommitGroups(cleaned);

  if (scopeManaged) {
    for (const group of groups) {
      group.message = injectScopeIntoMessage(group.message, group.files, config);
    }
  }

  return groups;
}

// ── Interface method 1: completeSingleMessage ─────────────

/** Resolve the model to use (delegates to the existing port in llm-commit). */
async function resolveModelForConfig(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
): Promise<Model<Api> | undefined> {
  const { resolveModel } = await import("./llm-commit.js");
  return resolveModel(ctx, config);
}

/**
 * Build the single-message system prompt.
 */
function buildSingleSystemPrompt(config: PiAutocommitConfig): string {
  const scopeManaged = hasScopeMapping(config);

  const rules = [
    scopeManaged
      ? "Subject format: `type: brief summary` — do NOT add a scope; the scope is applied automatically from the changed paths."
      : "Subject format: `type(scope): brief summary`",
    `Subject: ${subjectLangInstruction(config)}`,
    `Body: list each changed file, describe what changed and why. ${bodyLangInstruction(config)}`,
    "Footer: add `BREAKING CHANGE: ...` when there is a breaking change.",
    "",
    "When a change spans multiple types, select the most significant one and",
    "describe the rest in the body.",
  ];

  return [
    "You are a commit message generator. Generate a Conventional Commits",
    "commit message for the given staged changes.",
    "",
    "--- Rules ---",
    ...rules,
    ...typeReferenceBlock(),
    "",
    scopeManaged
      ? "Scope: do not include one. The scope will be inserted automatically based on the changed paths."
      : "Scope: describe the affected area in parentheses if meaningful. There is no fixed list; infer from the changed paths.",
    "",
    "Output ONLY the commit message — no explanations, no markdown fences, no extra text.",
  ].join("\n");
}

/** Build the single-message user content from raw git materials. */
function buildSingleUserContent(diff: string): string {
  return ["--- Staged changes ---", diff, "", "Commit message:"].join("\n");
}

/** Heuristic fallback: path-determined Conventional Commits message. */
function heuristicSingleMessage(
  input: SingleCommitInput,
  config: PiAutocommitConfig,
): string {
  const fallback = generateCommitMessage(
    input.nameStatus,
    input.stat,
    input.diff,
    config,
  );
  return formatFullMessage(fallback);
}

/**
 * Generate one Conventional Commits message for a staged change set.
 *
 * Invariants:
 * - Always returns a non-empty string — never throws on LLM failure.
 * - LLM unavailable or empty response → heuristic fallback.
 * - When a scope mapping is configured (ADR-0003), the scope is injected
 *   deterministically from the changed paths after the LLM responds.
 * - `complete` omitted → lazily imports `completeSimple` for production.
 *
 * Error modes: no throw. LLM errors, empty responses, import failures all
 * fall through to the heuristic.
 */
export async function completeSingleMessage(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  input: SingleCommitInput,
  complete?: CompleteFn,
): Promise<string> {
  const scopeManaged = hasScopeMapping(config);
  const systemPrompt = buildSingleSystemPrompt(config);
  const userContent = buildSingleUserContent(input.diff);

  const adapter = complete ?? (await loadDefaultComplete());

  try {
    const model = await resolveModelForConfig(ctx, config);
    if (!model) {
      throw new Error("No model available");
    }

    const result = await adapter(model, {
      systemPrompt,
      messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
    });

    const text = extractText(result);
    if (!text) {
      throw new Error("Empty response");
    }

    const cleaned = cleanupResponse(text);
    if (scopeManaged) {
      const paths = parseNameStatus(input.nameStatus).map((e) => e.path);
      return injectScopeIntoMessage(cleaned, paths, config);
    }
    return cleaned;
  } catch {
    // LLM path failed — fall through to heuristic.
    return heuristicSingleMessage(input, config);
  }
}