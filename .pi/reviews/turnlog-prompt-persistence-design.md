# Review: TurnLog プロンプト永続化拡張 実装プラン

対象: `.pi/plans/turnlog-prompt-persistence.md`

## 1. TurnEntry スキーマ設計

### Correct
- `systemPrompt` / `rawUserPrompt` を **任意フィールド** で追加する方針は妥当。
  - 現行 `TurnEntry`（`src/core/turn-log.ts` L32-L44）に必須フィールドを追加しないため、旧データの読み込みが自然に許容される。
  - `loadFromDisk()`（L285-L351）が既存の必須フィールドのみを検証しており、未知/欠落の任意フィールドは無視される設計と整合する。

### Note
- **rawUserPrompt と userMessage の重複リスク**がある。
  - 現状 `append()`（L98-L131）は `event.messages` から最新 user メッセージを抽出し `userMessage` に格納している。
  - 計画は「生のユーザープロンプト」を `rawUserPrompt` に保存するとしているが（3.1 節）、その定義が不明確（計画 9.2 節で「未決定事項」として言及）。
  - もし `rawUserPrompt` が user メッセージと同じ内容を含む場合、同一情報が 2 重に保持されディスクサイズが無駄に増大する。
- **systemPrompt の変動頻度**が考慮されていない。
  - セッション/リポジトリ単位でほぼ変わらない可能性が高いが、ターンごとに保存される（3.1 節）。
  - 永続化サイズ抑制の観点から、ターン間で重複する systemPrompt を de-duplication する案も検討に値するが、計画では言及されていない。

## 2. version 1→2 マイグレーション安全性

### Blocker
- 現行 `loadFromDisk()`（`src/core/turn-log.ts` L311-L316）に以下の厳格なバージョンチェックがある。

```typescript
if (obj.version !== 1) {
  console.warn(
    `[pi-git] Unsupported turn-log.json version: ${obj.version} — starting fresh`,
  );
  return;
}
```

- 計画は `PersistedTurnLog.version` を 2 に上げつつ「version 1 も読み込める」としている（4.1, 4.4, 4.8 節）が、**上記チェックを `version !== 1 && version !== 2` に変更する旨が計画に明記されていない**。
- 実装時にこの修正を忘れると、既存の version 1 ファイルが全て破棄され、後方互換性が失われる。

### Fixed（計画への追記推奨）
- 計画 4.1 または 4.4 節に、以下を明記すべき。
  - `loadFromDisk()` の `if (obj.version !== 1)` を `if (obj.version !== 1 && obj.version !== 2)` に変更。
  - version 1 読み込み時は `systemPrompt` / `rawUserPrompt` を `undefined` として扱う。
  - 次回 `saveToDisk()` 時に `version: 2` で書き出す。

### Note
- 現行のエントリ検証（L332-L347）は必須フィールドのみを確認するため、version 1 エントリが欠落フィールドを許容されて読み込まれる点は問題なし。
- ただし、任意フィールドに対する型検証（例: `systemPrompt` が文字列かどうか）は現状も今後も行われない。これは意図通りだが、不正な型が混入した場合の挙動は実装側で無視される。

## 3. MAX_ENTRIES / MAX_CHARS の調整

### Blocker
- 計画 4.6 節の数値バランスに整合性の問題がある。

| 項目 | 現状 | 計画案 |
|---|---|---|
| エントリあたり最大文字数（userMessage+assistantExcerpt+prompts+files） | ~1,100〜1,500 chars | ~5,000 chars（prompts 追加で +4,000） |
| MAX_ENTRIES | 20 | 10（検討） |
| MAX_CHARS（prompt 用） | 8,000 | 12,000〜16,000（検討） |

- 1 エントリあたり最大約 5,000 chars、MAX_ENTRIES=10 と仮定すると、理論上は 50,000 chars 超の TurnLog が発生しうる。
- 一方 `MAX_CHARS` を 16,000 にする場合、**実質的に 3 エントリ分程度のプロンプトしか入らず、MAX_ENTRIES=10 の恩恵が半減する**。
- 現行 `formatForPrompt()`（L156-L220）は `TurnLog.MAX_CHARS` を超えた時点で切り捨てるため、MAX_ENTRIES を増やしても多くは無駄になる。

### Note
- `diff-analyzer.ts` 側の `MAX_INTENT_PROMPT_CHARS = 20_000`（L101）との関係が考慮されていない。
  - `analyzeDiffIntent()`（L421-L476）では `numberedHunksText.length + turnLogText.length + 3000 > 20_000` の場合に TurnLog を切り詰めている。
  - `TurnLog.MAX_CHARS` を 16,000 に引き上げると、diff サイズによっては `analyzeDiffIntent` 側でさらに切り詰めが発生し、カウンター `intentPath_promptTruncated` が意図せず頻発する可能性がある。
- 推奨: `MAX_ENTRIES`、`MAX_CHARS`、`MAX_INTENT_PROMPT_CHARS`、diff サイズ見積もりをセットでチューニングし、計画にその根拠を記載すること。

## 4. formatForPrompt 統合の清潔さ

### Blocker
- 計画 4.5 節に **2 つの相反する設計が混在**している。

