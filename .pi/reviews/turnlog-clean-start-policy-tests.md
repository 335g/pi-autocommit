# Review: TurnLog クリーンスタートポリシー — テスト計画 (v2)

対象計画: `.pi/plans/turnlog-clean-start-policy.md` v2
確認対象ファイル（予定）:
- `src/core/turn-log-cleaner.ts`
- `src/core/turn-log-cleaner.test.ts`
- `src/index.ts`
- `src/commands/diagnostics.ts`
- `src/utils/diagnostics.ts`

---

## Review

### Correct — すでに整っている点

- **ヘルパー関数のテストが中心**。`src/core/turn-log-cleaner.test.ts` で `maybeClearTurnLogOnCleanStart()` を直接テストする戦略は優れている。
- **DI パターンでテスト容易**。`TurnLog` インスタンスを注入できるため、ディスク書き込みを伴わないテストが可能。
- **境界値カバー**。clean / dirty / empty / error の 4 ケースは網羅的。
- **診断カウンターの検証**。`diagSnapshot()` を使ってカウンター増加を検証する計画は実現可能。

### Blocker — 計画・実装直後にテストで必ず落ちる・欠陥を見逃す重大なギャップ

- **特になし**。v2 時点で重大なブロッカーはない。

### Note — リスク・不足・補強が必要なエッジケース

1. **`hasChanges()` のモック実装**
   - テスト計画では `makeMockPi({ status: "" })` のような想定を示しているが、実際には `pi.exec("git", ["status", "--porcelain"], { cwd })` をモックする必要がある。
   - 提案: `pi.exec` の呼び出しを攔截して、`command === "git" && args[0] === "status"` の場合にモック stdout/code を返すヘルパーを作成する。

2. **staged / unstaged / untracked の境界値**
   - テスト計画に以下を追加するとより堅牢になる。
     - `M  file.ts`（ステージング済み）
     - ` M file.ts`（未ステージング）
     - `?? file.ts`（未追跡）
     - 複数行の混在

3. **`turnLog.turnCount === 0` の分岐**
   - 「空の場合はクリアしない」という分岐をテストする計画はある。追加で、`clear()` が呼ばれないこと（= ディスク操作が発生しないこと）も検証できるとよい。

4. **手動コマンドのテスト**
   - `--help` 応答のテストは明記されている。
   - エラーケースのテストも `clearTurnlog.error` の i18n 検証まで含まれている。
   - 追加提案: `turnLog.clear()` の前後で `pendingPrompts` の長さが変化することを検証。

5. **統合テスト**
   - 実際の pi セッションを使わない範囲で、クリーンなリポジトリで `maybeClearTurnLogOnCleanStart()` を呼んだ後に `turn-log.json` が削除されることを検証。

6. **build / test 実行**
   - プランの実装手順に `npm run build` / `npm test` が含まれている。新規テストファイルが `package.json` の `test` スクリプト `src/**/*.test.ts` に含まれるため、追加設定は不要。

---

## まとめ

v2 のテスト計画は十分に具体化されている。特にヘルパー切り出しにより、`index.ts` の複雑なモックを避けられる点が優れている。実装時に上記 Note の補強（staged/unstaged/untracked の境界値、pendingPrompts 検証）を加えるとより堅牢になる。

実装を進めてよい。
