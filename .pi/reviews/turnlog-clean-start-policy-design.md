# Review: TurnLog クリーンスタートポリシー (v2)

対象: `.pi/plans/turnlog-clean-start-policy.md` v2

## 1. 自動クリアの設計

### Correct
- **判定条件が明確**。`git status --porcelain` が空 = working tree クリーン。
- **ヘルパー関数の分離が優れている**。`src/core/turn-log-cleaner.ts` に切り出すことで、ビジネスロジックと pi イベント配線の分離ができている。
- **安全側に倒している**。`hasChanges()` 失敗時はクリアしない。
- **orphan recovery との順序が正しい**。

### Note
- **`turnLog.turnCount > 0` 条件**。無駄なディスク書き込みを避ける配慮として適切。
- **ヘルパー関数のシグネチャ**。`maybeClearTurnLogOnCleanStart(pi, cwd, log = turnLog)` はシンプルでテストしやすい。

## 2. 手動コマンドの設計

### Correct
- **確認ダイアログなし**。明示的なコマンドであるため許容範囲。
- **`pendingPrompts` もクリア**。次の `agent_end` で古いプロンプトが紐付くリスクを防ぐ。
- **`--help` 応答**。`clearTurnlog.help` で実装される。
- **エラーメッセージ i18n 化**。`clearTurnlog.error` で実装される。

### Note
- **コマンド名の一貫性**。既存の `/git-agg-commit`、`/git-config`、`/git-diagnostics` と命名パターンが一致している。
- **ヘルプメッセージの内容**。`/git-agg-commit` との関係を説明しており、適切。

## 3. 診断カウンター

### Correct
- **カウンター名が明確**。`turnLog_autoClearedOnCleanStart` / `turnLog_manuallyCleared`。
- **セクション分離**。`src/commands/diagnostics.ts` に "TurnLog management" セクションを追加する案は妥当。

## 4. i18n メッセージ

### Correct
- **最小限のキー追加**。success / error / help の 3 キーのみ。
- **エラーメッセージに `{error}` プレースホルダ**。動的メッセージに対応。

### Note
- **日本語 help メッセージ**。簡潔で分かりやすい。

## 5. テスト計画

### Correct
- **`turn-log-cleaner.test.ts` が中心**。`index.ts` ではなくヘルパーをテストする戦略は適切。
- **境界値をカバー**。clean / dirty / empty / error の 4 ケース。

### Fixed（v1 からの修正）
- **`index.ts` 直接テストの重荷が解消**。ヘルパー切り出しにより、主要なロジックは `turn-log-cleaner.test.ts` で検証可能。

### Note
- **手動コマンドのテスト**。`ExtensionCommandContext` のモックが依然として必要だが、これは UI 通知の検証に限定される。ハンドラ内のロジック自体は単純なため、テスト負荷は低い。

## 総合評価

設計方針は妥当。v2 での修正（ヘルパー切り出し、i18n、help）により、実装前に解決すべき課題は残っていない。実装を進めてよい。
