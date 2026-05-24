/**
 * Auto-commit message generation from conversation history.
 *
 * When auto-agg-commit triggers after agent_end, skips hunk analysis
 * and instead generates a commit message from the user's prompt
 * and assistant's response for speed.
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getLanguage } from "../utils/settings.js";
import { sanitizeCommitMessage } from "./commit-message.js";

interface SimpleMessage {
	role: string;
	content: string | unknown;
}

function getSystemPrompt(lang: string): string {
	const isJapanese =
		lang === "ja" || lang === "ja-JP" || lang === "japanese";

	if (isJapanese) {
		return `あなたはコミットメッセージ生成ツールです。ユーザーのリクエストとアシスタントの応答内容から、変更の意図を推測して Conventional Commit メッセージを1つ生成してください。

ルール:
- type は feat, fix, docs, style, refactor, test, chore から選択
- サブジェクトは50文字以内
- 命令形を使用する
- スコープは推測できる場合のみ含める
- 日本語で記述

返答はメッセージ文字列のみ。説明やコードフェンスは不要。`;
	}

	return `You are a commit message generator. Based on the user's request and the assistant's response, infer the intent of the changes and generate a single Conventional Commit message.

Rules:
- Choose type from: feat, fix, docs, style, refactor, test, chore
- Keep subject under 50 characters
- Use imperative mood
- Include scope only if clearly inferable

Return ONLY the commit message string. No explanations or code fences.`;
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
			.join("");
	}
	return "";
}

function findLastMessageByRole(
	messages: SimpleMessage[],
	role: string,
): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === role) {
			return extractTextContent(messages[i].content);
		}
	}
	return "";
}

function buildPrompt(
	lastUserMessage: string,
	lastAssistantMessage: string,
	changedFiles: string[],
	lang: string,
): string {
	const isJapanese =
		lang === "ja" || lang === "ja-JP" || lang === "japanese";
	const filesStr = changedFiles.join(", ");

	if (isJapanese) {
		return `ユーザーのリクエスト:
${lastUserMessage}

アシスタントの応答:
${lastAssistantMessage}

変更されたファイル: ${filesStr}

上記から変更の意図を推測し、Conventional Commit メッセージを1つ生成してください。`;
	}

	return `User request:
${lastUserMessage}

Assistant response:
${lastAssistantMessage}

Changed files: ${filesStr}

Based on the above, infer the intent of the changes and generate a single Conventional Commit message.`;
}

export async function generateAutoCommitMessage(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	messages: SimpleMessage[],
	changedFiles: string[],
): Promise<string> {
	const model = ctx.model;
	if (!model) {
		return sanitizeCommitMessage("chore: apply changes", changedFiles);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return sanitizeCommitMessage("chore: apply changes", changedFiles);
	}

	const lang = getLanguage(ctx.cwd);
	const lastUserMessage = findLastMessageByRole(messages, "user");
	const lastAssistantMessage = findLastMessageByRole(messages, "assistant");

	if (!lastUserMessage) {
		return sanitizeCommitMessage("chore: apply changes", changedFiles);
	}

	try {
		const promptContext: Context = {
			systemPrompt: getSystemPrompt(lang),
			messages: [
				{
					role: "user",
					content: buildPrompt(
						lastUserMessage,
						lastAssistantMessage,
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
			.filter(
				(c): c is { type: "text"; text: string } =>
					c.type === "text",
			)
			.map((c) => c.text)
			.join("")
			.trim();

		return sanitizeCommitMessage(text || "chore: apply changes", changedFiles);
	} catch {
		return sanitizeCommitMessage("chore: apply changes", changedFiles);
	}
}
