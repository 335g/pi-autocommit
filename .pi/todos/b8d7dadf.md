{
  "id": "b8d7dadf",
  "title": "[Blocker] agent_end ハンドラーの未処理 Promise Rejection を修正",
  "tags": [
    "bug",
    "pi-git"
  ],
  "status": "open",
  "created_at": "2026-06-06T03:45:20.371Z"
}

## 場所
`src/index.ts:47-49`

## 問題
`pi.on("agent_end", ...)` 内で `handleAutoCommit` を `await` しているが `try/catch` がない。
`stageFiles` が `GitError` を投げると未処理の Promise Rejection となり、フレームワークのイベントループを破壊する可能性がある。
同様の問題が `session_start` ハンドラー (line 24) にも存在する。

## 修正案
```typescript
pi.on("agent_end", async (event, ctx) => {
  try { await handleAutoCommit(pi, ctx, event as AgentEndEvent); } catch { /* ignore */ }
});
```
