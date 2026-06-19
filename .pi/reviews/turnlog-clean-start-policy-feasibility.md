# TurnLog クリーンスタートポリシー レビュー (v2)

## レビュー観点

技術的実現可能性と pi-coding-agent 連携の観点から、`.pi/plans/turnlog-clean-start-policy.md` v2 を検証した。

## Review

### Correct: 既に良好な点

- **`hasChanges()` の動作を確認済み**。`src/core/git.ts` の `hasChanges()` は `git status --porcelain` を使用し、`stdout.trim().length > 0` で判定する。これにより staged / unstaged / untracked のすべての変更を検知できる。
- **ヘルパー関数の切り出しが適切**。`src/core/turn-log-cleaner.ts` に `maybeClearTurnLogOnCleanStart()` を分離することで、`index.ts` の複雑さを増やさずにテスト可能性を向上させている。
- **DI（依存注入）パターン**。`TurnLog` インスタンスを引数で注入できる設計により、テストでモックや新規インスタンスを使いやすい。
- **orphan recovery との順序が正しい**。`recoverOrphanedStashes()` より先に判定を行う。
- **安全側に倒している**。`hasChanges()` が失敗した場合はクリアしない。

### Fixed: 指摘事項（v1 からの修正）

- **自動クリアロジックを `src/core/turn-log-cleaner.ts` に切り出した**。これにより v1 で懸念された `index.ts` のテスト困難性が大幅に軽減される。
- **エラーメッセージを i18n 化**。`clearTurnlog.error` を追加。
- **`--help` 応答を実装**。`clearTurnlog.help` を追加。

### Blocker: 実装前に解決が必要な課題

- **特になし**。v2 時点で重大なブロッカーは確認できない。

### Note: リスク・追加検慮事項

- **`getStatus()` が `GitError` を throw する**。`maybeClearTurnLogOnCleanStart()` の catch ブロックはこれを捕捉するが、`GitError` のメッセージを握りつぶすだけでログに残さない。開発時のデバッグには不便かもしれないが、本番動作としては許容範囲。
- **`turnLog.turnCount > 0` の判定**。`turnCount` は `entries.length` を返す getter であり、空の場合に無駄な `clear()` 呼び出しを避けられる。
- **コマンド名の discoverability**。`/git-clear-turnlog` は機能が明確。`docs/accumulate-mode.md` への記載で補完される。

## 結論

プランは技術的に実現可能で、設計も適切。v2 の修正によりテスト容易性も確保されている。実装を進めてよい。
