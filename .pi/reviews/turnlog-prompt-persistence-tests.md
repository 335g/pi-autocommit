# Review: TurnLog プロンプト永続化拡張 — テスト計画・検証観点

対象計画: `.pi/plans/turnlog-prompt-persistence.md`
確認対象ファイル:
- `src/core/turn-log.test.ts`
- `src/core/diff-analyzer.test.ts`
- `src/core/analyze-diff-intent.e2e.ts`
- 実装参考: `src/core/turn-log.ts`, `src/core/diff-analyzer.ts`, `src/types.ts`, `src/utils/diagnostics.ts`

---

## Review

### Correct — すでに整っている点

- **後方互換の土台がある**。`src/core/turn-log.test.ts` は既に version 1 ファイルの読み込み、欠落フィールド、破損 JSON、空ファイル、非オブジェクト JSON などをカバーしている（L190–L280 あたりの `corrupted file` / `MAX_ENTRIES enforcement` ブロック）。このため、version 1 → 2 のマイグレーションの負荷軽減テストは追加しやすい。
- **単体テストの基盤が充実**。`TurnLog` クラスを直接 new して検証でき、`initialize()` / `append()` / `formatForPrompt()` / ディスク書き込みの往復を網羅している（L40–L110, L112–L140）。新フィールド追加に伴う保存・読み出しテストは既存パターンに乗せられる。
- **E2E シナリオの骨格は現実的**。`analyze-diff-intent.e2e.ts` は実際の git リポジトリを作成し、2 ターンの会話＋人手編集を再現している（L35–L115）。これは「保存プロンプト有無」で hunk グルーピングがどう変わるかを確認する舞台として有効。

### Blocker — 計画・実装直後にテストで必ず落ちる・欠陥を見逃す重大なギャップ

1. **version 2 ファイルの読み込みテストが計画にない**
   - 計画 4.1/4.4/8 では `PersistedTurnLog.version` を `2` に上げるとしているが、現行 `src/core/turn-log.ts` の `loadFromDisk()` は `obj.version !== 1` で即リターンする（L215）。
   - 計画 5.1 の「version 1 → version 2 のマイグレーション」テストは「古いファイルが読める」ことしか言及していない。version 2 ファイルが **書き込まれた直後に再読み込みされて 0 エントリになる** という最悪ケースをカバーしていない。
   - **必要なテスト**: version 2 の `turn-log.json` を手動で書き込み、`initialize()` 後にエントリが復元されること。

2. **新フィールドを持つ `AgentEndEvent` の生成がテストhelpersにない**
   - `turn-log.test.ts` の `makeEvent()`（L29）と `analyze-diff-intent.e2e.ts` の `makeTurnEvent()`（L115）は `messages` のみで、`systemPrompt` / `rawUserPrompt` を渡せない。
   - 計画 5.1/5.3 で追加予定の「プロンプト保存」「プロンプトセクション付きシナリオ」は、helper 修正なしでは実装できない。

3. **`diff-analyzer.test.ts` がプロンプト関連を全くカバーしていない**
   - 現状は `parseDiffHunks`, `formatNumberedHunks`, `validateHunkCoverage` のみ（L144–L300）。
   - 計画 4.5/5.1 の「`analyzeDiffIntent()` のモック呼び出しで prompt セクションが含まれること」「保存済みプロンプトを含む `formatForPrompt()` 出力」は未記載・未実装。
   - `buildIntentPrompt()` や `getIntentSystemPrompt()` は `diff-analyzer.ts` 内で `export` されていない（L405–L418）ため、計画のテスト意図を実現するにはテスト用の export 追加か間接検証が必要。計画にその設計がない。

### Note — リスク・不足・補強が必要なエッジケース

4. **切り詰め・予算のテストが抽象的すぎる**
   - 計画 4.6/5.1 で「プロンプトが `MAX_CHARS` 制限を超えた場合の切り詰め」とあるが、具体的な戦略が未定（「MAX_CHARS 予算内で統合」としか書かれていない）。
   - 検証すべきケース:
     - `systemPrompt` / `rawUserPrompt` が 2,000 文字を超えたとき `tailTruncate` されること（計画 4.3）。
     - `formatForPrompt()` でプロンプトセクション追加後、全体が `TurnLog.MAX_CHARS` を超えた場合の挙動（最新ターンを優先して Drop? プロンプトセクション自体を省略?）。
     - 混合エントリ（一部ターンにプロンプトあり、一部なし）で欠落ターンが黙ってスキップされること。
   - 現行 `formatForPrompt()` は ` TurnLog.MAX_CHARS = 8_000` でブレークするが（L160–L190）、プロンプトセクション追加後のブレーク条件は未定義。

