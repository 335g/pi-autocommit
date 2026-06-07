/**
 * Auto-commit message generation from conversation history.
 *
 * When auto-agg-commit triggers after agent_end, skips hunk analysis
 * and instead generates a commit message from the user's prompts
 * and assistant's responses.
 */

import { aiComplete } from "./ai.js";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { diagIncr } from "../utils/diagnostics.js";
import { t } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import { sanitizeCommitMessage } from "./commit-message.js";

interface SimpleMessage {
  role: string;
  content: string | unknown;
}

/** Truncate text to approximately maxChars, keeping whole words at boundaries */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.substring(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  // If no space found within reasonable range, just cut at maxChars
  if (lastSpace > maxChars * 0.7) return slice.substring(0, lastSpace) + "...";
  return slice + "...";
}

/** Generic commit message patterns — messages matching these lack specificity */
const GENERIC_MESSAGE_PATTERNS: RegExp[] = [
  /^chore:\s*apply\s*changes?\s*$/i,
  /^chore:\s*update\s*(files?)?\s*$/i,
  /^chore:\s*commit\s*changes?\s*$/i,
  /^chore:\s*modify\s*(files?)?\s*$/i,
  /^chore:\s*update\s+\S+\s*$/i,
  /^(feat|fix|chore|docs|style|refactor|test):\s*.{0,10}$/i,
];

/** Heuristic: is this commit message too generic to be useful? */
function isGenericMessage(message: string): boolean {
  const m = message.trim();
  if (m.length < 12) return true;
  return GENERIC_MESSAGE_PATTERNS.some((p) => p.test(m));
}

