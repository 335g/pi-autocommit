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
import { sanitizeCommitMessage, inferTypeFromFiles } from "./commit-message.js";
import { stripDiffNoise, truncateDiff } from "./diff-analyzer.js";
import { resolveModel } from "./resolve-model.js";

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
  // English patterns
  /^chore:\s*apply\s*changes?\s*$/i,
  /^chore:\s*update\s*(files?)?\s*$/i,
  /^chore:\s*commit\s*changes?\s*$/i,
  /^chore:\s*modify\s*(files?)?\s*$/i,
  /^chore:\s*update\s+\S+\s*$/i,
  /^(feat|fix|chore|docs|style|refactor|test):\s*[a-zA-Z0-9\s]{0,10}$/i,
  // Japanese patterns
  /^(feat|fix|chore|docs|style|refactor|test):\s*(変更|修正|更新|対応|追加|削除|改善|実装|作成|適用|反映|編集)(\s*(を|しました|しました。|を行いました|を実施|を反映|いたしました))?$/i,
  /^chore:\s*(変更を適用|ファイルを更新|更新しました|修正しました)\s*$/i,
];

/** Model ID patterns for cheap/small models — single source of truth */
const CHEAP_MODEL_PATTERNS: RegExp[] = [
  /\bmini\b/i,
  /\bflash\b/i,
  /\bnano\b/i,
  /\blite\b/i,
  /\bsmall\b/i,
  /\bhaiku\b/i,
];

/** Check if a model ID indicates a small/cheap model */
export function isCheapModel(modelId: string): boolean {
  return CHEAP_MODEL_PATTERNS.some((p) => p.test(modelId));
}

/** Determine budget tier for a model: small models get more assistant context */
export function getBudgetMultiplier(
  modelId: string | undefined,
): "small" | "large" {
  if (!modelId) return "small"; // unknown model → conservative
  return isCheapModel(modelId) ? "small" : "large";
}