5. **後方互換：再保存時のバージョン書き換えを検証すべき**
   - 計画 4.8 では「次回 `append` 時に version 2 形式で保存される」とあるが、テスト計画にその検証がない。
   - 具体的には: version 1 ファイルを読み込んだ後に `append()` し、ディスク上の `version` が `2` になり、かつ旧エントリの `systemPrompt`/`rawUserPrompt` が `undefined` のまま保存されること。

6. **診断カウンターの不整合とテスト欠如**
   - 計画 4.5 の `batch-committer.ts` 例では `diagIncr("intentPath_usedStoredPrompts")` としているが、計画 4.7 で定義されているのは `intentPath_usedStoredSystemPrompt`, `intentPath_usedStoredUserPrompt`, `intentPath_missingStoredPrompts`（3 つ）。
   - 現行 `src/utils/diagnostics.ts` にはこれらが未定義（L40 以降）。
   - テスト計画でも「カウンターがインクリメントされること」の検証がない。モック化した `diagIncr` を使うか、実行後に `diagSnapshot()` を検証する設計が必要。

7. **`systemPrompt` の分析時扱いが未決定でテスト設計ができない**
   - 計画 9.1 の「案 A / 案 B」は未決定。テスト観点が変わる:
     - 案 A（保存 system prompt を優先）: `analyzeDiffIntent()` の `aiComplete` 呼び出し引数 `systemPrompt` が可変であることを検証。
     - 案 B（保存 system prompt は user prompt セクション内）: `buildIntentPrompt()` 出力に `=== ORIGINAL PROMPTS ===` セクションが含まれることを検証。
   - 計画 4.5 は両案を混在させて記述しており、テストケースが確定していない。

8. **E2E は実際の AI 呼び出しを伴わない**
   - `analyze-diff-intent.e2e.ts` の `--call-ai` は現状未実装（L140: "not yet implemented"）。計画 5.3 の「プロンプトセクション付きシナリオ」は prompt 表示のみで終わり、実際の `parseHunkGroupingResult` 経由の意図分解結果までは検証できない。
   - 現行 E2E 内の `buildIntentPrompt()` / `getIntentSystemPrompt()` は `src/i18n/messages.ts` 内の本番テンプレートと別物（L180–L230）。計画 4.5 でテンプレートに `{promptSection}` プレースホルダーを追加する場合、E2E 内のコピーも更新が必要。更新忘れを防ぐため、E2E は本番 `t(lang, ...)` を使うリファクタを検討すべき。

9. **型安全の検証が不足**
   - 計画 4.1/4.2 で `AgentEndEvent` に `systemPrompt?: string`, `rawUserPrompt?: string` を追加するが、実際の `agent_end` イベントがこれらをどの型で運んでくるかは Phase 0 調査事項（計画 8, 7）。
   - テストでは、数値やオブジェクトが渡された場合の型ガード・無害化もカバーすべき。現行 `append()` は truthy チェックのみで `tailTruncate` するため、仮に `systemPrompt` が非文字列の場合ランタイム例外になる可能性がある。

10. **統合テストのモック戦略が不明確**
    - 計画 5.2 は「実 AI 呼び出しは環境依存のため、モック主体」としているが、`aiComplete()` のモック方法、`ExtensionContext` のセット方法、プロンプト内容のアサーション方法が具体化されていない。
    - `diff-analyzer.ts` の `aiComplete` はトップレベル import（L17）なので、`node:test` のモック（`mock.fn` 等）で差し替えるか、依存注入を検討する必要がある。計画に実現方法がない。

---

## まとめ

- 計画は高レベルなテスト方針は示しているが、**version 2 ロード、新フィールド helper 修正、`diff-analyzer` 側の prompt 検証、診断カウンター、切り詰め戦略** が具体化されていない。
- 特に **Blocker 1「version 2 ファイルが読めない」** は、計画どおり実装すると本番でもデータ消失を起こす。テスト計画に必ず version 2 ファイルの読み込み・再保存を含める必要がある。
- Blocker 2/3 を解決するまでは、計画 5.1/5.3 に書かれたテスト追加は実行不可能。
- 提案: Phase 1 実装前に、以下を計画に追加すること。
  1. `turn-log.test.ts` の `makeEvent()` に `systemPrompt` / `rawUserPrompt` 引数を追加。
  2. `loadFromDisk()` の version 読み込みロジックを `version <= 2` に変更し、version 2 保存・再読み込みテストを追加。
  3. `diff-analyzer.test.ts` に `buildIntentPrompt` / `getIntentSystemPrompt` の出力検証、または `aiComplete` モックを使った `analyzeDiffIntent` 検証を追加。
  4. 診断カウンター名を統合し、`diagSnapshot()` / モックでインクリメントを検証するテストを追加。
  5. E2E の `--call-ai` 未実装部分を解消するか、少なくとも本番 `i18n` テンプレートを使った prompt 構築検証に切り替える。
