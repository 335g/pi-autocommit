# TurnLog プロンプト永続化拡張 実装プラン レビュー

## レビュー観点

技術的実現可能性と pi-coding-agent 連携の観点から、提示された実装プラン（`.pi/plans/turnlog-prompt-persistence.md`）を検証した。

## Review

### Correct: 既に良好な点

- **型拡張方針は安全**。`AgentEndEvent` に `systemPrompt?` / `rawUserPrompt?` を追加する案は、既存の `messages?: Array<{ role: string; content: unknown }>` と同じくオプショナルな拡張なので、既存実装との型互換性は保たれる（`src/types.ts:23-28`）。
- **キャプチャパスは構造的に最小変更**。`src/index.ts:96` の `turnLog.append(event as AgentEndEvent, changedFiles)` は、イベントに追加フィールドが含まれればそのまま利用可能。`agent_end` ハンドラ自体に分岐を入れる必要がない。
- **既存の切り詰めユーティリティが使える**。`tailTruncate()`（`src/utils/message-utils.ts:75-82`）を使う方針は適切で、長大なプロンプトの末尾を保持する用途（ユーザーの最終指示）に合っている。
- **ローカル永続化の方針は一貫している**。`.pi-git/turn-log.json` への書き出し方針は既存と同じで、`.git/info/exclude` による誤コミット防止も継承される（`src/core/turn-log.ts:191-219`）。

### Fixed: 指摘事項

- **version 2 ファイルを現在の `loadFromDisk()` は拒否する**。`src/core/turn-log.ts:285-291` では `obj.version !== 1` の場合に「starting fresh」してしまう。プランの「version 1 → version 2 マイグレーションが安全」という目標を達成するには、ここを `version === 1 || version === 2` を許容するよう変更する必要がある。`TurnEntry` の追加フィールドはオプショナルなので、version 1 読み込み時のランタイム検証は追加フィールドを無視して OK だが、version チェックがブロッカーとなる。

### Blocker: 実装前に解決が必要な課題

- **`AgentEndEvent` へのフィールド追加は pi-coding-agent ランタイムの実装に依存する**。現時点の `src/types.ts` では `AgentEndEvent` は `messages` のみを持つ。`systemPrompt` / `rawUserPrompt` を受け取るためには、pi-coding-agent が `agent_end` イベントにこれらを含めて発火している必要がある。プランの「Phase 0: 調査」は不可欠であり、イベント構造が自明ではない。仮にランタイムが未対応なら、プランで挙げている「`ExtensionContext` から取得」あるいは「`messages` から再構成」フォールバックがない限り、目的である「実際に AI コード生成に使われたプロンプトの保存」は達成できない。
- **`systemPrompt` をそのまま分析 AI の system prompt に使う案は危険**。`src/core/diff-analyzer.ts:370` の `getIntentSystemPrompt(lang)` は「diff hunk を意図でグループ化せよ」という分析用の命令を含むはず。もし保存された元の system prompt をそのまま使うと、意図分析タスクの指示が欠落する可能性がある。プランの「未決定事項 1」で挙げられているが、実装前に案 A / 案 B を決める必要がある。現状の diff-analyzer において、system prompt はタスク固有の命令を含むため、単純な置き換えは推奨できない。

### Note: リスク・追加検討事項

- **プロンプトサイズ増大がコンテキストウィンドウを圧迫する**。`src/core/turn-log.ts:36-37` の `MAX_ENTRIES = 20`、`MAX_CHARS = 8_000` に対し、プランは 1 エントリあたり `systemPrompt` 2,000 文字 + `rawUserPrompt` 2,000 文字の追加を検討。仮に MAX_ENTRIES を 10 に減らしても、プロンプトセクション単体で最大 40,000 文字に達する。一方、`src/core/diff-analyzer.ts:395` の `MAX_INTENT_PROMPT_CHARS = 20,000` は現状で既に diff + turnLogText の合計を制限しており（`src/core/diff-analyzer.ts:399-410`）、TurnLog 部分が肥大化すると diff 側がさらに削られる。`formatForPrompt()` 内で promptBlocks を加える場合、現行の `MAX_CHARS` 枠（8,000）では即座にオーバーし、12,000〜16,000 に拡大しても diff 分析用の 20,000 文字制限との整合性が必要。
- **`rawUserPrompt` と既存 `userMessage` の重複・差異が不明確**。`src/core/turn-log.ts:87-93` では `messages` から最新の user メッセージを抽出し、すでに `userMessage` として 500 文字に切り詰めて保存している。`rawUserPrompt` が「同じ user メッセージの全文」なら重複が大きく、永続化効率が悪い。プランの「未決定事項 2」にもあるが、何を保存するかを明確にすべき。
- **Backward compatibility: 旧ファイルの content に未知フィールドがあっても無視されるが、version 判定が阻害**。上記 Fixed の通り、version 2 対応が必須。また、saveToDisk 側（`src/core/turn-log.ts:321-332`）も `version: 2` を書き込む必要がある。
- **診断カウンター追加は軽微だが型定義の更新が必要**。`src/utils/diagnostics.ts` の `DiagSnapshot` に新規カウンターを追加し、`counters` 定数も初期化する必要がある。これは影響度「小」と評価できる。
- **セキュリティ・プライバシー**。プランでも言及されているが、system prompt / raw user prompt は機密情報（API キー、内部仕様など）を含む可能性が高い。`turn-log.json` はローカルファイルに留まるが、バックアップ・共有・git 誤コミットのリスクが `userMessage` より高まる。暗号化は out of scope としているが、少なくとも「何を保存するか」の選別（マスキング）を検討すべき。
- **テスト計画は網羅的だが、pi-coding-agent の実イベントを模倣するテストが必要**。`AgentEndEvent` に新フィールドを含めたモックイベントを作成し、`append()` / `formatForPrompt()` / `loadFromDisk()` の一連の流れを検証するケースを追加すべき。特に version 1 → version 2 の読み書きロンドリップは必須。

## 結論

プランの方向性は正しいが、**pi-coding-agent の `agent_end` イベント構造を確認する Phase 0 が不可欠**。仮にフィールドが利用可能であっても、以下の 3 点を実装前に解決することを推奨する。

1. `src/core/turn-log.ts:285-291` の version 判定を version 1/2 の両方を許容するよう修正。
2. `systemPrompt` の分析 AI への使い方（置き換え or 併記）を決定し、`src/core/diff-analyzer.ts:370` 周辺の system prompt 構築に反映。
3. `MAX_CHARS` / `MAX_INTENT_PROMPT_CHARS` / `MAX_ENTRIES` の新しい値を、想定される最大プロンプトサイズと AI コンテキストウィンドウに照らして再計算し、diff 分析側の切り詰めが過剰にならないよう調整。
