# i18n リファクタリング計画: `t()` のキー参照化

## 背景

現在の `t()` は呼び出し側に日本語と英語の文字列を直書きする設計:

```typescript
t(lang, "コミットメッセージ生成中...", "Generating messages...")
```

→ 3言語目以降を追加する場合、すべての呼び出し箇所を修正する必要がある。

## 目標

`t()` をキー参照型に変更し、翻訳文字列をコードから分離する:

```typescript
t(lang, "phase.generateMessage")  // → リソースマップから自動解決
```

## スコープ

| 対象 | 内容 |
|------|------|
| `src/utils/lang.ts` | `t()` のシグネチャ変更 + 新実装 |
| `src/i18n/messages.ts`（新規） | 全翻訳文字列を格納するキー付きマップ |
| 呼び出し元 7ファイル | `t(lang, ja, en)` → `t(lang, key, params?)` に置換 |

## 設計

### 1. 新しい `t()` のインターフェース

```typescript
// src/utils/lang.ts

import { messages, type MessageKey } from "../i18n/messages.js";

export function t(
  lang: string,
  key: MessageKey,
  params?: Record<string, string>,
): string {
  // サポート外の言語は en にフォールバック
  const langKey = (lang in messages) ? lang : "en";
  let text: string = (messages as any)[langKey]?.[key]
                  ?? (messages as any)["en"]?.[key]
                  ?? key; // 最終フォールバック: キー名をそのまま表示

  // プレースホルダ {key} を置換（単一パス: 値の相互汚染を防止）
  if (params) {
    text = text.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
  }
  return text;
}
```

### 2. 翻訳リソースの構造 (`src/i18n/messages.ts`)

```typescript
export const messages = {
  en: {
    "footer.prepare": "[pi-git] Preparing...",
    "footer.collectDiff": "[pi-git] Collecting diff...",
    "footer.analyze": "[pi-git] Analyzing hunks...",
    "footer.generateMessage": "[pi-git] Generating messages...",
    "footer.commit": "[pi-git] Committing...",
    "footer.autoCommit.prepare": "[pi-git: auto-commit] Preparing...",
    // ... (全メッセージ)
  },
  ja: {
    "footer.prepare": "[pi-git] 準備中...",
    "footer.collectDiff": "[pi-git] diff収集中...",
    "footer.analyze": "[pi-git] hunk解析中...",
    "footer.generateMessage": "[pi-git] コミットメッセージ生成中...",
    "footer.commit": "[pi-git] コミット実行中...",
    "footer.autoCommit.prepare": "[pi-git: auto-commit] 準備中...",
    // ...
  },
} as const;

// 型エクスポート
export type MessageKey = keyof typeof messages.en;
```

### 3. キー命名規則

```
<ファイル略称>.<カテゴリ>.<具体名>
```

| プレフィックス | 対象ファイル |
|----------------|-------------|
| `footer.*` | `footer-manager.ts` |
| `aggCommit.*` | `agg-commit.ts` |
| `autoAggCommit.*` | `auto-agg-commit.ts` |
| `config.*` | `config.ts` |
| `autoCommit.*` | `auto-commit.ts` |
| `diffAnalyzer.*` | `diff-analyzer.ts` |
| `autoCommitMsg.*` | `auto-commit-message.ts` |

### 4. 変数補間

現在はテンプレートリテラルで変数を埋め込んでから `t()` に渡している:

```typescript
// 現状
t(lang, `${prefix} 準備中...`, `${prefix} Preparing...`)
t(lang, `[pi-git] ${key}=${parsed} を保存しました`, `[pi-git] Saved ${key}=${parsed}`)
```

↓

```typescript
// 新: プレースホルダで対応
t(lang, "footer.prepare", { prefix })
t(lang, "config.saved", { key, value: String(parsed) })
```

メッセージ定義側:
```
"footer.prepare": "{prefix} 準備中..."
"config.saved": "[pi-git] {key}={value} を保存しました"
```

### 5. 長大なシステムプロンプトの扱い

`diff-analyzer.ts` と `auto-commit-message.ts` のシステムプロンプトは非常に長い（各30～50行）。これらも同じ `messages` オブジェクトに格納する。`messages.ts` は大きくなるが、1ファイルに集約されている方がメンテナンスしやすいと判断。

