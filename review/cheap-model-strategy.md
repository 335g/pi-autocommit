# 安価モデル向け高精度コミットメッセージ生成戦略

## 現状のアーキテクチャ分析

### 2つのコミットメッセージ生成経路

| 経路 | トリガー | 入力 | 主要モジュール |
|------|----------|------|----------------|
| 明示的 `/git-agg-commit` | ユーザー手動 | git diff (stash スナップショット) | `diff-analyzer.ts` |
| 自動コミット | `agent_end` イベント | 会話履歴 (user + assistant) | `auto-commit-message.ts` |

### 現在の耐障害性（既にある防御策）

```
[生成] → [JSONパース] → [Conventional Commits検証] → [sanitize (型推論フォールバック)]
                              ↓ 失敗
                         [ファイル単位フォールバック]
```

**既存の強み:**
- `sanitizeCommitMessage()`: 型推論 + 正規化 + 切り詰め
- `isGenericMessage()` + `refineMessageIfGeneric()`: 汎用メッセージ検出 + AI比較
- `specificityScore()`: ヒューリスティックスコアリング
- `inferTypeFromFiles()`: ファイルパスからの型推論
- `fallbackFileBasedHunks()`: 最低限のファイル単位フォールバック
- `splitDiffIntoBatches()`: 大規模 diff のバッチ分割
- `stripDiffNoise()`: diff ノイズ除去

### 安価モデルで問題になる箇所

| # | 問題 | 影響範囲 | 深刻度 |
|---|------|----------|--------|
| 1 | **不正なJSON出力** (コードフェンス欠落、余計なテキスト付加、括弧不一致) | `diff-analyzer.ts:parseHunks()` | 高 |
| 2 | **誤った Conventional Commits Type** (feat/fix/chore の混同) | 両経路 | 中 |
| 3 | **汎用的すぎるメッセージ** ("update files", "fix bugs") | `auto-commit-message.ts` | 高 |
| 4 | **不適切なファイルグルーピング** (無関係なファイルを同一 hunk に) | `diff-analyzer.ts` | 中 |
| 5 | **言語混在** (日本語指定時に英語が混ざる) | 両経路 | 低 |
| 6 | **会話意図の誤抽出** (ユーザーの依頼意図を読み違える) | `auto-commit-message.ts` | 高 |
| 7 | **スコープの誤推論** (存在しないスコープや不適切なスコープ) | 両経路 | 低 |

---

## 提案する仕組み: 「プログレッシブ生成パイプライン」

安価モデルの弱点を補うため、**1回の生成に頼らず、段階的な検証・修復・エスカレーション** を行う。

```
[Step 1] 制約付き生成 (Few-shot + 型ヒント付きプロンプト)
    ↓
[Step 2] 構造検証 + 正規表現リペア
    ↓ (修復失敗)
[Step 3] 分解再生成 (タスクを小さく分割して再試行)
    ↓ (それでも失敗)
[Step 4] ルールベースフォールバック (既存と同等)
```

### Step 1: 制約付き生成 (Few-shot + 型アンカー)

**変更対象**: `diff-analyzer.ts` の `getSystemPrompt()` と `buildPrompt()`、
`auto-commit-message.ts` の `getSystemPrompt()` と `buildPrompt()`

**内容**:
プロンプトに 2-3 個の concrete な few-shot 例を追加する。安価モデルは例示で劇的に精度が向上する。

```typescript
// 例: diff-analyzer のシステムプロンプトに追加
const FEW_SHOT_EXAMPLES = `
Examples of correct output:

Input diff: src/auth/login.ts (added login function), src/auth/types.ts (added User type)
Output:
[
  {"files": ["src/auth/login.ts", "src/auth/types.ts"], "message": "feat(auth): add login functionality"}
]

Input diff: README.md (fixed typo), package.json (no change)
Output:
[
  {"files": ["README.md"], "message": "docs: fix typo in README"}
]
`;
```

**型アンカー**: diff を送る前に、ファイル拡張子から推論される型をヒントとしてプロンプトに注入する。

```
Hint: Based on file analysis, likely types are: feat (src/auth/*.ts), docs (README.md)
```

### Step 2: 構造検証 + 正規表現リペア (JSON Rescue)

**変更対象**: `diff-analyzer.ts` の `parseHunks()` を強化

**内容**: JSON.parse が失敗した場合、以下の修復を順に試みる:

```typescript
function parseHunksWithRepair(text: string): Hunk[] {
  // 1. コードフェンス抽出 (既存)
  // 2. JSON.parse (既存)
  // 3. NEW: 末尾の余計なテキストを除去してリトライ
  // 4. NEW: 正規表現で {files, message} ペアを抽出
  // 5. NEW: 行単位で "file: message" パターンを検出
  // 6. fallbackFileBasedHunks (既存)
}
```

**正規表現リペアの具体例**:
```typescript
// 壊れたJSONからファイルとメッセージのペアを抽出
const PAIR_PATTERN = /\{[^}]*"files"\s*:\s*\[(.*?)\][^}]*"message"\s*:\s*"([^"]+)"[^}]*\}/gs;
```

### Step 3: 分解再生成 (Decomposed Retry)

**変更対象**: `diff-analyzer.ts` の `analyzeDiff()`、`auto-commit-message.ts` の `generateAutoCommitMessage()`

