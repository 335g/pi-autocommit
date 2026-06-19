# Phase 0 調査レポート: pi-coding-agent イベント構造

## 調査目的

`agent_end` イベントに `systemPrompt` / `rawUserPrompt` フィールドが含まれているか、ない場合はどのイベントから取得できるかを確認する。

## 調査対象

- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`

## 調査結果

### 1. `agent_end` イベントの構造

拡張機能に公開される `AgentEndEvent` は以下の通り。

```typescript
// src/core/extensions/types.d.ts
export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
}
```

`systemPrompt` / `rawUserPrompt` は **含まれていない**。

`AgentSession` 内部では `willRetry` 情報を含む形で管理されているが、`_emitExtensionEvent()` で拡張機能に配信される際は `messages` のみが公開される。

```typescript
// src/core/agent-session.js _emitExtensionEvent
else if (event.type === "agent_end") {
  await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
}
```

### 2. `before_agent_start` イベントの構造

拡張機能に公開される `BeforeAgentStartEvent` は以下の通り。

```typescript
// src/core/extensions/types.d.ts
export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  /** The raw user prompt text (after expansion). */
  prompt: string;
  /** Images attached to the user prompt, if any. */
  images?: ImageContent[];
  /** The fully assembled system prompt string. */
  systemPrompt: string;
  /** Structured options used to build the system prompt. */
  systemPromptOptions: BuildSystemPromptOptions;
}
```

`prompt` は「プロンプトテンプレート展開後の生のユーザープロンプト」、`systemPrompt` は「完全に組み立てられたシステムプロンプト」である。

### 3. `ExtensionContext` からの取得

`ExtensionContext` には `getSystemPrompt(): string` メソッドがあり、現在の有効な system prompt を取得できる。ただし、これは `before_agent_start` 時点の `currentSystemPrompt` を返す実装になっており、他の拡張機能による変更が反映される可能性がある。

## 結論

`agent_end` イベントから直接プロンプトを取得することはできない。代わりに **`before_agent_start` イベントで `prompt` と `systemPrompt` を取得し、次の `agent_end` まで保持して紐付ける** 必要がある。

## 推奨実装方針

### イベントハンドラの追加

`src/index.ts` に `before_agent_start` ハンドラを追加し、プロンプトを FIFO キューに保存する。

```typescript
const pendingPrompts: Array<{ prompt: string; systemPrompt: string }> = [];

pi.on("before_agent_start", (event) => {
  pendingPrompts.push({
    prompt: event.prompt,
    systemPrompt: event.systemPrompt,
  });
});

pi.on("agent_end", (event, ctx) => {
  const prompts = pendingPrompts.shift();
  // ... 既存の changedFiles 取得処理 ...
  turnLog.append(
    event as AgentEndEvent,
    changedFiles,
    prompts?.systemPrompt,
    prompts?.prompt,
  );
});
```

### 考慮事項

1. **FIFO キューの安全性**
   - 通常のフローでは `before_agent_start` → `agent_end` の順で 1:1 に対応する
   - リトライや `willRetry` 内部イベントは拡張機能には公開されないため、基本的に 1:1 が保たれる
   - 万が一 `agent_end` 時にキューが空の場合は `undefined` を渡し、`TurnLog.append` 内で `messages` からのフォールバックを使用する

2. **プロンプトテンプレート展開後の値**
   - `before_agent_start.prompt` はテンプレート展開後の値
   - これは意図分析にとって有利（ユーザーが実際に AI に送信された内容に近い）

3. **system prompt の正確性**
   - `event.systemPrompt` は拡張機能による変更前の値
   - 正確な最終 system prompt が必要な場合は、`ctx.getSystemPrompt()` を `before_agent_start` ハンドラ内で呼び出すことも可能
   - ただし、複数拡張機能の変更順序に依存するため、確実ではない
   - pi-git 単独の用途では `event.systemPrompt` で十分

4. **型定義の更新**
   - `src/types.ts` の `AgentEndEvent` 拡張は維持（オプショナルフィールドとして）
   - ただし、実際には `agent_end` イベントにはこれらが含まれないため、値は `before_agent_start` から注入する

## 実装プランへの影響

- Phase 1 で `src/index.ts` に `before_agent_start` ハンドラを追加する必要がある
- `TurnLog.append()` のシグネチャはそのまま維持可能
- フォールバック処理として、`event.systemPrompt` / `event.rawUserPrompt` が存在しない場合は `messages` から最新 user メッセージを `rawUserPrompt` として使用する