### 6. `auto-commit-message.ts` の言語依存フォールバック文字列

`buildPrompt` 内の `|| "(なし)"` / `|| "(none)"` は言語依存のフォールバック値。これらを個別のメッセージキー（`autoCommitMsg.noUserRequests` など）として切り出し、呼び出し側で `t()` 解決してからテンプレートに埋め込む。

### 7. `VALID_KEYS_META` の移行

`src/utils/settings.ts` の `VALID_KEYS_META` は `description_ja` / `description_en` フィールドを持ち、`config.ts` の `--keys` ハンドラで `t(lang, meta.description_ja, meta.description_en)` として使われている。`KeyMeta` に `messageKey: MessageKey` フィールドを追加し、呼び出し側を `t(lang, meta.messageKey)` に変更する。

## 移行手順

### Step 1: 土台作成
- `src/i18n/messages.ts` を新規作成（全メッセージキー + 型定義）
- `src/utils/lang.ts` の `t()` を新シグネチャに変更、`isJapanese()` を削除

### Step 2: 全ファイルを一括移行

`t()` のシグネチャ変更後は旧呼び出しがすべてコンパイルエラーになるため、全7ファイルを一括で移行する。

| ファイル | メッセージ数 | 備考 |
|----------|-------------|------|
| `footer-manager.ts` | 10 | prefix変数あり |
| `auto-commit.ts` | 2 | 通知のみ |
| `agg-commit.ts` | 2 | help + 実行中警告 |
| `auto-agg-commit.ts` | 5 | シンプルな通知 |
| `config.ts` | 13 | 変数補間多数 + `--keys` ハンドラ |
| `diff-analyzer.ts` | 4 | 長大なシステムプロンプト |
| `auto-commit-message.ts` | 8 | 長大なシステムプロンプト + comparisonPrompt + フォールバック文字列 |

### Step 3: 最終確認
- `npx tsc --noEmit` が通ること
- `src/utils/settings.ts` の `VALID_KEYS_META` を `messageKey` フィールドに移行
- 旧 `t()` 呼び出しが残っていないこと

## 影響範囲

| 変更 | ファイル |
|------|---------|
| 新規作成 | `src/i18n/messages.ts` |
| 修正 | `src/utils/lang.ts` |
| 修正 | `src/utils/settings.ts`（`VALID_KEYS_META` に `messageKey` 追加） |
| 修正 | `src/utils/footer-manager.ts` |
| 修正 | `src/commands/agg-commit.ts` |
| 修正 | `src/commands/auto-agg-commit.ts` |
| 修正 | `src/commands/config.ts` |
| 修正 | `src/core/auto-commit.ts` |
| 修正 | `src/core/diff-analyzer.ts` |
| 修正 | `src/core/auto-commit-message.ts` |
| 影響なし | `src/types.ts`, `src/index.ts`, `src/core/git.ts`, `src/core/commit-message.ts`, `src/core/resolve-model.ts` |

## リスク

- **リスク**: タイポによる実行時エラー（キー名間違い）
  **対策**: TypeScript の `MessageKey` 型でコンパイル時に検出
- **リスク**: プレースホルダ `{key}` が diff 内の `{...}` と衝突
  **対策**: 現在のプロンプト内に `{変数名}` 形式のテキストは存在しないことを確認済み
- **リスク**: 順次 `replaceAll` による値の相互汚染（パラメータ値が別のプレースホルダを含む場合）
  **対策**: 単一パスの正規表現置換 `text.replace(/\{(\w+)\}/g, ...)` を使用
- **リスク**: シグネチャ変更後のコンパイルエラー（全ファイル同時に壊れる）
  **対策**: 全ファイルを一括で移行、最終的に1回の `tsc` で確認

## 将来の作業（今回のスコープ外）

- `src/commands/agg-commit.ts` 内の `t()` を通っていないハードコード英文字列（`"Not a git repository"`, `"Created N commits"` など）の i18n 対応
- `src/commands/auto-agg-commit.ts` の dead constant `P = "[pi-git]"` の削除（メッセージマップ移行後に不要になる）
