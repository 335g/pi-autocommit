/**
 * i18n message catalog for pi-git.
 *
 * All user-facing strings live here, keyed by domain.
 * The `t()` function in lang.ts resolves keys against this catalog.
 *
 * To add a language: add a new top-level key with the same MessageKey set.
 */

export const messages = {
  en: {
    // ── footer-manager.ts: execution phase status ──────────────
    "footer.prepare": "{prefix} Preparing...",
    "footer.collectDiff": "{prefix} Collecting diff...",
    "footer.analyze": "{prefix} Analyzing hunks...",
    "footer.generateMessage": "{prefix} Generating messages...",
    "footer.commit": "{prefix} Committing...",

    // ── agg-commit.ts ──────────────────────────────────────────
    "aggCommit.help":
      "/git-agg-commit [--lang=<lang>] [--help]\n\nOptions:\n  --lang=<lang>  Temporarily override language (not saved)\n  --help         Show this help message",
    "aggCommit.alreadyRunning":
      "git-agg-commit is already running. Please wait for it to complete.",

    // ── auto-agg-commit.ts ─────────────────────────────────────
    "autoAggCommit.help":
      "/git-auto-agg-commit [on|off|toggle] [--help]\n\nSubcommands:\n  on      Enable auto git-agg-commit\n  off     Disable auto git-agg-commit\n  toggle  Toggle auto git-agg-commit\n\nFlags:\n  --help  Show this help message\n\nWhen called without arguments, shows the current status.",
    "autoAggCommit.status":
      "[pi-git] Auto git-agg-commit is {status}",
    "autoAggCommit.enabled": "enabled",
    "autoAggCommit.disabled": "disabled",
    "autoAggCommit.invalidArg":
      '[pi-git] Invalid argument. Use "on", "off", or "toggle"',
    "autoAggCommit.enabledLocal":
      "[pi-git] Auto git-agg-commit {status} (local config)",
    "autoAggCommit.enabledGlobal":
      "[pi-git] Auto git-agg-commit {status} (global config — outside git repo)",

    // ── config.ts ──────────────────────────────────────────────
    "config.help":
      "/git-config <key> [value] [--global] [--list] [--show-origin] [--keys] [--models] [--help]\n\nSubcommands:\n  <key>           Get the value of a setting\n  <key> <value>   Set the value of a setting\n\nFlags:\n  --global        Operate on global settings\n  --list           List all configured values\n  --show-origin    Show value origin (default/global/local)\n  --keys           Show valid keys with descriptions\n  --models         Show available models for analysis_model\n  --help           Show this help message",
    "config.noModels": "No available models found",
    "config.modelsHeader": "Available models for analysis_model:",
    "config.noSettings": "No settings configured",
    "config.usageHint":
      "Usage: /git-config <key> [value] [--global] [--list] [--show-origin] [--keys]",
    "config.unknownKey": "[pi-git] Unknown config key: {key}",
    "config.notSet": "[pi-git] {key} is not set",
    "config.savedToGlobal": "[pi-git] Saved {key}={value} to global config",
    "config.savedToLocal": "[pi-git] Saved {key}={value} to local config",
    "config.savedToLocalInit":
      "[pi-git] Saved {key}={value} to local config (initialized with defaults)",
    "config.savedToGlobalFallback":
      "[pi-git] Saved {key}={value} to global config (outside git repo)",
    "config.saveFailed": "[pi-git] Failed to save: {error}",

    // ── config.ts: VALID_KEYS_META descriptions ─────────────────
    "config.keyDesc.lang": "Display and commit message language",
    "config.keyDesc.auto_agg_commit":
      "Whether to automatically run git-agg-commit after assistant response",
    "config.keyDesc.analysis_model":
      "AI model to use for diff analysis (format: provider/model-id)",

    // ── auto-commit.ts ─────────────────────────────────────────
    "autoCommit.commitFailed": "Commit failed: {error}",
    "autoCommit.commitCreated": "Created commit: {message}",

    // ── diff-analyzer.ts: system prompt ────────────────────────
    "diffAnalyzer.systemPrompt":
      "Split git diff into logical hunks.\n\nRules:\n- Each hunk = single logical change (e.g., \"add feature X\", \"fix bug Y\")\n- Group related file changes together\n- Split independent changes within one file into separate hunks\n- Write commit message subjects in English\n\nReturn ONLY a JSON array:\n[\n  {\"files\": [\"path/to/file1.ts\", \"path/to/file2.ts\"], \"message\": \"feat(scope): add feature\"},\n  {\"files\": [\"path/to/file3.ts\"], \"message\": \"fix: resolve null check\"}\n]\n\nMessage format: Conventional Commits (feat, fix, docs, style, refactor, test, chore).\nKeep subject under 50 chars. Use imperative mood. Write in English.",

    // ── diff-analyzer.ts: user prompt ──────────────────────────
    "diffAnalyzer.buildPrompt":
      "Here is the git diff to analyze. Split it into logical hunks:\n\n```diff\n{diff}\n```\n\nWrite commit message subjects in English.\nRespond with ONLY a JSON array of hunks as specified.",

    // ── auto-commit-message.ts: system prompt ──────────────────
    "autoCommitMsg.systemPrompt":
      "You are a commit message generator. From the following information, understand what the user requested and what changes were made as a result, then generate a single Conventional Commit message.\n\nThe most important input is the \"user's request\". Use it as the primary driver for the commit message. The assistant's response and changed files list are supplementary - they describe how the request was fulfilled.\n\nRules:\n- Choose type from: feat, fix, docs, style, refactor, test, chore\n- Write the subject in English\n- Keep subject under 50 characters\n- Use imperative mood\n- Include scope only if clearly inferable\n\nReturn ONLY the commit message string. No explanations or code fences.",

    // ── auto-commit-message.ts: user prompt ────────────────────
    "autoCommitMsg.buildPrompt":
      "=== USER REQUEST (primary) ===\n{userSection}\n\n=== ASSISTANT RESPONSE (reference) ===\n{assistantSection}\n\n=== CHANGED FILES ===\n{filesSection}\n\nBased primarily on the USER REQUEST above, generate a single Conventional Commit message in English that best captures the intent of the changes.",

    // ── auto-commit-message.ts: message comparison ─────────────
    "autoCommitMsg.compareSystemPrompt":
      "Choose the most specific commit message candidate. Return only the chosen message string.",
    "autoCommitMsg.comparePrompt":
      'You are a commit message quality evaluator.\nTwo candidate messages exist for the same set of changes.\n\nCandidate A (generated from analysis): "{candidateA}"\nCandidate B (derived from user request): "{candidateB}"\n\nChanged files: {files}\n\nChoose the one that is MORE SPECIFIC and accurately describes the changes.\nReturn ONLY the chosen message string. No explanations.',

    // ── auto-commit-message.ts: fallback text for empty sections
    "autoCommitMsg.noData": "(none)",

    // ── core fallback commit message ───────────────────────────
    "core.applyChanges": "chore: apply changes",
  },

  ja: {
    // ── footer-manager.ts: execution phase status ──────────────
    "footer.prepare": "{prefix} 準備中...",
    "footer.collectDiff": "{prefix} diff収集中...",
    "footer.analyze": "{prefix} hunk解析中...",
    "footer.generateMessage": "{prefix} コミットメッセージ生成中...",
    "footer.commit": "{prefix} コミット実行中...",

    // ── agg-commit.ts ──────────────────────────────────────────
    "aggCommit.help":
      "/git-agg-commit [--lang=<lang>] [--help]\n\nオプション:\n  --lang=<lang>  一時的に言語を上書き（保存されません）\n  --help         このヘルプを表示",
    "aggCommit.alreadyRunning":
      "git-agg-commit 実行中です。完了してから再度実行してください。",

    // ── auto-agg-commit.ts ─────────────────────────────────────
    "autoAggCommit.help":
      "/git-auto-agg-commit [on|off|toggle] [--help]\n\nサブコマンド:\n  on      自動 git-agg-commit を有効にする\n  off     自動 git-agg-commit を無効にする\n  toggle  自動 git-agg-commit の有効/無効を切り替える\n\nフラグ:\n  --help  このヘルプを表示\n\n引数を省略すると、現在の状態を表示します。",
    "autoAggCommit.status":
      "[pi-git] 自動 git-agg-commit は{status}です",
    "autoAggCommit.enabled": "有効",
    "autoAggCommit.disabled": "無効",
    "autoAggCommit.invalidArg":
      "[pi-git] 引数が不正です。on, off, toggle のいずれかを指定してください",
    "autoAggCommit.enabledLocal":
      "[pi-git] 自動 git-agg-commit を{status}にしました（ローカル設定）",
    "autoAggCommit.enabledGlobal":
      "[pi-git] 自動 git-agg-commit を{status}にしました（グローバル設定 — Gitリポジトリ外のため）",

    // ── config.ts ──────────────────────────────────────────────
    "config.help":
      "/git-config <key> [value] [--global] [--list] [--show-origin] [--keys] [--models] [--help]\n\nサブコマンド:\n  <key>           設定値を取得\n  <key> <value>   設定値を変更\n\nフラグ:\n  --global        グローバル設定に対して操作\n  --list           すべての設定値を一覧表示\n  --show-origin    値の取得元（default/global/local）を表示\n  --keys           有効なキー一覧と説明を表示\n  --models         analysis_model に設定可能なモデル一覧を表示\n  --help           このヘルプを表示",
    "config.noModels": "利用可能なモデルが見つかりません",
    "config.modelsHeader": "analysis_model に設定可能なモデル一覧:",
    "config.noSettings": "設定はありません",
    "config.usageHint":
      "使用方法: /git-config <key> [value] [--global] [--list] [--show-origin] [--keys]",
    "config.unknownKey": "[pi-git] 不明な設定キー: {key}",
    "config.notSet": "[pi-git] {key} は設定されていません",
    "config.savedToGlobal":
      "[pi-git] {key}={value} をグローバル設定に保存しました",
    "config.savedToLocal":
      "[pi-git] {key}={value} をローカル設定に保存しました",
    "config.savedToLocalInit":
      "[pi-git] {key}={value} をローカル設定に保存しました（デフォルト値で初期化）",
    "config.savedToGlobalFallback":
      "[pi-git] {key}={value} をグローバル設定に保存しました（Gitリポジトリ外のため）",
    "config.saveFailed": "[pi-git] 保存に失敗しました: {error}",

    // ── config.ts: VALID_KEYS_META descriptions ─────────────────
    "config.keyDesc.lang": "表示・コミットメッセージの言語設定",
    "config.keyDesc.auto_agg_commit":
      "アシスタント応答後の自動コミット有無",
    "config.keyDesc.analysis_model":
      "diff分析に使用するAIモデル（形式: provider/model-id）",

    // ── auto-commit.ts ─────────────────────────────────────────
    "autoCommit.commitFailed": "コミットに失敗しました: {error}",
    "autoCommit.commitCreated": "コミットを作成しました: {message}",

    // ── diff-analyzer.ts: system prompt ────────────────────────
    "diffAnalyzer.systemPrompt":
      "git diffを論理的なhunkに分割してください。\n\nルール:\n- 各hunk = 単一の論理的な変更（例：「機能Xを追加」「バグYを修正」）\n- 関連するファイル変更はグループ化する\n- 1ファイルに独立した複数の変更がある場合は分割する\n- コミットメッセージのサブジェクトは必ず日本語で記述する\n\n以下のJSON配列のみを返してください:\n[\n  {\"files\": [\"path/to/file1.ts\", \"path/to/file2.ts\"], \"message\": \"feat: 機能を追加\"},\n  {\"files\": [\"path/to/file3.ts\"], \"message\": \"fix: バグを修正\"}\n]\n\nメッセージ形式: Conventional Commits (feat, fix, docs, style, refactor, test, chore)。\nサブジェクトは50文字以内。",

    // ── diff-analyzer.ts: user prompt ──────────────────────────
    "diffAnalyzer.buildPrompt":
      "以下のgit diffを分析し、論理的なhunkに分割してください:\n\n```diff\n{diff}\n```\n\nコミットメッセージのサブジェクトは必ず日本語で記述してください。\n指定された形式のJSON配列のみを返してください。",

    // ── auto-commit-message.ts: system prompt ──────────────────
    "autoCommitMsg.systemPrompt":
      "あなたはコミットメッセージ生成ツールです。以下の情報から、ユーザーが**何を依頼し、その結果どのような変更が行われたか**を読み取り、Conventional Commit メッセージを1つ生成してください。\n\n最も重要なのは「ユーザーのリクエスト」です。ユーザーが何を求めていたのかを主軸に、コミットメッセージを決定してください。アシスタントの応答と変更ファイル一覧は、そのリクエストがどのように実現されたかを補完する情報です。\n\nルール:\n- type は feat, fix, docs, style, refactor, test, chore から選択\n- サブジェクトは必ず日本語で記述する\n- サブジェクトは50文字以内\n- 命令形を使用する\n- スコープは推測できる場合のみ含める\n\n返答はメッセージ文字列のみ。説明やコードフェンスは不要。",

    // ── auto-commit-message.ts: user prompt ────────────────────
    "autoCommitMsg.buildPrompt":
      "=== ユーザーのリクエスト（最重要） ===\n{userSection}\n\n=== アシスタントの応答（参考） ===\n{assistantSection}\n\n=== 変更されたファイル ===\n{filesSection}\n\n上記の「ユーザーのリクエスト」を主軸に、変更の意図を最もよく表す Conventional Commit メッセージを1つ、**必ず日本語で**生成してください。",

    // ── auto-commit-message.ts: message comparison ─────────────
    "autoCommitMsg.compareSystemPrompt":
      "コミットメッセージ候補から最も具体的なものを選び、その文字列のみを返してください。",
    "autoCommitMsg.comparePrompt":
      "あなたはコミットメッセージの品質評価ツールです。\n同じ変更セットに対する2つの候補メッセージがあります。\n\n候補A（会話分析から生成）: \"{candidateA}\"\n候補B（ユーザーの依頼から抽出）: \"{candidateB}\"\n\n変更ファイル: {files}\n\nより**具体的で**、変更内容を正確に表している方を選び、\nそのメッセージ文字列だけを返してください。\n説明や補足は一切不要です。",

    // ── auto-commit-message.ts: fallback text for empty sections
    "autoCommitMsg.noData": "（なし）",

    // ── core fallback commit message ───────────────────────────
    "core.applyChanges": "chore: 変更を適用",
  },
} as const;

/** Union of all valid message keys (derived from English catalog). */
export type MessageKey = keyof typeof messages.en;