/** Clean AI output: extract a Conventional Commit message from chatty model output */
export function cleanCommitOutput(raw: string): string {
  let text = raw.trim();

  // Layer 1: Extract from markdown fences (handles non-ASCII info strings)
  const fenceMatch = text.match(/```(?:\w*)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Layer 2: Strip common chat prefixes (English + Japanese)
  const prefixPatterns = [
    /^(?:here\s+is\s+(?:the\s+)?(?:commit\s+)?message[:\s]*)/i,
    /^(?:commit\s+message[:\s]*)/i,
    /^(?:the\s+commit\s+message\s+(?:is|should\s+be)[:\s]*)/i,
    /^(?:sure!?\s*(?:here\s+is\s+)?[:\s]*)/i,
    /^(?:提案するコミットメッセージ[:\s]*)/,
    /^(?:コミットメッセージ[:\s]*)/,
    /^(?:以下がコミットメッセージです[:\s]*)/,
    /^(?:今回のコミット[:\s]*)/,
    /^(?:以下のコミットメッセージを提案します[:\s]*)/,
    /^(?:コミットメッセージを[作成生成]しました[:\s]*)/,
    /^(?:はい[,、]\s*承知しました[。.]?\s*)/,
  ];
  for (const pat of prefixPatterns) {
    text = text.replace(pat, "").trim();
  }

  // Layer 2.5: Strip wrapping backtick pairs (e.g., `feat: add login`)
  text = text.replace(/^`([^`]+)`$/, "$1").trim();

  // Layer 3: Find first line matching Conventional Commit
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const ccLine = lines.find((l) =>
    /^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\(.+?\))?!?:\s/.test(
      l,
    ),
  );
  if (ccLine) return ccLine;

  // Layer 4: Fall back to first non-empty line
  return lines[0] || text;
}

/** Heuristic: is this commit message too generic to be useful? */
export function isGenericMessage(message: string): boolean {
  const m = message.trim();
  if (m.length < 12) return true;
  return GENERIC_MESSAGE_PATTERNS.some((p) => p.test(m));
}

/**
 * Japanese conversational markers that signal a raw user message should NOT
 * be used verbatim as a commit subject.
 */
const CONVERSATIONAL_MARKERS_JA: RegExp[] = [
  /[てで]$/, // 「〜して」「〜で」終わり（未完了/列挙）
  /[。、．，]/, // 文中の句読点（複文の可能性）
  /してください|お願い|ます|です/, // 敬語残り
  /そして|あと|ついでに|あわせて/, // 列挙接続詞
  /も$/, // 「〜も」終わり（列挙の一部）
  /たり$/, // 「〜たり」終わり
  /など|とか/, // ぼかし表現
];

/**
 * Check whether body text (after Conventional Commit prefix) is acceptable
 * as a commit subject, i.e. it does not contain conversational artifacts.
 */
export function isValidCommitSubject(body: string, lang: string): boolean {
  if (lang === "ja") {
    // Truncated by maxBody limit — too long to be a good commit subject
    if (body.endsWith("…")) return false;
    // Too short to carry meaning
    if (body.length < 3) return false;
    // Contains conversational artifacts
    if (CONVERSATIONAL_MARKERS_JA.some((p) => p.test(body))) return false;
  } else {
    // English conversational markers — patterns a user message starts with
    if (CONVERSATIONAL_MARKERS_EN.some((p) => p.test(body))) return false;
    // Question marks or exclamation marks indicate conversational tone
    if (/[?!]$/.test(body)) return false;
    // Too short to carry meaning
    if (body.length < 3) return false;
  }
  return true;
}

/** English conversational markers — patterns a user message starts with */
const CONVERSATIONAL_MARKERS_EN: RegExp[] = [
  /^(can|could|would|will)\s+you\s/i,
  /^please\s/i,
  /^(i|we)\s+(would\s+like|want|need)\s+(you\s+)?to\s/i,
  /^(i'?d\s+like\s+(you\s+)?to\s)/i,
  /^let'?s\s/i,
]

/** Derive a commit-message candidate from the user's last message. */
export function userMessageToCandidate(userMessage: string): string {
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
export function specificityScore(message: string, lang?: string): number {
  let score = 0;
  const m = message.replace(
    /^(feat|fix|chore|docs|style|refactor|test|perf|ci|build|revert)(\(.+?\))?!?:\s*/i,
    "",
  );

  // Length contributes (up to a point)
  score += Math.min(m.length, 30) * 0.3;

  // Penalize generic English words
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

  // Japanese-specific scoring
  if (lang === "ja") {
    // Reward kanji density (proxy for semantic richness)
    const kanjiCount = (m.match(/[\u4e00-\u9faf]/g) || []).length;
    score += Math.min(kanjiCount, 15) * 1.0;
    // Reward katakana technical terms (e.g. ログイン, バリデーション, リファクタ)
    const katakanaTerms = m.match(/[\u30a0-\u30ff]{2,}/g) || [];
    score += katakanaTerms.length * 3;
    // Reward Japanese concrete verbs (parallel to English concreteVerbs)
    const japaneseConcreteVerbs =
      /(追加|実装|作成|削除|修正|改善|整理|統合|分割|移行|更新|導入|廃止|対応|設定|構成|接続)/g;
    score += (m.match(japaneseConcreteVerbs) || []).length * 2;
    // Penalize Japanese generic filler (only at word boundaries)
    const japaneseGenericWords =
      /(変更|修正|更新|対応|適用|反映)(?!\S)/g;
    const jpGenericCount = (m.match(japaneseGenericWords) || []).length;
    score -= jpGenericCount * 2;
    // Penalize overly generic Japanese single-word subjects
    if (
      /^(変更|修正|更新|対応|追加|削除|改善|実装|作成|適用|反映)$/.test(
        m.trim(),
      )
    ) {
      score -= 4;
    }
  }

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

  // Quality gate: reject userCandidate that looks like raw conversation
  const userSubject = userCandidate.replace(/^\w+(\(.*?\))?!?:\s*/, "");
  if (!isValidCommitSubject(userSubject, lang)) {
    // User message is too conversational — keep the AI-generated message
    // even if it is generic. It's still better than raw user text.
    return generatedMessage;
  }

  // Quick heuristic guard: skip AI if one candidate is clearly better
  const genScore = specificityScore(generatedMessage, lang);
  const userScore = specificityScore(userCandidate, lang);
  if (userScore > genScore + 5) return userCandidate;
  if (genScore > userScore + 5) return generatedMessage;

  // Skip AI comparison for known-weak models — their judgment is unreliable.
  // Use the higher heuristic score instead (balanced by specificityScore).
  const model = resolveModel(ctx);
  if (model && isCheapModel(model.id)) {
    return userScore > genScore ? userCandidate : generatedMessage;
  }

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
      // AI unavailable — keep generated message.
      // User-derived candidates are unreliable without AI validation,
      // and the generated message is the safer default for small models.
      return generatedMessage;
    }

    const text = result.text.trim();

    // Parse explicit "A" / "B" vote from the AI
    const voteA = /\bA\b/i.test(text) && !/\bB\b/i.test(text);
    const voteB = /\bB\b/i.test(text) && !/\bA\b/i.test(text);
    if (voteA) return generatedMessage;
    if (voteB) return userCandidate;

    // Both appear — pick the one mentioned last ("Both are good, but B wins")
    const aPos = text.search(/\bA\b/i);
    const bPos = text.search(/\bB\b/i);
    if (aPos >= 0 && bPos >= 0) {
      return bPos > aPos ? userCandidate : generatedMessage;
    }

    // Fallback: try substring matching (for models that echo the message)
    if (
      userCandidate.length >= 15 &&
      text.includes(userCandidate.substring(0, 15))
    ) {
      return userCandidate;
    }
    if (
      generatedMessage.length >= 15 &&
      text.includes(generatedMessage.substring(0, 15))
    ) {
      return generatedMessage;
    }

    // AI couldn't decide — prefer generated message as safer default.
    // Heuristic scoring is English-biased and unreliable for non-English.
    return generatedMessage;
  } catch {
    // AI failed — keep generated message (same reasoning as above)
    return generatedMessage;
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
  diff: string,
  lang: string,
  modelId?: string,
): string {
  // Budget: keep the whole prompt under ~8000 chars.
  // Small models get more assistant context (they can't parse raw diffs well);
  // large models keep the original diff-heavy allocation.
  const budget = getBudgetMultiplier(modelId);
  const MAX_USER_CHARS = 1500;
  const MAX_ASSISTANT_CHARS = budget === "small" ? 2500 : 600;
  const MAX_FILES_CHARS = 500;
  const MAX_DIFF_CHARS = budget === "small" ? 3000 : 5000;

  // Build user messages section (newest first — most relevant context first)
  const userLines: string[] = [];
  let userBudget = MAX_USER_CHARS;
  for (const msg of userMessages) {
    if (userBudget <= 0) break;
    const truncated = truncate(msg, userBudget);
    userLines.push(truncated);
    userBudget -= truncated.length;
  }
  const userStr = userLines.join("\n---\n");
  const noData = t(lang, "autoCommitMsg.noData");
  const userSection = userStr || noData;

  // Build assistant messages section (newest first)
  const assistantLines: string[] = [];
  let assistantBudget = MAX_ASSISTANT_CHARS;
  for (const msg of assistantMessages) {
    if (assistantBudget <= 0) break;
    const truncated = truncate(msg, assistantBudget);
    assistantLines.push(truncated);
    assistantBudget -= truncated.length;
  }
  const assistantStr = assistantLines.join("\n---\n");
  const assistantSection = assistantStr || noData;

  // Build files section
  const filesStr = truncate(changedFiles.join(", "), MAX_FILES_CHARS);
  const filesSection = filesStr || noData;

  // Build diff section (strip noise first, then truncate)
  let diffSection: string;
  if (diff && diff.trim()) {
    const cleaned = stripDiffNoise(diff);
    diffSection = truncateDiff(cleaned, MAX_DIFF_CHARS);
  } else {
    diffSection = t(lang, "autoCommitMsg.noDiffAvailable");
  }

  const examples = t(lang, "autoCommitMsg.examples");
  const prompt = t(lang, "autoCommitMsg.buildPrompt", {
    userSection,
    assistantSection,
    filesSection,
    diffSection,
    examples,
  });

  // Prepend type hints for small models (reuses inferTypeFromFiles from commit-message.ts)
  const isCheap = modelId && isCheapModel(modelId);
  const typeHint = isCheap ? buildTypeHintForMessage(changedFiles) : "";
  return typeHint + prompt;
}

/** Build a type hint string from changed file paths */
export function buildTypeHintForMessage(files: string[]): string {
  const type = inferTypeFromFiles(files);
  if (type === "chore") return ""; // skip if generic — let the AI decide
  return `Hint: based on file paths, the likely commit type is "${type}".\n`;
}

export async function generateAutoCommitMessage(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  messages: SimpleMessage[],
  changedFiles: string[],
  diff: string,
): Promise<string> {
  const lang = getLanguage(ctx.cwd);

  // Collect ALL user messages and assistant messages for rich context
  const userMessages = collectMessagesByRole(messages, "user");
  const assistantMessages = collectMessagesByRole(messages, "assistant");

  if (userMessages.length === 0) {
    return sanitizeCommitMessage(t(lang, "core.applyChanges"), changedFiles);
  }

  try {
    // Resolve model before aiComplete (same path aiComplete uses internally).
    // Pass modelId to buildPrompt for budget gating.
    const modelId = resolveModel(ctx)?.id;
    const isCheap = modelId && isCheapModel(modelId);

    const result = await aiComplete(ctx, {
      systemPrompt: getSystemPrompt(lang),
      userMessage: buildPrompt(
        userMessages,
        assistantMessages,
        changedFiles,
        diff,
        lang,
        modelId,
      ),
      maxTokens: isCheap ? 200 : 1024,
    });

    if (!result) {
      return sanitizeCommitMessage(t(lang, "core.applyChanges"), changedFiles);
    }

    // Clean AI output before sanitization — small models often add chatty
    // prefixes, markdown fences, or explanations around the actual message.
    const cleaned = cleanCommitOutput(
      result.text || t(lang, "core.applyChanges"),
    );
    const commitMessage = sanitizeCommitMessage(cleaned, changedFiles);

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
