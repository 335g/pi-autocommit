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
    "footer.review": "{prefix} Reviewing hunks...",
    "footer.commit": "{prefix} Committing...",
    "footer.autoCommit.off": "auto-commit: off",
    "footer.autoCommit.onClean": "auto-commit: on (clean)",
    "footer.autoCommit.onChanged": "auto-commit: on (changed)",

    // ── review.ts: review UI strings ───────────────────────────
    "review.title": "Review Hunks",
    "review.commitButton": "[ Commit ({count} hunks) ]",
    "review.commitButtonNone": "[ Commit (no hunks selected) ]",
    "review.keyHints": "Space:toggle  e:edit  j/k:move  Esc:cancel",
    "review.keyHintsEditing": "Enter:confirm edit  Esc:cancel edit",
    "review.unstagedInfo": "{count} unstaged file(s): {files}",
    "review.cancelled": "Review cancelled. No changes committed.",
    "review.noHunksSelected": "No hunks selected for commit.",
    "review.fileCount": "{count} file(s)",

    // ── agg-commit.ts ──────────────────────────────────────────
    "aggCommit.help":
      "/git-agg-commit [--lang=<lang>] [--review] [--help]\n\nOptions:\n  --lang=<lang>  Temporarily override language (not saved)\n  --review       Interactive review before commit\n  --help         Show this help message",
    "aggCommit.alreadyRunning":
      "git-agg-commit is already running. Please wait for it to complete.",
    "aggCommit.notGitRepo": "Not a git repository",
    "aggCommit.mergeConflict":
      "Merge conflicts detected. Resolve conflicts before committing.",
    "aggCommit.noChanges": "No changes to commit",
    "aggCommit.stashFailed": "Failed to stash changes",
    "aggCommit.noHunksFound": "No hunks found to commit",
    "aggCommit.stagingResetFailed":
      "Failed to reset staging area, aborting batch",
    "aggCommit.commitFailed":
      'Commit failed for "{message}" (exit code {exitCode})',
    "aggCommit.langOverride": "Language set to: {lang} (this run only)",
    "aggCommit.summaryCommitted": "Created {count} commit(s)",
    "aggCommit.summarySkipped": "{count} skipped",
    "aggCommit.summaryFailed": "{count} failed",
    "aggCommit.summaryAllFailed": "All commits failed",
    "aggCommit.summaryAborted":
      "{remaining} hunks not attempted (staging reset failed)",

    // ── auto-agg-commit.ts ─────────────────────────────────────
    "autoAggCommit.help":
      "/git-auto-agg-commit [on|off|toggle] [--help]\n\nSubcommands:\n  on      Enable auto git-agg-commit\n  off     Disable auto git-agg-commit\n  toggle  Toggle auto git-agg-commit\n\nFlags:\n  --help  Show this help message\n\nWhen called without arguments, shows the current status.",
    "autoAggCommit.status": "[pi-git] Auto git-agg-commit is {status}",
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
      "/git-config <key> [value] [--global] [--list] [--show-origin] [--keys] [--models] [--init] [--force] [--delete-global] [--help]\n\nSubcommands:\n  <key>           Get the value of a setting\n  <key> <value>   Set the value of a setting\n\nFlags:\n  --global        Operate on global settings\n  --list           List all configured values\n  --show-origin    Show value origin (default/global/local)\n  --keys           Show valid keys with descriptions\n  --models         Show available models for analysis_model\n  --init           Create default pi-git.toml in the repository root\n  --force          Force overwrite when used with --init\n  --delete-global  Delete global config file (~/.config/pi-git/settings.json)\n  --help           Show this help message",
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
    "config.initCreated":
      "[pi-git] Created default pi-git.toml in the repository root.",
    "config.initAlreadyExists":
      "[pi-git] pi-git.toml already exists. Use --init --force to overwrite.",
    "config.initOverwritten":
      "[pi-git] Overwritten pi-git.toml with default settings.",
    "config.initNotInRepo":
      "[pi-git] Not inside a git repository. Cannot create pi-git.toml.",
    "config.deleteGlobalSuccess":
      "[pi-git] Deleted global config file (~/.config/pi-git/settings.json).",
    "config.deleteGlobalNotFound":
      "[pi-git] Global config file not found. Nothing to delete.",
    "config.deleteGlobalFailed":
      "[pi-git] Failed to delete global config: {error}",

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
      'Split git diff into logical hunks.\n\nRules:\n- Each hunk = single logical change (e.g., "add feature X", "fix bug Y")\n- Group related file changes together\n- Split independent changes within one file into separate hunks\n- Write commit message subjects in English\n\nReturn ONLY a JSON array:\n[\n  {"files": ["path/to/file1.ts", "path/to/file2.ts"], "message": "feat(scope): add feature"},\n  {"files": ["path/to/file3.ts"], "message": "fix: resolve null check"}\n]\n\nMessage format: Conventional Commits (feat, fix, docs, style, refactor, test, chore).\nKeep subject under 50 chars. Use imperative mood. Write in English.',

    // ── diff-analyzer.ts: few-shot examples ────────────────────
    "diffAnalyzer.examples":
      'Examples of correct output:\n\nInput: diff with src/auth/login.ts (added login function), src/auth/types.ts (added User type)\nOutput: [{"files": ["src/auth/login.ts", "src/auth/types.ts"], "message": "feat(auth): add login functionality"}]\n\nInput: diff with README.md (fixed typo in installation section), package.json (version bump)\nOutput: [{"files": ["README.md"], "message": "docs: fix typo in README"}, {"files": ["package.json"], "message": "chore: bump version to 1.2.0"}]',

    // ── diff-analyzer.ts: type hints for cheap models ─────────
    "diffAnalyzer.typeHints": "Type hints (based on file paths):",

    // ── diff-analyzer.ts: user prompt ──────────────────────────
    "diffAnalyzer.buildPrompt":
      "{examples}\n\n{typeHints}Here is the git diff to analyze. Split it into logical hunks:\n\n```diff\n{diff}\n```\n\nWrite commit message subjects in English.\nRespond with ONLY a JSON array of hunks as specified.",

    // ── auto-commit-message.ts: system prompt ──────────────────
    "autoCommitMsg.systemPrompt":
      "You are a commit message generator. From the following information, understand what the user requested and what changes were made as a result, then generate a single Conventional Commit message.\n\nThe most important input is the \"user's request\". Use it as the primary driver for the commit message. The assistant's response and changed files list are supplementary - they describe how the request was fulfilled.\n\nRules:\n- Choose type from: feat, fix, docs, style, refactor, test, chore\n- Write the subject in English\n- Keep subject under 50 characters\n- Use imperative mood\n- Include scope only if clearly inferable\n\nReturn ONLY the commit message string. No explanations or code fences.",

    // ── auto-commit-message.ts: few-shot examples ──────────────
    "autoCommitMsg.examples":
      'Examples:\n\nUser request: "Add a login form to the auth page"\nAssistant response: "I\'ve added login.tsx with form validation and connected it to the auth API."\nChanged files: src/auth/login.tsx, src/auth/api.ts\n→ feat(auth): add login form\n\nUser request: "Fix the null pointer error in the payment flow"\nAssistant response: "Added null check in PaymentProcessor.handle(). The error should be resolved now."\nChanged files: src/payment/processor.ts\n→ fix(payment): add null check in processor',

    // ── auto-commit-message.ts: user prompt ────────────────────
    "autoCommitMsg.buildPrompt":
      "{examples}\n\n=== USER REQUEST (primary) ===\n{userSection}\n\n=== ASSISTANT RESPONSE (reference) ===\n{assistantSection}\n\n=== CHANGED FILES ===\n{filesSection}\n\nBased primarily on the USER REQUEST above, generate a single Conventional Commit message in English that best captures the intent of the changes.",

    // ── auto-commit-message.ts: message comparison ─────────────
    "autoCommitMsg.compareSystemPrompt":
      "Return only 'A' or 'B' to indicate the better commit message candidate.",
    "autoCommitMsg.comparePrompt":
      'Two commit message candidates for the same changes:\n\nA: "{candidateA}"\nB: "{candidateB}"\n\nChanged files: {files}\n\nChoose the one that is MORE SPECIFIC and accurately describes the changes.\nReply with ONLY a single character: A or B.',

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
    "footer.review": "{prefix} hunkレビュー中...",
    "footer.commit": "{prefix} コミット実行中...",
    "footer.autoCommit.off": "auto-commit: off",
    "footer.autoCommit.onClean": "auto-commit: on (clean)",
    "footer.autoCommit.onChanged": "auto-commit: on (changed)",

    // ── review.ts: review UI strings ───────────────────────────
    "review.title": "Hunk レビュー",
    "review.commitButton": "[ コミット ({count}件) ]",
    "review.commitButtonNone": "[ コミット (選択なし) ]",
    "review.keyHints": "Space:除外  e:編集  j/k:移動  Esc:キャンセル",
    "review.keyHintsEditing": "Enter:編集確定  Esc:編集キャンセル",
    "review.unstagedInfo": "{count}個の未割当ファイル: {files}",
    "review.cancelled":
      "レビューをキャンセルしました。変更はコミットされていません。",
    "review.noHunksSelected": "コミットするHunkが選択されていません。",
    "review.fileCount": "{count}ファイル",

    // ── agg-commit.ts ──────────────────────────────────────────
    "aggCommit.help":
      "/git-agg-commit [--lang=<lang>] [--review] [--help]\n\nオプション:\n  --lang=<lang>  一時的に言語を上書き（保存されません）\n  --review       コミット前に対話レビューを実行\n  --help         このヘルプを表示",
    "aggCommit.alreadyRunning":
      "git-agg-commit 実行中です。完了してから再度実行してください。",
    "aggCommit.notGitRepo": "Gitリポジトリではありません",
    "aggCommit.mergeConflict":
      "マージコンフリクトが検出されました。解決してからコミットしてください。",
    "aggCommit.noChanges": "コミットする変更がありません",
    "aggCommit.stashFailed": "変更のスタッシュに失敗しました",
    "aggCommit.noHunksFound": "コミットするhunkが見つかりません",
    "aggCommit.stagingResetFailed":
      "ステージングエリアのリセットに失敗しました。バッチを中断します",
    "aggCommit.commitFailed":
      'コミット失敗: "{message}" (終了コード {exitCode})',
    "aggCommit.langOverride": "言語を {lang} に設定しました（今回のみ）",
    "aggCommit.summaryCommitted": "{count}件のコミットを作成",
    "aggCommit.summarySkipped": "{count}件スキップ",
    "aggCommit.summaryFailed": "{count}件失敗",
    "aggCommit.summaryAllFailed": "すべてのコミットが失敗しました",
    "aggCommit.summaryAborted":
      "残り{remaining}件は未処理です（ステージングリセット失敗のため中断）",

    // ── auto-agg-commit.ts ─────────────────────────────────────
    "autoAggCommit.help":
      "/git-auto-agg-commit [on|off|toggle] [--help]\n\nサブコマンド:\n  on      自動 git-agg-commit を有効にする\n  off     自動 git-agg-commit を無効にする\n  toggle  自動 git-agg-commit の有効/無効を切り替える\n\nフラグ:\n  --help  このヘルプを表示\n\n引数を省略すると、現在の状態を表示します。",
    "autoAggCommit.status": "[pi-git] 自動 git-agg-commit は{status}です",
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
      "/git-config <key> [value] [--global] [--list] [--show-origin] [--keys] [--models] [--init] [--force] [--delete-global] [--help]\n\nサブコマンド:\n  <key>           設定値を取得\n  <key> <value>   設定値を変更\n\nフラグ:\n  --global        グローバル設定に対して操作\n  --list           すべての設定値を一覧表示\n  --show-origin    値の取得元（default/global/local）を表示\n  --keys           有効なキー一覧と説明を表示\n  --models         analysis_model に設定可能なモデル一覧を表示\n  --init           リポジトリルートにデフォルトの pi-git.toml を作成\n  --force          --init と併用して強制的に上書き\n  --delete-global  グローバル設定ファイル (~/.config/pi-git/settings.json) を削除\n  --help           このヘルプを表示",
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
    "config.initCreated":
      "[pi-git] リポジトリルートにデフォルトの pi-git.toml を作成しました。",
    "config.initAlreadyExists":
      "[pi-git] pi-git.toml はすでに存在します。上書きするには --init --force を使用してください。",
    "config.initOverwritten":
      "[pi-git] pi-git.toml をデフォルト設定で上書きしました。",
    "config.initNotInRepo":
      "[pi-git] Git リポジトリ内ではありません。pi-git.toml を作成できません。",
    "config.deleteGlobalSuccess":
      "[pi-git] グローバル設定ファイル (~/.config/pi-git/settings.json) を削除しました。",
    "config.deleteGlobalNotFound":
      "[pi-git] グローバル設定ファイルが見つかりません。削除するものはありません。",
    "config.deleteGlobalFailed":
      "[pi-git] グローバル設定の削除に失敗しました: {error}",

    // ── config.ts: VALID_KEYS_META descriptions ─────────────────
    "config.keyDesc.lang": "表示・コミットメッセージの言語設定",
    "config.keyDesc.auto_agg_commit": "アシスタント応答後の自動コミット有無",
    "config.keyDesc.analysis_model":
      "diff分析に使用するAIモデル（形式: provider/model-id）",

    // ── auto-commit.ts ─────────────────────────────────────────
    "autoCommit.commitFailed": "コミットに失敗しました: {error}",
    "autoCommit.commitCreated": "コミットを作成しました: {message}",

    // ── diff-analyzer.ts: system prompt ────────────────────────
    "diffAnalyzer.systemPrompt":
      'git diffを論理的なhunkに分割してください。\n\nルール:\n- 各hunk = 単一の論理的な変更（例：「機能Xを追加」「バグYを修正」）\n- 関連するファイル変更はグループ化する\n- 1ファイルに独立した複数の変更がある場合は分割する\n- コミットメッセージのサブジェクトは必ず日本語で記述する\n\n以下のJSON配列のみを返してください:\n[\n  {"files": ["path/to/file1.ts", "path/to/file2.ts"], "message": "feat: 機能を追加"},\n  {"files": ["path/to/file3.ts"], "message": "fix: バグを修正"}\n]\n\nメッセージ形式: Conventional Commits (feat, fix, docs, style, refactor, test, chore)。\nサブジェクトは50文字以内。',

    // ── diff-analyzer.ts: few-shot examples ────────────────────
    "diffAnalyzer.examples":
      '正しい出力の例:\n\n入力: src/auth/login.ts（ログイン機能を追加）, src/auth/types.ts（User型を追加）のdiff\n出力: [{"files": ["src/auth/login.ts", "src/auth/types.ts"], "message": "feat(auth): ログイン機能を追加"}]\n\n入力: README.md（インストール手順の誤字を修正）, package.json（バージョン更新）のdiff\n出力: [{"files": ["README.md"], "message": "docs: READMEの誤字を修正"}, {"files": ["package.json"], "message": "chore: バージョンを1.2.0に更新"}]',

    // ── diff-analyzer.ts: type hints for cheap models ─────────
    "diffAnalyzer.typeHints": "型ヒント（ファイルパスに基づく）:",

    // ── diff-analyzer.ts: user prompt ──────────────────────────
    "diffAnalyzer.buildPrompt":
      "{examples}\n\n{typeHints}以下のgit diffを分析し、論理的なhunkに分割してください:\n\n```diff\n{diff}\n```\n\nコミットメッセージのサブジェクトは必ず日本語で記述してください。\n指定された形式のJSON配列のみを返してください。",

    // ── auto-commit-message.ts: system prompt ──────────────────
    "autoCommitMsg.systemPrompt":
      "あなたはコミットメッセージ生成ツールです。以下の情報から、ユーザーが**何を依頼し、その結果どのような変更が行われたか**を読み取り、Conventional Commit メッセージを1つ生成してください。\n\n最も重要なのは「ユーザーのリクエスト」です。ユーザーが何を求めていたのかを主軸に、コミットメッセージを決定してください。アシスタントの応答と変更ファイル一覧は、そのリクエストがどのように実現されたかを補完する情報です。\n\nルール:\n- type は feat, fix, docs, style, refactor, test, chore から選択\n- サブジェクトは必ず日本語で記述する\n- サブジェクトは50文字以内\n- 命令形を使用する\n- スコープは推測できる場合のみ含める\n\n返答はメッセージ文字列のみ。説明やコードフェンスは不要。",

    // ── auto-commit-message.ts: few-shot examples ──────────────
    "autoCommitMsg.examples":
      "例:\n\nユーザーの依頼: 「認証ページにログインフォームを追加して」\nアシスタントの応答: 「login.tsx にバリデーション付きのフォームを追加し、認証APIに接続しました」\n変更ファイル: src/auth/login.tsx, src/auth/api.ts\n→ feat(auth): ログインフォームを追加\n\nユーザーの依頼: 「支払いフローのnullポインタエラーを修正して」\nアシスタントの応答: 「PaymentProcessor.handle() にnullチェックを追加しました」\n変更ファイル: src/payment/processor.ts\n→ fix(payment): nullチェックを追加",

    // ── auto-commit-message.ts: user prompt ────────────────────
    "autoCommitMsg.buildPrompt":
      "{examples}\n\n=== ユーザーのリクエスト（最重要） ===\n{userSection}\n\n=== アシスタントの応答（参考） ===\n{assistantSection}\n\n=== 変更されたファイル ===\n{filesSection}\n\n上記の「ユーザーのリクエスト」を主軸に、変更の意図を最もよく表す Conventional Commit メッセージを1つ、**必ず日本語で**生成してください。",

    // ── auto-commit-message.ts: message comparison ─────────────
    "autoCommitMsg.compareSystemPrompt":
      "AまたはBの1文字だけを返し、より良いコミットメッセージ候補を示してください。",
    "autoCommitMsg.comparePrompt":
      '同じ変更に対する2つのコミットメッセージ候補:\n\nA: "{candidateA}"\nB: "{candidateB}"\n\n変更ファイル: {files}\n\nより**具体的で**、変更内容を正確に表している方を選び、\n**A または B の1文字だけ**を返してください。\n説明や補足は一切不要です。',

    // ── auto-commit-message.ts: fallback text for empty sections
    "autoCommitMsg.noData": "（なし）",

    // ── core fallback commit message ───────────────────────────
    "core.applyChanges": "chore: 変更を適用",
  },
} as const;

/** Union of all valid message keys (derived from English catalog). */
export type MessageKey = keyof typeof messages.en;
