/**
 * Auto-commit message generation from conversation history.
 *
 * When auto-agg-commit triggers after agent_end, skips hunk analysis
 * and instead generates a commit message from the user's prompts
 * and assistant's responses.
 */

import type { Context } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { t } from "../utils/lang.js";
import { getLanguage } from "../utils/settings.js";
import { sanitizeCommitMessage } from "./commit-message.js";
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

function getSystemPrompt(lang: string): string {
  return t(lang,
    `あなたはコミットメッセージ生成ツールです。以下の情報から、ユーザーが**何を依頼し、その結果どのような変更が行われたか**を読み取り、Conventional Commit メッセージを1つ生成してください。

最も重要なのは「ユーザーのリクエスト」です。ユーザーが何を求めていたのかを主軸に、コミットメッセージを決定してください。アシスタントの応答と変更ファイル一覧は、そのリクエストがどのように実現されたかを補完する情報です。

ルール:
- type は feat, fix, docs, style, refactor, test, chore から選択
- サブジェクトは50文字以内
- 命令形を使用する
- スコープは推測できる場合のみ含める
- 日本語で記述

返答はメッセージ文字列のみ。説明やコードフェンスは不要。`,
    `You are a commit message generator. From the following information, understand what the user requested and what changes were made as a result, then generate a single Conventional Commit message.

The most important input is the "user's request". Use it as the primary driver for the commit message. The assistant's response and changed files list are supplementary - they describe how the request was fulfilled.

Rules:
- Choose type from: feat, fix, docs, style, refactor, test, chore
- Keep subject under 50 characters
- Use imperative mood
- Include scope only if clearly inferable

Return ONLY the commit message string. No explanations or code fences.`,
  );
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

/**
 * Count total characters across all collected messages for truncation budgeting.
 */
function totalChars(collected: string[]): number {
  return collected.reduce((sum, s) => sum + s.length, 0);
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
  const userSection = userLines.reverse().join("\n---\n");

  // Build assistant messages section
  const assistantLines: string[] = [];
  let assistantBudget = MAX_ASSISTANT_CHARS;
  for (const msg of assistantMessages.reverse()) {
    if (assistantBudget <= 0) break;
    const truncated = truncate(msg, assistantBudget);
    assistantLines.push(truncated);
    assistantBudget -= truncated.length;
  }
  const assistantSection = assistantLines.reverse().join("\n---\n");

  // Build files section
  const filesStr = truncate(changedFiles.join(", "), MAX_FILES_CHARS);

  return t(lang,
    `=== ユーザーのリクエスト（最重要） ===
${userSection || "(なし)"}

=== アシスタントの応答（参考） ===
${assistantSection || "(なし)"}

=== 変更されたファイル ===
${filesStr || "(なし)"}

上記の「ユーザーのリクエスト」を主軸に、変更の意図を最もよく表す Conventional Commit メッセージを1つ生成してください。`,
    `=== USER REQUEST (primary) ===
${userSection || "(none)"}

=== ASSISTANT RESPONSE (reference) ===
${assistantSection || "(none)"}

=== CHANGED FILES ===
${filesStr || "(none)"}

Based primarily on the USER REQUEST above, generate a single Conventional Commit message that best captures the intent of the changes.`,
  );
}

export async function generateAutoCommitMessage(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  messages: SimpleMessage[],
  changedFiles: string[],
): Promise<string> {
  const model = resolveModel(ctx);
  if (!model) {
    return sanitizeCommitMessage("chore: apply changes", changedFiles);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return sanitizeCommitMessage("chore: apply changes", changedFiles);
  }

  const lang = getLanguage(ctx.cwd);

  // Collect ALL user messages and assistant messages for rich context
  const userMessages = collectMessagesByRole(messages, "user");
  const assistantMessages = collectMessagesByRole(messages, "assistant");

  if (userMessages.length === 0) {
    return sanitizeCommitMessage("chore: apply changes", changedFiles);
  }

  try {
    const promptContext: Context = {
      systemPrompt: getSystemPrompt(lang),
      messages: [
        {
          role: "user",
          content: buildPrompt(
            userMessages,
            assistantMessages,
            changedFiles,
            lang,
          ),
          timestamp: Date.now(),
        },
      ],
    };

    const result = await completeSimple(model, promptContext, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: ctx.signal,
      reasoning: "minimal",
    });

    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    return sanitizeCommitMessage(text || "chore: apply changes", changedFiles);
  } catch {
    return sanitizeCommitMessage("chore: apply changes", changedFiles);
  }
}
