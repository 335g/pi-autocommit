# TurnLog クリーンスタートポリシー + 手動削除コマンド 実装プラン

## 1. 背景と目的

### 1.1 現状

- `TurnLog` は `.pi-git/turn-log.json` に永続化され、`session_start` 時に自動で復元される
- これは Pi の再起動（Ctrl+R、クラッシュ復帰）に耐えるための設計
- 一方、**git working tree がクリーンな状態で Pi を起動**した場合、前回作業の TurnLog が残り続けると、AI に不要な過去コンテキストが渡り、Hunk 分割の精度を低下させるリスクがある

### 1.2 目的

- working tree がクリーンな状態で `session_start` した場合は、古い TurnLog を自動削除する
- ユーザーが明示的に TurnLog を削除できる手動コマンドを提供する
- 未コミット変更がある場合は、従来通り TurnLog を復元し、作業継続を支援する

---

## 2. 目標と非目標

### 2.1 目標（In Scope）

- `session_start` 時に working tree のクリーン状態を判定し、クリーンなら `turnLog.clear()` を呼ぶ
- 自動クリアロジックをテスト可能なヘルパー関数に切り出す
- 新しいスラッシュコマンド `/git-clear-turnlog` を追加
- `/git-clear-turnlog` はユーザーが明示的に TurnLog を削除する手段を提供
- `/git-clear-turnlog --help` 応答を実装
- 診断カウンターまたは操作ログで削除イベントを追跡可能にする
- 単体テスト・統合テストの追加

### 2.2 非目標（Out of Scope）

- `turn-log.json` のファイル形式変更
- 既存の `/git-agg-commit` の動作変更（commit 成功後のクリアは既存のまま）
- `session_shutdown` 時の自動クリア
- UI 表示の大幅変更

---

## 3. 用語定義

| 用語 | 定義 |
|---|---|
| クリーンな working tree | `git status --porcelain` が空で、未コミットの変更がない状態 |
| 自動クリア | `session_start` 時に上記判定を経て `turnLog.clear()` を呼ぶこと |
| 手動クリア | ユーザーが `/git-clear-turnlog` を実行して `turnLog.clear()` を呼ぶこと |

---

## 4. 設計判断

| 未決定事項 | 決定 |
|---|---|
| 未コミット変更がある場合の動作 | TurnLog を復元し、作業継続を支援（現状維持） |
| 手動コマンド名 | `/git-clear-turnlog` |
| 手動コマンドの確認ダイアログ | **なし**。コマンド実行は明示的な操作であり、誤発火リスクが低い |
| orphan recovery との順序 | `recoverOrphanedStashes()` 実行**前**にクリア判定を行う。 orphan recovery が stash を復元して変更を作る可能性があるため |
| 診断カウンター | `turnLog_autoClearedOnCleanStart`、`turnLog_manuallyCleared` を追加 |
| pendingPrompts クリア | `/git-clear-turnlog` 実行時にも `clearPendingPrompts()` を呼ぶ |
| 自動クリアロジックの切り出し | `src/core/turn-log-cleaner.ts` に `maybeClearTurnLogOnCleanStart()` を定義し、`index.ts` から呼び出す |
| エラーメッセージ | i18n 化（`clearTurnlog.error`） |
| ヘルプ応答 | `/git-clear-turnlog --help` に対し `clearTurnlog.help` を表示 |

---

## 5. 実装詳細

### 5.1 新規 `src/core/turn-log-cleaner.ts`

`session_start` 時の自動クリアロジックを切り出したテスト可能なモジュール。

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hasChanges } from "./git.js";
import { turnLog, type TurnLog } from "./turn-log.js";
import { diagIncr } from "../utils/diagnostics.js";

/**
 * Clear TurnLog if the working tree is clean.
 * Called from session_start to avoid stale context after a fresh start.
 *
 * The TurnLog instance is injectable for testing.
 */
export async function maybeClearTurnLogOnCleanStart(
  pi: ExtensionAPI,
  cwd: string,
  log: TurnLog = turnLog,
): Promise<void> {
  try {
    if (await hasChanges(pi, cwd)) return;
    if (log.turnCount === 0) return;
    log.clear();
    diagIncr("turnLog_autoClearedOnCleanStart");
  } catch {
    // Silently ignore — don't clear if we can't determine status
  }
}
```

### 5.2 `src/index.ts` の変更

`session_start` ハンドラからヘルパーを呼び出す。

```typescript
import { maybeClearTurnLogOnCleanStart } from "./core/turn-log-cleaner.js";

