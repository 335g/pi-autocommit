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
      "AI model to use for diff analysis (format: model-id or provider/model-id)",
    "config.keyDesc.auto_agg_commit_min_files":
      "Maximum changed files to trigger confirmation (deprecated: confirmation is now always shown)",
    "config.keyDesc.auto_agg_commit_min_lines":
      "Maximum changed lines to trigger confirmation (deprecated: confirmation is now always shown)",
    "config.keyDesc.auto_agg_commit_skip_confirm_files":
      "Maximum changed files to skip confirmation (0 = never skip, always confirm)",
    "config.keyDesc.auto_agg_commit_skip_confirm_lines":
      "Maximum changed lines to skip confirmation (0 = never skip, always confirm)",
    "config.keyDesc.auto_agg_commit_mode":
      "Commit mode: per_turn (commit after each turn) or accumulate (batch commit via /git-agg-commit)",
    "config.keyDesc.batch_warn_turns":
      "Number of accumulated turns before showing a commit reminder (0 = disabled)",

    // ── auto-commit.ts ─────────────────────────────────────────
    "autoCommit.commitFailed": "Commit failed: {error}",
    "autoCommit.commitCreated": "Created commit: {message}",

    // ── auto-commit-confirm.ts ─────────────────────────────────
    "autoCommit.confirmTitle": "Confirm Auto-Commit",
    "autoCommit.confirmBody":
      "{files} file(s) changed ({lines}). Commit this change?",
    "autoCommit.confirmBodyLines": "{count} lines",
    "autoCommit.confirmBodyBinary": "binary",
    "autoCommit.confirmYes": "Yes (Enter)",
    "autoCommit.confirmNo": "No (Esc)",
    "autoCommit.confirmMoreFiles": "...and {count} more files",
    "autoCommit.confirmNewFile": "(new)",
    "autoCommit.confirmSkipped": "Auto-commit skipped",
    "autoCommit.skippedSmallChange": "Auto-committing (small change — {files} file(s), {lines} lines)",
    "autoCommit.confirmTimedOut":
      "Auto-commit confirmation timed out — skipped",

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

    // ── diff-analyzer.ts: extended system prompt (with TurnLog) ─
    "diffAnalyzer.systemPromptWithContext":
      'Split git diff into logical hunks. Use the conversation log to understand the INTENT behind each change, but the DIFF is always the primary truth source.\n\nPriority order:\n1. Diff structure (what actually changed in files)\n2. File co-location patterns (which files change together)\n3. TurnLog Files field (per-turn file correlation)\n4. TurnLog conversation text (intent hints)\n\nRules:\n- Each hunk = single logical change\n- A single change may span multiple conversation turns — do NOT enforce 1-turn = 1-hunk\n- If the conversation log is unclear or conflicts with the diff, the diff always wins\n- If a file appears in the diff but not in any TurnLog entry, do not force-fit it to a turn\n- When a file was modified across multiple turns, prefer the most recent turn\n- Write commit message subjects in English\n\nDo NOT generate vague, non-specific messages such as:\n- "chore: apply changes", "chore: update files", "chore: modify files"\n- Any message whose subject appears nowhere in the GIT DIFF\n- Generic verbs without specific file/feature references\n\nReturn ONLY a JSON array. No explanations or code fences.',

    // ── diff-analyzer.ts: extended user prompt (with TurnLog) ─
    "diffAnalyzer.buildPromptWithContext":
      '=== GIT DIFF (PRIMARY — this is what actually changed) ===\n```diff\n{diff}\n```\n\n=== CONVERSATION LOG (supplementary — use only to infer intent) ===\n{turnLogText}\n\nSplit the diff above into logical hunks. Use the conversation log ONLY to understand WHY changes were made, not to override the diff structure.\nWrite commit message subjects in English.\nRespond with ONLY a JSON array of hunks.',

    // ── diff-analyzer.ts: intent-based system prompt ──────────
    "diffAnalyzer.intentSystemPrompt":
      'You are a commit decomposition engine. Split git diff changes into logical commits based on conversation history AND diff structure.\n\nINPUT:\n- CONVERSATION HISTORY: user requests + assistant responses + files changed per turn\n- NUMBERED DIFF HUNKS: each @@ block numbered [H1], [H2], ... for verification\n\nCORE TASK:\nFor each numbered diff hunk, decide:\n(a) Which conversation turn(s) it belongs to (if any)\n(b) Which other hunks form a logical commit with it\n(c) How confident you are in this grouping\n\nGROUPING RULES:\n1. Hunks that clearly belong to the same conversation intent → one commit group\n2. A single turn\'s request may produce multiple independent changes → split into separate groups (e.g., "add login AND fix README" → 2 groups)\n3. Related changes across multiple turns (same feature, iterative refinement) → merge into one group\n4. Diff hunks with NO clear conversation counterpart → group separately as "unexplained changes"\n5. Every diff hunk [HN] MUST be assigned to exactly one commit group\n\nCOMMIT MESSAGE RULES:\n- Conventional Commits: type(scope): subject (Japanese, imperative, ≤50 chars)\n- Generate from BOTH user request AND assistant response\n- When they differ, prefer assistant\'s description (what was ACTUALLY done)\n- Be specific — reference what changed in the diff\n- NEVER: "変更を適用", "ファイルを更新", "修正しました", "対応しました"\n\nCONFIDENCE LEVELS:\n- "high": all hunks in this group cleanly map to conversation turns\n- "medium": most hunks mapped, some inferred from diff structure\n- "low": this group contains primarily unexplained changes (catch-all)\n\nOUTPUT — return ONLY a JSON object (not an array):\n{\n  "overallConfidence": "high" | "medium" | "low",\n  "groups": [\n    {\n      "hunks": [1, 3],\n      "message": "feat(auth): ログインフォームにバリデーションを追加",\n      "confidence": "high",\n      "turnIndices": [1, 2]\n    },\n    {\n      "hunks": [5],\n      "message": "chore: ヘルパー関数を追加",\n      "confidence": "low",\n      "note": "会話ログに対応するターンなし"\n    }\n  ]\n}',

    // ── diff-analyzer.ts: intent-based user prompt ────────────
    "diffAnalyzer.intentBuildPrompt":
      '=== CONVERSATION HISTORY ===\n{turnLogText}\n\n=== NUMBERED DIFF HUNKS ===\n{numberedHunksText}\n\n上記の会話履歴とdiff hunkに基づいて、コミットグループを作成してください。\n\n重要な判断基準:\n- 会話で意図された変更がdiffに現れているhunk → 会話の流れでグループ化\n- diffにはあるが会話で説明できないhunk → 別グループに（confidence: low）\n- 会話で言及されたがdiffにない変更は無視する（コミット対象外なので）\n- 同一ファイル内の異なるhunkが異なる会話ターンに対応する場合は分割する\n\nメッセージは実際に行われた変更（アシスタントの応答 + diff内容）を反映させること。\nユーザーの依頼が実際の変更と食い違っている場合は、実際の変更を優先すること。\n\nJSONオブジェクトのみを返してください。',

    // ── diff-analyzer.ts: intent-based fallback notification ──
    "diffAnalyzer.intentLowConfidence": "会話ログとdiffの乖離が大きいため、diffベースの分割に切り替えます。",
    "diffAnalyzer.intentMediumConfidence": "一部の変更が会話ログと整合しません。--review での確認を推奨します。",

    // ── footer-manager.ts: accumulate mode ─────────────────────
    "footer.autoCommit.accumulate":
      "auto-commit: accumulate ({turns} turns) | {files} files",
    "footer.autoCommit.accumulateWarn":
      "⚠ auto-commit: accumulate ({turns} turns) | {files} files",
    "footer.autoCommit.accumulateCritical":
      "!! auto-commit: accumulate ({turns} turns) | {files} files — run /git-agg-commit",

    // ── batch-committer.ts ─────────────────────────────────────
    "batchCommit.warnThreshold":
      "{count} turns of uncommitted changes accumulated. Run /git-agg-commit to commit.",
    "batchCommit.modeSwitchNotice":
      "Switched to accumulate mode. Changes will accumulate across turns. Use /git-agg-commit to commit.",

    // ── auto-commit-message.ts: system prompt ──────────────────
    "autoCommitMsg.systemPrompt":
      "You are a commit message generator. From the following information, understand what changes were made and generate a single Conventional Commit message.\n\nThe GIT DIFF is the most reliable source of what actually changed. Use it as the primary driver for the commit message. The user's request provides intent, and the assistant's response and changed files list are supplementary.\n\nRules:\n- Choose type from: feat, fix, docs, style, refactor, test, chore\n- Write the subject in English\n- Keep subject under 50 characters\n- Use imperative mood\n- Include scope only if clearly inferable from the diff\n\nDo NOT generate vague, non-specific messages such as:\n- \"chore: apply changes\", \"chore: update files\", \"chore: fix\", \"chore: modify\"\n- Any message that only uses generic verbs without referencing what actually changed in the diff\n- Any message whose subject appears nowhere in the GIT DIFF\n\nGood examples (specific, grounded in diff):\n→ feat(auth): add login form\n→ fix(payment): add null check in processor\n\nBad examples (NEVER generate):\n→ chore: apply changes\n→ chore: update files\n→ fix: fix issue\n\nReturn ONLY the commit message string. No explanations or code fences.",

    // ── auto-commit-message.ts: few-shot examples ──────────────
    "autoCommitMsg.examples":
      'Examples:\n\nUser request: "Add a login form to the auth page"\nAssistant response: "I\'ve added login.tsx with form validation and connected it to the auth API."\nChanged files: src/auth/login.tsx, src/auth/api.ts\n→ feat(auth): add login form\n\nUser request: "Fix the null pointer error in the payment flow"\nAssistant response: "Added null check in PaymentProcessor.handle(). The error should be resolved now."\nChanged files: src/payment/processor.ts\n→ fix(payment): add null check in processor\n\nUser request: "Refactor UserProfile to extract Avatar and Bio into separate components"\nAssistant response: "Extracted Avatar and Bio from UserProfile into their own components."\nChanged files: src/components/UserProfile.tsx, src/components/Avatar.tsx, src/components/Bio.tsx\n→ refactor(components): extract Avatar and Bio from UserProfile\n\nUser request: "Add log level configuration to config.ts"\nAssistant response: "Added logLevel option to config.ts with default value \"info\"."\nChanged files: src/config.ts\n→ feat(config): add logLevel option',

    // ── auto-commit-message.ts: user prompt ────────────────────
    "autoCommitMsg.buildPrompt":
      "{examples}\n\n=== USER REQUEST ===\n{userSection}\n\n=== ASSISTANT RESPONSE ===\n{assistantSection}\n\n=== CHANGED FILES ===\n{filesSection}\n\n=== GIT DIFF ===\n{diffSection}\n\nBased on the GIT DIFF and USER REQUEST above, generate a single Conventional Commit message in English that best captures the intent of the changes.",

    // ── auto-commit-message.ts: message comparison ─────────────
    "autoCommitMsg.compareSystemPrompt":
      "Return only 'A' or 'B' to indicate the better commit message candidate.",
    "autoCommitMsg.comparePrompt":
      'Two commit message candidates for the same changes:\n\nA: "{candidateA}"\nB: "{candidateB}"\n\nChanged files: {files}\n\nChoose the one that is MORE SPECIFIC and accurately describes the changes.\nReply with ONLY a single character: A or B.',

    // ── auto-commit-message.ts: fallback text for empty diff
    "autoCommitMsg.noDiffAvailable": "(no diff available — new files)",

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
      "diff分析に使用するAIモデル（形式: model-id または provider/model-id）",
    "config.keyDesc.auto_agg_commit_min_files":
      "確認をトリガーする最大変更ファイル数（非推奨: 現在は常に確認ダイアログが表示されます）",
    "config.keyDesc.auto_agg_commit_min_lines":
      "確認をトリガーする最大変更行数（非推奨: 現在は常に確認ダイアログが表示されます）",
    "config.keyDesc.auto_agg_commit_skip_confirm_files":
      "確認をスキップする最大変更ファイル数（0 = 常に確認。どちらかの条件を満たせば確認をスキップ）",
    "config.keyDesc.auto_agg_commit_skip_confirm_lines":
      "確認をスキップする最大変更行数（0 = 常に確認。どちらかの条件を満たせば確認をスキップ）",
    "config.keyDesc.auto_agg_commit_mode":
      "コミットモード: per_turn（毎ターンコミット）または accumulate（/git-agg-commitで一括コミット）",
    "config.keyDesc.batch_warn_turns":
      "コミットリマインダーを表示する蓄積ターン数（0 = 無効）",

    // ── auto-commit.ts ─────────────────────────────────────────
    "autoCommit.commitFailed": "コミットに失敗しました: {error}",
    "autoCommit.commitCreated": "コミットを作成しました: {message}",

    // ── auto-commit-confirm.ts ─────────────────────────────────
    "autoCommit.confirmTitle": "自動コミットの確認",
    "autoCommit.confirmBody":
      "{files}個のファイルを変更（{lines}）。コミットしますか？",
    "autoCommit.confirmBodyLines": "{count}行",
    "autoCommit.confirmBodyBinary": "バイナリ",
    "autoCommit.confirmYes": "はい (Enter)",
    "autoCommit.confirmNo": "いいえ (Esc)",
    "autoCommit.confirmMoreFiles": "...他{count}ファイル",
    "autoCommit.confirmNewFile": "（新規）",
    "autoCommit.confirmSkipped":
      "自動コミットをスキップしました",
    "autoCommit.skippedSmallChange": "小規模変更のため確認をスキップします（{files}ファイル, {lines}行）",
    "autoCommit.confirmTimedOut":
      "自動コミット確認がタイムアウトしました — スキップ",

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

    // ── diff-analyzer.ts: extended system prompt (with TurnLog) ─
    "diffAnalyzer.systemPromptWithContext":
      'git diffを論理的なhunkに分割してください。会話ログを変更の意図を理解するために使用しますが、DIFFが常に最優先の情報源です。\n\n優先順位:\n1. Diff構造（ファイルの実際の変更内容）\n2. ファイルの共起パターン（どのファイルが一緒に変更されるか）\n3. TurnLogのFilesフィールド（ターンごとのファイル相関）\n4. TurnLogの会話テキスト（意図のヒント）\n\nルール:\n- 各hunk = 単一の論理的な変更\n- 1つの変更が複数の会話ターンに跨ることがある — 1ターン=1hunkを強制しない\n- 会話ログが不明瞭またはdiffと矛盾する場合は、常にdiffを優先する\n- diffに含まれるファイルがTurnLogにない場合は、無理にターンに紐付けない\n- 同じファイルが複数ターンで変更された場合は、最も最近のターンを優先する\n- コミットメッセージのサブジェクトは必ず日本語で記述する\n\n禁止事項（以下のような汎用的で具体性のないメッセージは絶対に生成しない）:\n- 「変更を適用」「ファイルを更新」「修正しました」\n- GIT DIFFに現れていない単語だけを使ったメッセージ\n\nJSON配列のみを返してください。説明やコードフェンスは不要。',

    // ── diff-analyzer.ts: extended user prompt (with TurnLog) ─
    "diffAnalyzer.buildPromptWithContext":
      '=== GIT DIFF（最優先 — 実際に変更された内容） ===\n```diff\n{diff}\n```\n\n=== 会話ログ（補助 — 変更の意図を理解するためだけに使用） ===\n{turnLogText}\n\n上記のdiffを論理的なhunkに分割してください。会話ログは変更の理由を理解するためだけに使用し、diffの構造を上書きしないでください。\nコミットメッセージのサブジェクトは必ず日本語で記述してください。\nJSON配列のみを返してください。',

    // ── diff-analyzer.ts: intent-based system prompt ──────────
    "diffAnalyzer.intentSystemPrompt":
      'あなたはコミット分解エンジンです。会話履歴とdiff構造に基づいて、git diffの変更を論理的なコミットに分割してください。\n\n入力:\n- 会話履歴: ユーザー依頼 + アシスタント応答 + ターンごとの変更ファイル\n- 番号付きdiff hunk: 各@@ブロックに [H1], [H2], ... の番号を付与\n\n中心タスク:\n各番号付きdiff hunkについて、以下を決定する:\n(a) どの会話ターンに属するか（該当する場合）\n(b) 他のどのhunkと論理的なコミットを形成するか\n(c) このグループ化の確信度\n\nグループ化ルール:\n1. 同じ会話の意図に明らかに属するhunk → 1つのコミットグループ\n2. 単一ターンの依頼に複数の独立した変更が含まれる → 分割する（例: 「ログイン追加とREADME修正」→ 2グループ）\n3. 複数ターンに跨る関連変更（同じ機能の反復的改善） → 1つに統合\n4. 会話ログに明確な対応がないdiff hunk → 「説明不能な変更」として別グループに\n5. すべてのdiff hunk [HN] は必ずどこかのコミットグループに割り当てること\n\nコミットメッセージルール:\n- Conventional Commits: type(scope): subject （日本語、命令形、50文字以内）\n- ユーザー依頼とアシスタント応答の両方から生成する\n- 両者が食い違う場合は、アシスタントの説明（実際に行われたこと）を優先する\n- 具体的に — diffの変更内容を反映させる\n- 禁止: 「変更を適用」「ファイルを更新」「修正しました」「対応しました」\n\n確信度:\n- "high": このグループの全hunkが会話ターンに明確に対応\n- "medium": ほとんどのhunkが対応、一部はdiff構造から推測\n- "low": 主に説明不能な変更（catch-all）\n\n出力 — JSONオブジェクトのみを返す（配列ではない）:\n{\n  "overallConfidence": "high" | "medium" | "low",\n  "groups": [\n    {\n      "hunks": [1, 3],\n      "message": "feat(auth): ログインフォームにバリデーションを追加",\n      "confidence": "high",\n      "turnIndices": [1, 2]\n    },\n    {\n      "hunks": [5],\n      "message": "chore: ヘルパー関数を追加",\n      "confidence": "low",\n      "note": "会話ログに対応するターンなし"\n    }\n  ]\n}',

    // ── diff-analyzer.ts: intent-based user prompt ────────────
    "diffAnalyzer.intentBuildPrompt":
      '=== 会話履歴 ===\n{turnLogText}\n\n=== 番号付きDIFF HUNK ===\n{numberedHunksText}\n\n上記の会話履歴とdiff hunkに基づいて、コミットグループを作成してください。\n\n重要な判断基準:\n- 会話で意図された変更がdiffに現れているhunk → 会話の流れでグループ化\n- diffにはあるが会話で説明できないhunk → 別グループに（confidence: low）\n- 会話で言及されたがdiffにない変更は無視する（コミット対象外なので）\n- 同一ファイル内の異なるhunkが異なる会話ターンに対応する場合は分割する\n\nメッセージは実際に行われた変更（アシスタントの応答 + diff内容）を反映させること。\nユーザーの依頼が実際の変更と食い違っている場合は、実際の変更を優先すること。\n\nJSONオブジェクトのみを返してください。',

    // ── diff-analyzer.ts: intent-based fallback notification ──
    "diffAnalyzer.intentLowConfidence": "会話ログとdiffの乖離が大きいため、diffベースの分割に切り替えます。",
    "diffAnalyzer.intentMediumConfidence": "一部の変更が会話ログと整合しません。--review での確認を推奨します。",

    // ── footer-manager.ts: accumulate mode ─────────────────────
    "footer.autoCommit.accumulate":
      "auto-commit: accumulate ({turns}ターン) | {files}ファイル",
    "footer.autoCommit.accumulateWarn":
      "⚠ auto-commit: accumulate ({turns}ターン) | {files}ファイル",
    "footer.autoCommit.accumulateCritical":
      "!! auto-commit: accumulate ({turns}ターン) | {files}ファイル — /git-agg-commit を実行してください",

    // ── batch-committer.ts ─────────────────────────────────────
    "batchCommit.warnThreshold":
      "{count}ターンの未コミット変更が蓄積されています。/git-agg-commit でコミットしてください。",
    "batchCommit.modeSwitchNotice":
      "accumulateモードに切り替えました。変更はターンごとに蓄積されます。コミットするには /git-agg-commit を実行してください。",

    // ── auto-commit-message.ts: system prompt ──────────────────
    "autoCommitMsg.systemPrompt":
      "あなたはコミットメッセージ生成ツールです。以下の情報から、どのような変更が行われたかを読み取り、Conventional Commit メッセージを1つ生成してください。\n\nGIT DIFF は実際に何が変更されたかを示す最も信頼できる情報源です。これを主軸にコミットメッセージを決定してください。ユーザーのリクエストは変更の意図を、アシスタントの応答と変更ファイル一覧は補完情報です。\n\nルール:\n- type は feat, fix, docs, style, refactor, test, chore から選択\n- サブジェクトは必ず日本語で記述する\n- サブジェクトは50文字以内\n- 命令形を使用する\n- スコープは推測できる場合のみ含める\n\n禁止事項（以下のような汎用的で具体性のないメッセージは絶対に生成しないでください）:\n- 「変更を適用」「変更を反映」「更新しました」「修正しました」「対応しました」「ファイルを更新」\n- GIT DIFF に現れていない単語だけを使ったメッセージ\n- 具体的なファイル名や変更内容に言及していないメッセージ\n\n良い例（GIT DIFF の内容を具体的に反映）:\n→ feat(auth): ログインフォームにバリデーションを追加\n→ fix(payment): nullチェックを追加\n\n悪い例（絶対に生成しない）:\n→ chore: 変更を適用\n→ chore: 修正しました\n\n返答はメッセージ文字列のみ。説明やコードフェンスは不要。",

    // ── auto-commit-message.ts: few-shot examples ──────────────
    "autoCommitMsg.examples":
      "例:\n\nユーザーの依頼: 「認証ページにログインフォームを追加して」\nアシスタントの応答: 「login.tsx にバリデーション付きのフォームを追加し、認証APIに接続しました」\n変更ファイル: src/auth/login.tsx, src/auth/api.ts\n→ feat(auth): ログインフォームを追加\n\nユーザーの依頼: 「支払いフローのnullポインタエラーを修正して」\nアシスタントの応答: 「PaymentProcessor.handle() にnullチェックを追加しました」\n変更ファイル: src/payment/processor.ts\n→ fix(payment): nullチェックを追加\n\nユーザーの依頼: 「UserProfileをリファクタリングしてAvatarとBioを別コンポーネントに抽出して」\nアシスタントの応答: 「UserProfileからAvatarとBioを別コンポーネントに抽出しました」\n変更ファイル: src/components/UserProfile.tsx, src/components/Avatar.tsx, src/components/Bio.tsx\n→ refactor(components): UserProfileからAvatarとBioを抽出\n\nユーザーの依頼: 「config.tsにログレベル設定を追加して」\nアシスタントの応答: 「config.tsにlogLevelオプションを追加し、デフォルト値をinfoに設定しました」\n変更ファイル: src/config.ts\n→ feat(config): logLevelオプションを追加",

    // ── auto-commit-message.ts: user prompt ────────────────────
    "autoCommitMsg.buildPrompt":
      "{examples}\n\n=== ユーザーのリクエスト ===\n{userSection}\n\n=== アシスタントの応答 ===\n{assistantSection}\n\n=== 変更されたファイル ===\n{filesSection}\n\n=== GIT DIFF ===\n{diffSection}\n\n上記の GIT DIFF とユーザーのリクエストを主軸に、変更の意図を最もよく表す Conventional Commit メッセージを1つ、**必ず日本語で**生成してください。",

    // ── auto-commit-message.ts: message comparison ─────────────
    "autoCommitMsg.compareSystemPrompt":
      "AまたはBの1文字だけを返し、より良いコミットメッセージ候補を示してください。",
    "autoCommitMsg.comparePrompt":
      '同じ変更に対する2つのコミットメッセージ候補:\n\nA: "{candidateA}"\nB: "{candidateB}"\n\n変更ファイル: {files}\n\nより**具体的で**、変更内容を正確に表している方を選び、\n**A または B の1文字だけ**を返してください。\n説明や補足は一切不要です。',

    // ── auto-commit-message.ts: fallback text for empty diff
    "autoCommitMsg.noDiffAvailable": "（新規ファイルのため diff はありません）",

    // ── auto-commit-message.ts: fallback text for empty sections
    "autoCommitMsg.noData": "（なし）",

    // ── core fallback commit message ───────────────────────────
    "core.applyChanges": "chore: 変更を適用",
  },
} as const;

/** Union of all valid message keys (derived from English catalog). */
export type MessageKey = keyof typeof messages.en;
