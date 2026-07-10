import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { PiGitConfig } from "./config.js";
import { GitOperations } from "./git-operations.js";
import { generateCommitMessageWithLLM, resolveModel } from "./llm-commit.js";
import { hasNoBody, isJapanese } from "./config.js";
import { COMMIT_TYPES } from "./commit-types.js";
import type { PipelineEvent, OrganizerResult } from "./commit-events.js";

/** Marker used for checkpoint commits created at `turn_end`. */
export const WIP_COMMIT_MARKER = "wip(checkpoint):";

/** One logical commit produced by the reorganiser. */
export interface CommitGroup {
  /** Full Conventional Commits message (subject + optional body/footer). */
  message: string;
  /** Files that belong exclusively to this commit. */
  files: string[];
}

/**
 * At `agent_end`, detect any WIP checkpoint commits created during the agent
 * loop and reorganise them into logical Conventional Commits.
 *
 * The function uses the current model to analyse the combined diff and the
 * assistant's own explanations (from `event.messages`) to decide how to split
 * the changes. If the LLM call fails or the response cannot be parsed, it
 * falls back to a single Conventional Commit containing all changes.
 */
export async function organizeWipCommits(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: PiGitConfig,
  event: AgentEndEvent,
): Promise<OrganizerResult> {
  const git = new GitOperations(pi);
  const events: PipelineEvent[] = [];
  let organised = false;

  if (!(await git.isInsideGitRepo())) {
    return { events, organised: false };
  }

  const wipCount = await git.countWipCommits(WIP_COMMIT_MARKER);
  if (wipCount === 0) {
    events.push({ type: "stage-changed", hasChanges: await git.checkUncommittedChanges() });
    return { events, organised: false };
  }

  // Undo the WIP commits but keep all their changes staged.
  await git.resetSoft(wipCount);

  try {
    const groups = await proposeCommitGroups(pi, ctx, config, event);
    if (groups.length === 0) {
      // No logical groups: fall back to one commit.
      await fallbackSingleCommit(pi, ctx, config, git, events);
      organised = true;
      events.push({ type: "stage-changed", hasChanges: await git.checkUncommittedChanges() });
      return { events, organised };
    }

    // Stage and commit each logical group in order.
    for (const group of groups) {
      await git.unstageAll();
      await git.stageFiles(group.files);
      const result = await git.commit(group.message);
      if (result.code !== 0) {
        throw new Error(
          `Commit failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
        );
      }
    }

    events.push({
      type: "organised",
      checkpointCount: wipCount,
      commitCount: groups.length,
    });
    organised = true;
    events.push({ type: "stage-changed", hasChanges: await git.checkUncommittedChanges() });
    return { events, organised };
  } catch (error) {
    // Fall back to a single commit so WIP commits are not left half-organised.
    try {
      await git.stageAll();
      await fallbackSingleCommit(pi, ctx, config, git, events);
      organised = true;
    } catch {
      const message =
        error instanceof Error ? error.message : String(error);
      events.push({
        type: "error",
        message: `commitEveryTurn: reorganisation failed — ${message}`,
      });
    }
    events.push({ type: "stage-changed", hasChanges: await git.checkUncommittedChanges() });
    return { events, organised };
  }
}

/**
 * Ask the LLM to split the staged diff into logical commit groups.
 *
 * The prompt includes the assistant's own messages from the agent loop so the
 * LLM can understand the original intent behind the changes.
 */
async function proposeCommitGroups(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: PiGitConfig,
  event: AgentEndEvent,
): Promise<CommitGroup[]> {
  const model = resolveModel(ctx, config);
  if (!model) {
    throw new Error("No model available");
  }

  const { completeSimple } = await import("@earendil-works/pi-ai/compat");

  const git = new GitOperations(pi);
  const diff = await git.getStagedDiff();
  if (!diff) {
    return [];
  }

  const assistantContext = extractAssistantContext(event.messages);
  const systemPrompt = buildOrganizerSystemPrompt(config);
  const userContent = buildOrganizerUserContent(diff, assistantContext);

  const result = await completeSimple(model, {
    systemPrompt,
    messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
  });

  const text = result.content
    .filter(
      (c): c is { type: "text"; text: string } =>
        c.type === "text" && !!c.text,
    )
    .map((c) => c.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Empty reorganiser response");
  }

  return parseCommitGroups(text);
}

/**
 * Extract text from assistant messages to give the reorganiser context about
 * what the agent intended to do.
 */
function extractAssistantContext(messages: AgentEndEvent["messages"]): string {
  const parts: string[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    const text = message.content
      .filter(
        (c): c is { type: "text"; text: string } =>
          c.type === "text" && !!c.text,
      )
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (text) {
      parts.push(text);
    }
  }

  return parts.join("\n\n---\n\n");
}

function buildOrganizerSystemPrompt(config: PiGitConfig): string {
  const lang = isJapanese(config) ? "ja" : "en";
  const noBody = hasNoBody(config);

  const subjectLangInstruction =
    lang === "ja"
      ? "Write the subject in Japanese (日本語). No period, 50 chars or fewer."
      : "English, imperative present tense, lowercase, no period, 50 chars or fewer.";

  const bodyLangInstruction = noBody
    ? ""
    : lang === "ja"
      ? "Write the body in Japanese (日本語)."
      : "Write the body in English.";

  const rules = [
    "You are reorganising checkpoint commits into logical Conventional Commits.",
    "",
    "Rules:",
    "- Split changes into coherent groups. Each group should represent one self-contained change.",
    "- Order groups by dependency: foundational changes first, dependent changes later.",
    "- Every file must appear in exactly ONE group. No overlaps, no omissions.",
    "- If the diff is too small to split meaningfully, output a single group.",
    "",
    "Subject format: `type(scope): brief summary`",
    `Subject: ${subjectLangInstruction}`,
  ];

  if (noBody) {
    rules.push("Body: NONE — output ONLY the subject line, no body.");
    rules.push(
      "Footer: add `BREAKING CHANGE: ...` when there is a breaking change (optional).",
    );
  } else {
    rules.push(
      `Body: describe what changed and why. ${bodyLangInstruction}`,
    );
    rules.push(
      "Footer: add `BREAKING CHANGE: ...` when there is a breaking change.",
    );
  }

  rules.push(
    "",
    "Type reference (pick the most significant one):",
    ...Object.entries(COMMIT_TYPES).map(
      ([type, desc]) => `  ${type.padEnd(9)}— ${desc}`,
    ),
    "",
    "Output format — repeat for each group:",
    "",
    "=== COMMIT N ===",
    "type(scope): description",
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

function buildOrganizerUserContent(
  diff: string,
  assistantContext: string,
): string {
  const sections: string[] = [];

  if (assistantContext) {
    sections.push("--- Agent reasoning ---");
    sections.push(assistantContext);
    sections.push("");
  }

  sections.push("--- Staged changes ---");
  sections.push(diff);
  sections.push("");
  sections.push("Split the staged changes into logical Conventional Commits.");

  return sections.join("\n");
}

/**
 * Parse the LLM response into commit groups.
 *
 * Exported for testing.
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
export function parseCommitGroups(text: string): CommitGroup[] {
  const groups: CommitGroup[] = [];

  // Split on commit markers, dropping anything before the first one.
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

/**
 * Fall back to a single Conventional Commit for all staged changes.
 *
 * Accepts an `events` array so the caller can collect the fallback notification.
 */
async function fallbackSingleCommit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: PiGitConfig,
  git: GitOperations,
  events: PipelineEvent[],
): Promise<void> {
  const stagedNameStatus = await git.getStagedNameStatus();
  const stagedStat = await git.getStagedStat();
  const stagedDiff = await git.getStagedDiff();

  const message = await generateCommitMessageWithLLM(
    pi,
    ctx,
    stagedNameStatus,
    stagedStat,
    stagedDiff,
    config,
  );

  const result = await git.commit(message);
  if (result.code !== 0) {
    throw new Error(
      `Fallback commit failed (code ${result.code}): ${result.stderr.trim() || "Unknown error"}`,
    );
  }

  events.push({
    type: "fallback",
    message: `Reorganisation fell back to a single commit:\n${message.split("\n")[0]}`,
  });
}