pi.on("session_start", async (_event, ctx) => {
  try {
    clearPendingPrompts();

    if (ctx.hasUI) {
      turnLog.initialize(ctx.cwd);
      await maybeClearTurnLogOnCleanStart(pi, ctx.cwd);

      footerManager.initialize(pi, ctx.ui, ctx.cwd);
      await recoverOrphanedStashes(pi, ctx);
      await footerManager.refresh();
    }
  } catch {
    // Silently ignore initialization errors
  }
});
```

### 5.3 手動コマンド `/git-clear-turnlog` の追加

`src/index.ts` にコマンド登録を追加。

```typescript
pi.registerCommand("git-clear-turnlog", {
  description: "Clear the accumulated TurnLog manually",
  handler: async (args, ctx) => {
    try {
      if (!ctx.hasUI) return;
      const lang = getLanguage(ctx.cwd);
      const trimmed = args.trim().toLowerCase();

      if (trimmed === "--help") {
        ctx.ui.notify(t(lang, "clearTurnlog.help"), "info");
        return;
      }

      turnLog.clear();
      clearPendingPrompts();
      diagIncr("turnLog_manuallyCleared");
      await footerManager.refresh();
      ctx.ui.notify(t(lang, "clearTurnlog.success"), "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lang = getLanguage(ctx.cwd);
      ctx.ui.notify(t(lang, "clearTurnlog.error", { error: msg }), "error");
    }
  },
});
```

### 5.4 `src/utils/diagnostics.ts` の変更

```typescript
export interface DiagSnapshot {
  // ... existing counters ...

  /** TurnLog was automatically cleared because working tree was clean on session_start */
  turnLog_autoClearedOnCleanStart: number;
  /** TurnLog was manually cleared via /git-clear-turnlog */
  turnLog_manuallyCleared: number;
}

const counters: DiagSnapshot = {
  // ... existing counters ...
  turnLog_autoClearedOnCleanStart: 0,
  turnLog_manuallyCleared: 0,
};
```

### 5.5 `src/commands/diagnostics.ts` の変更

新カウンターを `/git-diagnostics` 出力に追加。

```typescript
"── TurnLog management ──",
`  auto-cleared on clean start: ${s.turnLog_autoClearedOnCleanStart}`,
`  manually cleared:            ${s.turnLog_manuallyCleared}`,
```

### 5.6 `src/i18n/messages.ts` の変更

新メッセージキーを en/ja に追加。

```typescript
// en
"clearTurnlog.success": "TurnLog cleared.",
"clearTurnlog.error": "[pi-git] /git-clear-turnlog error: {error}",
"clearTurnlog.help":
  "/git-clear-turnlog [--help]\n\nClear the accumulated TurnLog manually.\n\nThis removes all conversation context used by /git-agg-commit.",

// ja
"clearTurnlog.success": "TurnLog をクリアしました。",
"clearTurnlog.error": "[pi-git] /git-clear-turnlog エラー: {error}",
"clearTurnlog.help":
  "/git-clear-turnlog [--help]\n\n蓄積された TurnLog を手動でクリアします。\n\nこれにより /git-agg-commit で使用される会話コンテキストが削除されます。",
```

### 5.7 `docs/accumulate-mode.md` の変更

「TurnLog の蓄積」セクションに以下を追記。

- working tree がクリーンな状態で Pi を起動すると、古い TurnLog は自動的にクリアされる
- `/git-clear-turnlog` で手動クリアも可能
- `/git-clear-turnlog --help` でヘルプを表示

---

## 6. テスト計画

### 6.1 `src/core/turn-log-cleaner.test.ts`（新規）

`maybeClearTurnLogOnCleanStart()` のユニットテスト。

```typescript
describe("maybeClearTurnLogOnCleanStart", () => {
  it("clears TurnLog when working tree is clean", async () => {
    const pi = makeMockPi({ status: "" }); // clean
    const log = new TurnLog();
    log.append(makeEvent("turn 1"), ["a.ts"]);

    await maybeClearTurnLogOnCleanStart(pi, "/repo", log);

    assert.equal(log.turnCount, 0);
    assert.equal(diagSnapshot().turnLog_autoClearedOnCleanStart, 1);
  });

  it("keeps TurnLog when working tree has changes", async () => {
    const pi = makeMockPi({ status: " M a.ts\n" }); // dirty
    const log = new TurnLog();
    log.append(makeEvent("turn 1"), ["a.ts"]);

    await maybeClearTurnLogOnCleanStart(pi, "/repo", log);

    assert.equal(log.turnCount, 1);
    assert.equal(diagSnapshot().turnLog_autoClearedOnCleanStart, 0);
  });

  it("does nothing when TurnLog is already empty", async () => {
    const pi = makeMockPi({ status: "" });
    const log = new TurnLog();

    await maybeClearTurnLogOnCleanStart(pi, "/repo", log);

    assert.equal(log.turnCount, 0);
    assert.equal(diagSnapshot().turnLog_autoClearedOnCleanStart, 0);
  });

  it("does not clear when hasChanges throws", async () => {
    const pi = makeMockPi({ status: "throw" });
    const log = new TurnLog();
    log.append(makeEvent("turn 1"), ["a.ts"]);

    await maybeClearTurnLogOnCleanStart(pi, "/repo", log);

    assert.equal(log.turnCount, 1);
    assert.equal(diagSnapshot().turnLog_autoClearedOnCleanStart, 0);
  });
});
```

### 6.2 `src/index.test.ts`（新規、最小限）

`session_start` ハンドラが `maybeClearTurnLogOnCleanStart()` を呼ぶことを検証。

```typescript
describe("session_start", () => {
  it("initializes TurnLog and calls maybeClearTurnLogOnCleanStart", async () => {
    // mock ExtensionAPI, mock ctx, verify turnLog.initialize + clear helper called
  });
});
```

### 6.3 手動コマンドのテスト

`/git-clear-turnlog` ハンドラを直接テストするか、E2E で検証。

```typescript
describe("/git-clear-turnlog", () => {
  it("clears TurnLog and pending prompts", async () => {
    // setup TurnLog with entries
    // call handler with args=""
    // verify turnCount === 0, counter incremented, notify called
  });

  it("shows help for --help", async () => {
    // call handler with args="--help"
    // verify help message shown, TurnLog not cleared
  });

  it("shows i18n error on failure", async () => {
    // mock turnLog.clear to throw
    // verify error message is i18n formatted
  });
});
```

### 6.4 統合テスト

- クリーンな git リポジトリで Pi セッションを起動し、Footer のターン数が 0 になること
- `/git-clear-turnlog` 実行後、`/git-agg-commit` が "No changes to commit" を返すこと

---

## 7. 実装手順

1. `src/utils/diagnostics.ts` にカウンター追加
2. `src/commands/diagnostics.ts` に表示追加
3. `src/i18n/messages.ts` にメッセージ追加
4. `src/core/turn-log-cleaner.ts` を新規作成
5. `src/index.ts` に自動クリア呼び出しと `/git-clear-turnlog` コマンド追加
6. `src/core/turn-log-cleaner.test.ts` を新規作成
7. `docs/accumulate-mode.md` 更新
8. `npm run build` / `npm test` 実行

---

## 8. リスクと考慮事項

| リスク | 対策 |
|---|---|
| ユーザーが明示的にコンテキストを保持したい場合 | working tree がクリーンでない場合はクリアしないため、未コミット作業中の再起動ではコンテキストは維持される |
| orphan recovery との競合 | orphan recovery より先に判定 |
| `hasChanges()` が失敗する | try/catch で囲み、失敗時はクリアしない（安全側に倒す） |
| 並行セッションで他のセッションのコンテキストが消える | 既存の TurnLog は単一ファイル共有であり、本質的な制約。ドキュメントに記載 |

---

## 9. 関連ファイル

- `src/core/turn-log-cleaner.ts`（新規）
- `src/index.ts`
- `src/core/git.ts`（`hasChanges` の利用）
- `src/core/turn-log.ts`
- `src/utils/diagnostics.ts`
- `src/commands/diagnostics.ts`
- `src/i18n/messages.ts`
- `docs/accumulate-mode.md`