#### 設計 A: `formatForPrompt()` 内でプロンプトセクションを埋め込む
```typescript
// 計画 4.5 より引用
formatForPrompt(): string {
  // ... 既存の blocks 生成 ...
  const promptBlocks: string[] = [];
  for (const e of reversed) { ... }
  // MAX_CHARS 予算内で既存 blocks + promptBlocks を統合
}
```

#### 設計 B: `buildIntentPrompt()` に `promptSection` 引数を追加する
```typescript
// 計画 4.5 より引用
function buildIntentPrompt(turnLogText, numberedHunksText, promptSection, lang)
```

- もし `formatForPrompt()` 内でプロンプトを埋め込む（設計 A）なら、`turnLogText` 1 本で `diff-analyzer.ts` に渡せるため、`buildIntentPrompt()` のシグネチャ変更は不要。
- もし `buildIntentPrompt()` に分離する（設計 B）なら、`formatForPrompt()` は従来通り会話履歴のみを返し、プロンプトセクションは別途生成する必要がある。
- 計画は両方を同時に採用するように読め、実装時に矛盾を生む。

### Note
- 設計 A を採用する場合、**プロンプトセクションの切り捨て優先順位**を明確にすべき。
  - 現行 `formatForPrompt()` は最新エントリから順に追加し、予算オーバーで停止する。
  - プロンプトセクションを会話ブロックの後に追加すると、予算が tight な場合に常にプロンプトが切り捨てられ、計画の目的である「意図に忠実な分析」が損なわれる。
  - 逆に、プロンプトを先に確保すると会話履歴が失われる。どちらを優先するかは計画 9.1 節の「system prompt の扱い」と絡む未決定事項。
- 現行 `formatForPrompt()` は日本語マーカー（`【依頼】`、`【応答】`、`【ファイル】`）を使用している（L189-L214）。プロンプトセクションのマーカー（計画では `【System】`、`【User】`）と統一感はあるが、差別化は明確。

## 5. 診断カウンター追加

### Blocker
- 計画 4.7 節と 4.5 節で追加されるカウンター名が **不一致**。

計画 4.7 節の提案:
```typescript
intentPath_usedStoredSystemPrompt: number;
intentPath_usedStoredUserPrompt: number;
intentPath_missingStoredPrompts: number;
```

計画 4.5 節の `batch-committer.ts` 例:
```typescript
diagIncr("intentPath_usedStoredPrompts");
```

- `intentPath_usedStoredPrompts` は `DiagSnapshot` に存在しない。実装時に型エラーとなる。

### Note
- カウンターの定義場所とインクリメント場所の分離が計画されていない。
  - `analyzeDiffIntent()`（`src/core/diff-analyzer.ts` L421-L476）は `turnLogText`（文字列）のみを受け取るため、各ターンに `systemPrompt` / `rawUserPrompt` が含まれているかを判断できない。
  - したがって、これらのカウンターは `batch-committer.ts` 側で `turnLog.getEntries()` を走査してインクリメントする必要がある。
  - 計画 4.5 節は `batch-committer.ts` に `diagIncr("intentPath_usedStoredPrompts")` とあるが、**どの分岐で、どのような条件でインクリメントするか**が不明確。
- `intentPath_missingStoredPrompts` の粒度も不明確。
  - ターン単位？コミット単位？バッチ単位？
  - 例: version 1 から移行された古いエントリが混在する場合、一部のターンにしかプロンプトがない状況でどうカウントするか。

### Fixed（計画への追記推奨）
- `DiagSnapshot` に追加するカウンター名を統一する。
- インクリメントロケーションを `batch-committer.ts` 内の `turnLog.getEntries()` 走査処理として明示するか、あるいは `formatForPrompt()` がメタデータ（使用したプロンプト有無）も返す設計に変更する。

## 6. その他の観点

### Note
- **Phase 0 調査の重要性**が適切に認識されている（計画 8 節）。
  - 現行 `AgentEndEvent`（`src/types.ts` L25-L30）には `messages` のみ定義されており、`systemPrompt` / `rawUserPrompt` は存在しない。
  - pi-coding-agent の実際のイベント構造を確認する前に実装を進めると、取得できないフィールドを扱うコードが残るリスクがある。
- **`src/index.ts` の `agent_end` ハンドラ**は計画で言及されているが、レビュー対象外として読んでいない。実装時に `append(event, changedFiles)` の呼び出しがそのまま動作するか確認が必要。
- テスト計画（5.1 節）は網羅的。
  - ただし `formatForPrompt()` の「prompt セクションを含む/含まない」両パターンと、MAX_CHARS 制限下での切り詰め順序を検証するケースを追加すべき。

## 総合評価

- スキーマ拡張の方向性と後方互換の方針は正しい。
- 実装前に以下を必ず解決すること。
  1. `loadFromDisk()` の version チェックを 1/2 両方許可に変更。
  2. `formatForPrompt()` 内埋め込みか `buildIntentPrompt()` 引数追加か、どちらか一方の設計に統一。
  3. `MAX_ENTRIES` / `MAX_CHARS` / `MAX_INTENT_PROMPT_CHARS` の数値を整合させ、根拠を計画に記載。
  4. 診断カウンター名とインクリメント箇所を一致させ、粒度を明確化。
  5. `rawUserPrompt` の定義を確定させ、`userMessage` との重複を排除または正当化する。