/** Derive a commit-message candidate from the user's last message. */
function userMessageToCandidate(userMessage: string): string {
  let text = userMessage
    .replace(/[。.！!？?]$/, "")
    .replace(/お願いします$/, "")
    .replace(/してください$/, "")
    .replace(/して$/, "")
    .replace(/\bplease\b/gi, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";

  // Infer Conventional Commit type from keywords
  let type = "chore";
  if (/修正|fix|bug|バグ|不具合|error|エラー|直[しす]|訂正/i.test(text))
    type = "fix";
  else if (
    /追加|add|feature|機能|実装|implement|作[ってり]|作成|新規/i.test(text)
  )
    type = "feat";
  else if (/docs|ドキュメント|readme|資料|文書/i.test(text)) type = "docs";
  else if (/refactor|リファクタ|整理|改善|改修/i.test(text)) type = "refactor";
  else if (/test|テスト|spec/i.test(text)) type = "test";
  else if (/削除|remove|delete|消[しす]/i.test(text)) type = "chore";

  const prefix = `${type}: `;
  const maxBody = 50 - prefix.length;
  if (text.length > maxBody) {
    const cut = text.substring(0, maxBody - 1);
    const lastBoundary = Math.max(
      cut.lastIndexOf("、"),
      cut.lastIndexOf("，"),
      cut.lastIndexOf(" "),
    );
    text =
      lastBoundary > maxBody * 0.5
        ? cut.substring(0, lastBoundary) + "…"
        : cut + "…";
  }

  return `${prefix}${text}`;
}

/** Heuristic specificity score for a commit message. Higher = more specific. */
function specificityScore(message: string): number {
  let score = 0;
  const m = message.replace(
    /^(feat|fix|chore|docs|style|refactor|test|perf|ci|build|revert)(\(.+?\))?!?:\s*/i,
    "",
  );

  // Length contributes (up to a point)
  score += Math.min(m.length, 30) * 0.3;

  // Penalize generic words
  const genericWords =
    /\b(change|update|modify|fix|apply|commit|files?|stuff|things?)\b/gi;
  const genericCount = (m.match(genericWords) || []).length;
  score -= genericCount * 2;

  // Reward specific nouns (CamelCase, ALL_CAPS, or mixed-case words)
  const specificTerms = m.match(/[A-Z][a-z]+|[a-z]+[A-Z]|[A-Z]{2,}/g);
  score += (specificTerms || []).length * 3;

  // Reward concrete action verbs
  const concreteVerbs =
    /\b(add|implement|create|remove|refactor|extract|rename|optimize|migrate|configure|integrate|replace|split|merge|enhance|introduce|deprecate|upgrade|downgrade|support|handle|prevent|allow|restrict|validate|sanitize|normalize|format|generate|bump|release|deploy|fix|resolve|address|correct|adjust|tweak|improve|streamline|simplify|reduce|increase|enable|disable|expose|hide|export|import|wire|connect|disconnect|setup|teardown)\b/gi;
  score += (m.match(concreteVerbs) || []).length * 2;

  return score;
}

/**
 * If the generated message is generic, compare it against a candidate derived
 * from the user's last message and return the more specific one.
 *
 * Uses AI comparison when available; falls back to heuristic scoring.
 */
async function refineMessageIfGeneric(
  ctx: ExtensionContext,
  generatedMessage: string,
  messages: SimpleMessage[],
  changedFiles: string[],
  lang: string,
): Promise<string> {
  // Only refine if the generated message seems generic
  if (!isGenericMessage(generatedMessage)) {
    return generatedMessage;
  }

  diagIncr("msgIsGeneric");

  // Get the last user message
  const userMessages = collectMessagesByRole(messages, "user");
  if (userMessages.length === 0) {
    return generatedMessage;
  }

  const lastUserMessage = userMessages[0]; // newest first
  const userCandidate = userMessageToCandidate(lastUserMessage);
  if (!userCandidate) {
    return generatedMessage;
  }

  // Quick heuristic guard: skip AI if one candidate is clearly better
  const genScore = specificityScore(generatedMessage);
  const userScore = specificityScore(userCandidate);
  if (userScore > genScore + 5) return userCandidate;
  if (genScore > userScore + 5) return generatedMessage;

  // Scores are close — ask AI to decide
  diagIncr("msgRefineUsedAI");
  try {
    const comparisonPrompt = t(lang, "autoCommitMsg.comparePrompt", {
      candidateA: generatedMessage,
      candidateB: userCandidate,
      files: changedFiles.join(", "),
    });

    const result = await aiComplete(ctx, {
      systemPrompt: t(lang, "autoCommitMsg.compareSystemPrompt"),
      userMessage: comparisonPrompt,
      maxTokens: 100,
      temperature: 0,
    });

    if (!result) {
      // AI unavailable — fall back to heuristic scoring
      return userScore > genScore ? userCandidate : generatedMessage;
    }

    const text = result.text
      // Strip code fences if the model wraps the message
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/\n?```$/i, "")
      .trim();

    // Validate the AI's choice: if it contains the user candidate, prefer that
    if (
      userCandidate.length >= 15 &&
      text.includes(userCandidate.substring(0, 15))
    ) {
      return userCandidate;
    }
    // If it contains the generated message's subject, keep it
    if (
      generatedMessage.length >= 15 &&
      text.includes(generatedMessage.substring(0, 15))
    ) {
      return generatedMessage;
    }

    // Fallback: use heuristic scores
    return userScore > genScore ? userCandidate : generatedMessage;
  } catch {
    // AI failed — fall back to heuristic scoring
    return userScore > genScore ? userCandidate : generatedMessage;
  }
}

function getSystemPrompt(lang: string): string {
  return t(lang, "autoCommitMsg.systemPrompt");
}

function extractTextContent(content: string | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: string; text?: string } =>
          typeof c === "object" && c !== null,
      )
      .map((c) => c.text || "")
      .join("\n");
  }
  return "";
}

/** Collect all messages of a given role, newest first */
function collectMessagesByRole(
  messages: SimpleMessage[],
  role: string,
): string[] {
  const result: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) {
      const text = extractTextContent(messages[i].content);
      if (text.trim()) {
        result.push(text);
      }
    }
  }
  return result;
}

function buildPrompt(
  userMessages: string[],
  assistantMessages: string[],
  changedFiles: string[],
  lang: string,
): string {
  // Budget: keep the whole prompt under ~4000 chars to leave room for system prompt + response
  const MAX_USER_CHARS = 2000;
  const MAX_ASSISTANT_CHARS = 800;
  const MAX_FILES_CHARS = 800;

  // Build user messages section (newest first, most relevant last in display)
  const userLines: string[] = [];
  let userBudget = MAX_USER_CHARS;
  for (const msg of userMessages.reverse()) {
    if (userBudget <= 0) break;
    const truncated = truncate(msg, userBudget);
    userLines.push(truncated);
    userBudget -= truncated.length;
  }
  const userStr = userLines.reverse().join("\n---\n");
  const noData = t(lang, "autoCommitMsg.noData");
  const userSection = userStr || noData;

  // Build assistant messages section
  const assistantLines: string[] = [];
  let assistantBudget = MAX_ASSISTANT_CHARS;
  for (const msg of assistantMessages.reverse()) {
    if (assistantBudget <= 0) break;
    const truncated = truncate(msg, assistantBudget);
    assistantLines.push(truncated);
    assistantBudget -= truncated.length;
  }
  const assistantStr = assistantLines.reverse().join("\n---\n");
  const assistantSection = assistantStr || noData;

  // Build files section
  const filesStr = truncate(changedFiles.join(", "), MAX_FILES_CHARS);
  const filesSection = filesStr || noData;

  const examples = t(lang, "autoCommitMsg.examples");
  return t(lang, "autoCommitMsg.buildPrompt", {
    userSection,
    assistantSection,
    filesSection,
    examples,
  });
}

export async function generateAutoCommitMessage(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  messages: SimpleMessage[],
  changedFiles: string[],
): Promise<string> {
  const lang = getLanguage(ctx.cwd);

  // Collect ALL user messages and assistant messages for rich context
  const userMessages = collectMessagesByRole(messages, "user");
  const assistantMessages = collectMessagesByRole(messages, "assistant");

  if (userMessages.length === 0) {
    return sanitizeCommitMessage(t(lang, "core.applyChanges"), changedFiles);
  }

  try {
    const result = await aiComplete(ctx, {
      systemPrompt: getSystemPrompt(lang),
      userMessage: buildPrompt(
        userMessages,
        assistantMessages,
        changedFiles,
        lang,
      ),
    });

    if (!result) {
      return sanitizeCommitMessage(t(lang, "core.applyChanges"), changedFiles);
    }

    const commitMessage = sanitizeCommitMessage(
      result.text || t(lang, "core.applyChanges"),
      changedFiles,
    );

    // If the generated message is too generic, compare with a user-message
    // candidate and pick the more specific one (heuristic → AI comparison)
    diagIncr("msgRefineTriggered");
    return await refineMessageIfGeneric(
      ctx,
      commitMessage,
      messages,
      changedFiles,
      lang,
    );
  } catch {
    return sanitizeCommitMessage("chore: apply changes", changedFiles);
  }
}
