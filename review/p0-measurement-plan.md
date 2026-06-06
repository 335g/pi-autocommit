# P0 効果測定計画（実装済: 2026-06-06）

## 実装済み

| # | 項目 | 状態 |
|---|------|------|
| 診断カウンター | `src/utils/diagnostics.ts` + 全分岐点への設置 | ✅ |
| `/git-diagnostics` コマンド | `src/commands/diagnostics.ts` → `index.ts` に登録 | ✅ |
| parseHunks 単体テスト | `review/test-parse-hunks.ts` (12 tests, all passing) | ✅ |
| Git 履歴分析スクリプト | `review/measure-commit-quality.sh` (未作成、以下に仕様) | ⬜ |

## 測定対象

| # | 施策 | 測りたいこと | 該当コード |
|---|------|-------------|-----------|
| A | Few-shot 例 | 汎用メッセージ生成率は下がったか | `auto-commit-message.ts:isGenericMessage()` |
| B | Few-shot 例 | refine（AI比較）発動率は下がったか | `auto-commit-message.ts:refineMessageIfGeneric()` |
| C | Few-shot 例 | Conventional Commits 形式違反率 | `commit-message.ts:isConventionalCommit()` |
| D | JSON リペア | リペア層(3/4)で救出されたhunk数 | `diff-analyzer.ts:tryRegexExtractHunks()` |
| E | JSON リペア | 最終フォールバック（ファイル単位）率 | `diff-analyzer.ts:fallbackFileBasedHunks()` |

---

## 測定方法

### 方法1: 最小限の診断カウンター（コード追加 ~30行）

`src/utils/diagnostics.ts` を新規作成し、各分岐点でカウンターをインクリメント。
セッション終了時または `/git-diagnostics` コマンドでダンプ。

```typescript
// src/utils/diagnostics.ts
export const diag = {
  // parseHunks layers
  parseLayer2_directJSON: 0,
  parseLayer3_trailingStrip: 0,
  parseLayer4_regexExtract: 0,
  parseFallback_fileBased: 0,

  // auto-commit-message quality
  msgIsGeneric: 0,
  msgRefineTriggered: 0,
  msgRefineUsedAI: 0,
  msgSanitized: 0,

  reset() { /* ... */ },
  snapshot() { /* returns copy */ },
};
```

**設置場所（各1行追加）:**

| ファイル | 場所 | インクリメント |
|----------|------|---------------|
| `diff-analyzer.ts:parseHunks()` | Layer 2 成功時 | `diag.parseLayer2_directJSON++` |
| `diff-analyzer.ts:parseHunks()` | Layer 3 成功時 | `diag.parseLayer3_trailingStrip++` |
| `diff-analyzer.ts:parseHunks()` | Layer 4 成功時 | `diag.parseLayer4_regexExtract++` |
| `diff-analyzer.ts:analyzeDiff()` | fallback 到達時 | `diag.parseFallback_fileBased++` |
| `auto-commit-message.ts` | `isGenericMessage()==true` | `diag.msgIsGeneric++` |
| `auto-commit-message.ts` | `refineMessageIfGeneric()` 呼出時 | `diag.msgRefineTriggered++` |
| `auto-commit-message.ts` | refine で AI 比較使用 | `diag.msgRefineUsedAI++` |

**確認方法:** セッション中に `/git-diagnostics` を打つとカウンター値を表示。

**コスト:** 約30行の新規ファイル + 各分岐点1行（計7行）。ビルド・テスト不要。

---

### 方法2: Git 履歴分析スクリプト（コード追加不要）

`review/measure-commit-quality.sh` として配置。直近Nコミットの Conventional Commits 準拠率と汎用メッセージ率を集計。

```bash
#!/bin/bash
# review/measure-commit-quality.sh
N=${1:-50}

echo "=== Last $N commits quality report ==="
echo ""

# Conventional Commits 準拠率
total=$(git log --oneline -$N | wc -l | tr -d ' ')
valid=$(git log --oneline -$N | grep -cE '^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\(.+\))?!?: ' || true)
echo "Conventional Commits rate: $valid / $total ($(echo "scale=1; $valid * 100 / $total" | bc)%)"

# 汎用メッセージ率
generic=$(git log --oneline -$N | grep -ciE '(apply changes|update files|commit changes|modify files)$' || true)
echo "Generic messages:       $generic / $total ($(echo "scale=1; $generic * 100 / $total" | bc)%)"

# フォールバック（ファイル名のみ）率
fallback=$(git log --oneline -$N | grep -ciE '^(feat|fix|chore|docs|style|refactor|test): update [^ ]+$' || true)
echo "File-only fallback:     $fallback / $total ($(echo "scale=1; $fallback * 100 / $total" | bc)%)"

echo ""
echo "=== Recent commit messages ==="
git log --oneline -20
```

---

### 方法3: parseHunks 単体テスト（コード追加 ~60行）

`review/test-parse-hunks.ts` として配置。正常JSON・不正JSONのフィクスチャを `tryRegexExtractHunks()` に通してリペア成功率を検証。

```typescript
// review/test-parse-hunks.ts
import { readFileSync } from "node:fs";

// 簡易テストランナー（jest不要）
const tests = [
  {
    name: "valid JSON with code fence",
    input: '```json\n[{"files":["a.ts"],"message":"feat: add"}]\n```',
    expectHunks: 1,
  },
  {
    name: "trailing text after JSON array",
    input: '[{"files":["a.ts"],"message":"feat: add"}]\nSome extra text the model added',
    expectHunks: 1,
  },
  {
    name: "broken JSON with missing comma",
    input: '[{"files":["a.ts"] "message":"feat: add"}]',
    expectHunks: 1, // regex repair should catch this
  },
  {
    name: "multiple hunks with extra text",
    input: 'Here is the result:\n[{"files":["a.ts"],"message":"feat: add A"},{"files":["b.ts"],"message":"fix: resolve B"}]\nDone.',
    expectHunks: 2,
  },
  {
    name: "completely invalid — fallback to empty",
    input: "I cannot analyze this diff.",
    expectHunks: 0,
  },
];
```

**実行:** `npx tsx review/test-parse-hunks.ts`

---

## 推奨手順

### Step 1: 今すぐ（方法1 + 方法3）

1. **診断カウンターを仕込む**（~30行）
   - P0 の効果をリアルタイムに可視化
   - 安価モデルで数回 `/git-agg-commit` を実行し、Layer 3/4 の発動率を確認
   - リリース前に削除または `console.debug` に格下げ

2. **parseHunks 単体テストを実行**（~60行）
   - リペア正規表現が期待通り動くか即座に検証
   - エッジケースの発見

### Step 2: 1週間後（方法2）

3. **Git 履歴分析スクリプトを実行**
   - P0 実装前後のコミットメッセージ品質を比較
   - 汎用メッセージ率が有意に下がっていれば成功

### Step 3: 判断基準

| 指標 | 閾値 | 判定 |
|------|------|------|
| Layer 3+4 発動率 | > 20% | JSONリペアが有効に機能している |
| Layer 3+4 発動率 | < 2% | モデルが十分高品質 or リペア不要 |
| `isGenericMessage` 率変化 | -50%以上 | Few-shot 例が顕著に効いている |
| `isGenericMessage` 率変化 | ±10%以内 | Few-shot 例の効果は限定的 |
| Conventional Commits 準拠率 | > 90% | 実用上問題なし |
| Conventional Commits 準拠率 | < 70% | P1（型アンカー）の早期着手を検討 |