**内容**: 1回目の生成が低品質だった場合、タスクをより小さなサブタスクに分解して再試行する。

#### diff-analyzer 向け:

```
[1回目] 全diff → AI → hunks (従来通り)
    ↓ 品質チェック失敗 (例: 全ファイルが1hunkにグループ化されている)
[2回目] ファイルを1つずつAIに送り、個別のコミットメッセージを生成
    → 結果をマージ
```

品質チェック基準:
- 生成された hunk 数が少なすぎる（例: 20ファイル変更なのに1hunk）
- メッセージが汎用的すぎる（`isGenericMessage` が全 hunk にヒット）
- JSON構造が壊れている

#### auto-commit-message 向け:

```
[1回目] 全会話 → AI → メッセージ (従来通り)
    ↓ 汎用メッセージ検出
[2回目] ユーザーメッセージのみ → AI → 意図抽出
    アシスタント応答の最終ターンのみ → 要約
    → 2つの結果をテンプレート合成
```

### Step 4: ルールベースフォールバック (既存のまま)

現在の `fallbackFileBasedHunks()` や `sanitizeCommitMessage()` は十分に堅牢。この層は変更不要。

---

## 追加施策: 軽量バリデーション層

### A. 型一貫性チェック

**新規**: `commit-message.ts` に追加

```typescript
function validateTypeConsistency(message: string, files: string[]): boolean {
  // feat なのにテストファイルしかない → 警告
  // fix なのに新規ファイルのみ → 警告
  // docs なのに .ts のみ → 警告
}
```

### B. ファイル-メッセージ関連性スコア

**新規**: `diff-analyzer.ts` に追加

生成されたメッセージの単語が、変更ファイルのパスやdiff内容に出現するかをチェックし、
関連性の低いメッセージを検出する。

```typescript
function relevanceScore(message: string, files: string[], diffSnippet: string): number {
  const messageWords = extractKeywords(message);
  const contextWords = [...files.flatMap(f => f.split('/')), ...extractKeywords(diffSnippet)];
  // Jaccard類似度などでスコア計算
}
```

### C. 多肢生成 + 投票 (軽量版)

**新規**: 共通ユーティリティ

高価なモデルでのみ有効な手法だが、安価モデルでも temperature を変えて2回生成し、
ヒューリスティックスコアで良い方を選ぶ方式はコスト2倍で精度向上が見込める。

```typescript
async function generateWithVoting(
  generate: (temp: number) => Promise<string>,
  scorer: (msg: string) => number,
): Promise<string> {
  const candidates = await Promise.all([
    generate(0),
    generate(0.3),
  ]);
  return candidates.reduce((best, c) => scorer(c) > scorer(best) ? c : best);
}
```

ただし、この施策は API コストが2倍になるため、デフォルトではオフ（設定でオンにできるオプション）とする。

---

## 実装優先順位

| 優先度 | 施策 | コスト | 効果 | リスク |
|--------|------|--------|------|--------|
| 🔴 P0 | Few-shot 例をプロンプトに追加 | 低（プロンプト変更のみ） | 高（安価モデルで顕著） | 低（トークン増加のみ） |
| 🔴 P0 | JSON 正規表現リペア | 低（~30行追加） | 高（壊れたJSONの救出） | 低 |
| 🟡 P1 | 型アンカー（ファイル拡張子ヒント） | 低（~20行追加） | 中（型精度向上） | 低 |
| 🟡 P1 | 分解再生成（品質ゲート付き） | 中（構造変更あり） | 中〜高 | 中（API コール増） |
| 🟢 P2 | 型一貫性チェック | 低 | 低〜中 | 低 |
| 🟢 P2 | ファイル-メッセージ関連性スコア | 中 | 低〜中 | 低 |
| 🔵 P3 | 多肢生成 + 投票 | 中 | 中 | 中（コスト2倍） |

---

## 想定される効果

| モデル品質 | 現状の成功率（推定） | 施策後の成功率（推定） |
|------------|---------------------|----------------------|
| Claude Sonnet クラス | ~95% | ~98% (+3%) |
| GPT-4o-mini クラス | ~75% | ~90% (+15%) |
| Claude Haiku クラス | ~70% | ~88% (+18%) |
| ローカル小規模モデル | ~50% | ~78% (+28%) |

---

## リスクと注意点

1. **トークン消費増**: Few-shot 例追加でプロンプトが ~300-500 トークン増加。ただし安価モデルはトークン単価が低いため影響は軽微。
2. **API レイテンシ増**: 分解再生成で最大2倍の API コール。ただし品質ゲートを通過した場合は1回で済む。
3. **過剰最適化のリスク**: 高価モデルでは既存のプロンプトで十分な精度が出ている。安価モデル用の施策が高価モデルの出力を劣化させないよう、モデル検出による分岐が必要か検討。
4. **メンテナンス性**: プロンプト内の few-shot 例はハードコードされるため、新しいユースケースに対応できなくなる可能性。定期的な見直しが必要。

---

## 実装しない判断をした施策

- **Self-Reflection (出力を自己批評させる)**: 安価モデルは自己批評も不得手なため逆効果
- **Chain-of-Thought (思考過程を出力させる)**: 出力形式の制約と競合し、JSONパースがさらに困難になる
- **Fine-tuning**: このユースケースに特化したファインチューニングはオーバーエンジニアリング
