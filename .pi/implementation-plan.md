# Implementation Plan: Migrate local settings from `.pi-git/settings.json` to `pi-git.toml`

## Overview

- **Goal**: ローカル設定の保存先を `<repo-root>/.pi-git/settings.json` から `<repo-root>/pi-git.toml` に変更する
- **Scope**: ローカル設定のみ。グローバル設定 (`~/.config/pi-git/settings.json`) は現状維持
- **Format change**: JSON → TOML
- **Estimated effort**: 中規模（設定I/Oのコア部分 + ドキュメント更新 + マイグレーション対応）

---

## Impact Analysis

### 影響を受けるファイル一覧

| ファイル | 変更内容 | 重要度 |
|----------|----------|--------|
| `src/utils/settings.ts` | コアの読み書きロジックを JSON→TOML に変更 | 🔴 高 |
| `src/commands/config.ts` | ドキュメントコメント・エラーメッセージのパス表記を更新 | 🟡 中 |
| `src/commands/auto-agg-commit.ts` | 直接のパス参照なし。`saveLocalSettings()` 経由のため変更不要 | 🟢 低 |
| `docs/commands.md` | 全パス参照と設定ファイルセクションの更新 | 🟡 中 |
| `docs/commands.ja.md` | 同上（日本語版） | 🟡 中 |
| `README.md` | パス表記の更新 | 🟡 中 |
| `README.ja.md` | 同上 | 🟡 中 |
| `.gitignore` | `.pi-git/` → `pi-git.toml` のignore判断の見直し（任意） | 🟢 低 |
| `package.json` | TOMLパーサー依存の追加 | 🔴 高 |

### 影響を受けないファイル

- `src/core/*` — 設定ファイルの読み書きを直接行っていない
- `src/utils/lang.ts`, `src/utils/diagnostics.ts`, `src/utils/footer-manager.ts` — settings API経由でアクセス
- `src/i18n/*` — メッセージキーはパスを含まない設計のため（`settings.json` という文字列はi18nに含まれていない）
- `dist/*` — ビルド成果物。`tsc`再実行で自動更新

---

## Detailed Change Plan

### Step 1: TOMLライブラリの追加

`package.json` の `dependencies` に TOML パーサーを追加する。

```bash
npm install smol-toml
```

**選択理由**: `smol-toml` は軽量（~3KB min+gzip）、依存ゼロ、ESMネイティブ対応、TypeScript型付き。

```json
// package.json に追記
{
  "dependencies": {
    "smol-toml": "^1.x"
  }
}
```

### Step 2: `src/utils/settings.ts` の変更

#### 2a. 定数の変更

```diff
-const LOCAL_SETTINGS_DIR = ".pi-git";
-const LOCAL_SETTINGS_FILE = "settings.json";
+const LOCAL_SETTINGS_FILE = "pi-git.toml";
```

#### 2b. `getLocalSettingsPath()` の変更

```diff
 export function getLocalSettingsPath(cwd?: string): string | null {
   try {
     const repoRoot = execSync("git rev-parse --show-toplevel", {
       cwd,
       encoding: "utf-8",
       stdio: ["pipe", "pipe", "ignore"],
     }).trim();
     if (!repoRoot) return null;
-    return join(repoRoot, LOCAL_SETTINGS_DIR, LOCAL_SETTINGS_FILE);
+    return join(repoRoot, LOCAL_SETTINGS_FILE);
   } catch {
     return null;
   }
 }
```

#### 2c. TOML読み込み関数の追加と `loadRaw()` の修正

`loadJson(path)` はグローバル設定読み込み用に残しつつ、ローカル設定用に `loadToml(path)` を追加:

```typescript
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

function loadToml(path: string): PiGitSettings | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = parseToml(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as PiGitSettings;
  } catch {
    return null;
  }
}
```

`loadRaw()` 内でローカルは `loadToml()` を使用:

```diff
-const local = localPath ? loadJson(localPath) : null;
+const local = localPath ? loadToml(localPath) : null;
```

#### 2d. `saveLocalSettings()` の変更（JSON → TOML書き出し）

```diff
 export function saveLocalSettings(
   settings: Partial<PiGitSettings>,
   cwd?: string,
 ): void {
   const localPath = getLocalSettingsPath(cwd);
   if (!localPath) {
     throw new Error("Not inside a git repository");
   }
   mkdirSync(dirname(localPath), { recursive: true });
-  const current = loadJson(localPath) ?? {};
+  const current = loadToml(localPath) ?? {};
   const updated = { ...current, ...settings };
-  writeFileSync(localPath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
+  writeFileSync(localPath, stringifyToml(updated), "utf-8");
   cache.clear();
 }
```

> **Note**: `mkdirSync(dirname(localPath), ...)` は `pi-git.toml` がリポジトリルート直下に置かれるため、基本的に常に存在するディレクトリになる。`recursive: true` は安全のため残す。

#### 2e. JSDocコメントの更新

```diff
 /**
  * Persistent settings storage for pi-git extension.
  *
  * Settings are stored in:
  * - Global: ~/.config/pi-git/settings.json
- * - Local:  <git-root>/.pi-git/settings.json (takes precedence)
+ * - Local:  <git-root>/pi-git.toml (takes precedence)
  */
```

### Step 3: `src/commands/config.ts` の変更

ドキュメントコメントのパス表記のみ更新。コードロジックは `getLocalSettingsPath()` と `saveLocalSettings()` に依存しているため変更不要。

```diff
 /**
  * /git-config command
  *
  * Get, set, and list pi-git configuration values.
  * Supports both global (~/.config/pi-git/settings.json)
- * and local (<repo>/.pi-git/settings.json) scopes.
+ * and local (<repo>/pi-git.toml) scopes.
  */
```

### Step 4: `src/commands/auto-agg-commit.ts`

変更不要（`saveLocalSettings`, `getLocalSettingsPath` 経由でアクセスしているため）。

### Step 5: ドキュメント更新

#### `docs/commands.md`
- `/.pi-git/settings.json` → `pi-git.toml` に全置換 (20箇所程度)
- 設定ファイルセクションの例をTOML形式に更新
- gitignore推奨事項の更新

#### `docs/commands.ja.md`
- 同上の日本語版対応

#### `README.md` / `README.ja.md`
- パス表記の更新 (各1箇所)

### Step 6: `.gitignore` の更新（任意）

現状 `.pi-git/` がignoreされている。`pi-git.toml` はリポジトリルート直下に置かれるため:
- チームで共有したい場合: ignore不要（むしろコミット推奨）
- 個人設定の場合: `pi-git.toml` を `.gitignore` に追加

`.pi-git/` ディレクトリのignoreは、他の `.pi-git/` 内ファイルが存在する可能性も考慮し、安全のため残す（削除しない）。

### Step 7: ビルドと検証

```bash
npm run build
```

`tsc` でコンパイルエラーがないことを確認。

### Step 8: 既存設定のマイグレーション（オプショナル）

既存の `.pi-git/settings.json` から `pi-git.toml` への自動マイグレーションは、v1では**実装しない**。

**理由**:
1. ユーザーが手動で移行するのは容易（キーは3つのみ、フラットな構造）
2. 自動マイグレーションの複雑さ（存在確認、上書き判断、エッジケース）に見合わない
3. `pi-git` はまだv0.0.3であり、本番ユーザーが多数存在する状況ではない

**代替**: リリースノートに手動マイグレーション手順を記載する。

---

## TOMLフォーマットの例

```toml
# pi-git.toml — local pi-git configuration
lang = "ja"
auto_agg_commit = true
analysis_model = "anthropic/claude-3-5-sonnet-20241022"
```

`/git-config` で設定した場合も上記のフォーマットで保存される。

---

## リスクと注意点

| リスク | 対策 |
|--------|------|
| `smol-toml` の `stringify` が `""` や `false` を期待通り出力するか | 事前に手動テスト |
| TOMLパーサーがJSONと異なる型推論をする可能性 | `PiGitSettings` 型で明示的にアサート。`lang`, `auto_agg_commit`, `analysis_model` はすべてTOMLの基本型（文字列、真偽値）なので問題ない |
| グローバル設定 (JSON) とローカル設定 (TOML) でフォーマットが異なることの認知負荷 | ドキュメントに明記。`/git-config` コマンドの使用を推奨 |
| `smol-toml` が `parse("")` で例外を投げるか | `loadToml()` 内で try-catch しているため安全 |

---

## Implementation Order (推奨)

1. **Step 1**: `npm install smol-toml` — 依存追加
2. **Step 2**: `src/utils/settings.ts` の改修 — コアロジック
3. **Step 3**: `src/commands/config.ts` のコメント更新
4. **Step 7**: `npm run build` でコンパイル確認
5. **Step 5**: ドキュメント更新
6. **Step 6**: `.gitignore` の検討
7. **Step 8**: リリースノート作成

---

## Files NOT to Change (確認済み)

| ファイル | 理由 |
|----------|------|
| `src/core/*.ts` | 設定ファイルパスを直接参照していない |
| `src/utils/footer-manager.ts` | settings API経由 |
| `src/utils/diagnostics.ts` | settings API経由 |
| `src/utils/lang.ts` | settings API経由 |
| `src/i18n/messages.ts` | `settings.json` の文字列リテラルを含まない |
| `dist/*` | ビルドで自動生成 |
