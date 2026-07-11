我已经详细查阅了所有代码。接下来我将依次展示 3 种截然不同的 interface 设计。

---

## 设计 1 ── 最小化 interface（最大化 leverage per entry point）

### 约束
入口点最少化（1～3 个）。削减不必要的 helper export。每个入口点最大化 leverage。

### Interface

```ts
// src/commit-prompt.ts

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiAutocommitConfig } from "./config.js";

// ── Port ── pi-ai 互換の complete 関数。fake も同じ型で満たせる
export type CommitCompleteFn = (
  model: Model<Api>,
  opts: {
    systemPrompt: string;
    messages: { role: "user"; content: string; timestamp: number }[];
  },
) => Promise<{ content: Array<{ type: "string"; text?: string }> }>;

// ── 再利用される commit group 型（organizer から移動）
export interface CommitGroup {
  message: string;
  files: string[];
}

// ── Entry point 1: 単発メッセージ（ヒューリスティック fallback 内包）
export async function completeSingleMessage(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  content: string,
  complete?: CommitCompleteFn,
): Promise<string>;

// ── Entry point 2: グループ推論（推論失敗時 throw）
export async function completeCommitGroups(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  content: string,
  complete?: CommitCompleteFn,
): Promise<CommitGroup[]>;
```

**不变量**:
- `completeSingleMessage` 必定返回 1 个字符串。LLM 不可时为启发式 fallback。
- `completeCommitGroups` 在内容为空或无法解析时 throw。无启发式。
- `complete` 省略时动态 import `completeSimple`。
- core 中不 import pi-coding-agent 类型（`ExtensionContext` 除外）。

**不导出 helper**。caller 负责构建 `content` 字符串。

### Usage ── 两个 caller

```ts
// turn_end (checkpoint) — pipeline.ts
const content = buildCheckpointContent(diff);  // caller 側で組み立て
const message = await completeSingleMessage(ctx, config, content);
// → wip(checkpoint): ... として commit

// agent_end (reorganiser) — commit-organizer.ts
const reasoning = extractAssistantContext(event.messages);  // caller 側に残る
const content = `--- Agent reasoning ---\n${reasoning}\n\n--- Staged changes ---\n${diff}\n`;
const groups = await completeCommitGroups(ctx, config, content);
// → groups を stage + commit
// fallback: catch → completeSingleMessage(ctx, config, singleContent) で1巡
```

### 实现隐藏在 seam 背后的内容

- 语言切换规则（`subjectLangInstruction` / `bodyLangInstruction`）── single/groups 共通
- `COMMIT_TYPES` 读取行 ── 共通
- `hasScopeMapping(config)` 的 subject-format 行 ── 共通
- systemPrompt 组装（single 用 / groups 用）── internal seam
- `completeSimple` 的动态 import + 文本提取 ── 共通
- `cleanupResponse`（markdown fence strip 等）── single 专用
- `parseCommitGroups`（organizer 移动）── groups 专用
- scope 注入（`injectScopeIntoMessage` 委托）── 两个路径
- 启发式 fallback（`generateCommitMessage` + `formatFullMessage` 委托）── single 专用
- `resolveModel`（从 `llm-commit.ts` 调用）

### 依赖策略与适配器

- **LLM adapter** ── 通过 port `CommitCompleteFn` 在 interface 上 optional injection。生产环境为动态 import `completeSimple`，测试环境为 fake。
- **scope-resolver** ── 通过内部调用（local-substitutable，纯函数）
- **commit-message heuristic** ── 通过内部调用（local-substitutable，纯函数）
- **commit-types / git-parser** ── in-process，内部调用

### 权衡

**leverage 高**:
- 入口点仅 2 个。各方法返回值简单（`string` / `CommitGroup[]`），caller 无需 narrow。
- 启发式 fallback 是 `completeSingleMessage` 的实现详情 ── caller 只需了解一个事实：“必定返回消息”。
- 重组器的隐式双重 LLM 往返，通过 `completeSingleMessage` 的 1 次调用自然消失。

**leverage 薄（薄弱处）**:
- **内容构建惯例的 drift 风险**。`content` 字符串的结构（`--- Staged changes ---` 块、`--- Agent reasoning ---` 块）在 caller 侧构建，因此两个 caller 可能会偏离相同格式。本次深化的目的是“规则集中在 1 处”，但内容组装被排除在外。
- `extractAssistantContext` 留在了 organizer 侧（对 pi-coding-agent 的依赖不进入 core，但推导提取的惯例无法集中）。

---

## 设计 2 ── 最大化灵活性（支持多种用例和扩展）

### 约束
最大化灵活性。暴露 port 的 factory 构建、可组合的 prompt 组件、解析器/清理。

### Interface

```ts
// src/commit-prompt.ts

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiAutocommitConfig } from "./config.js";

// ── Port ──
export type CommitCompleteFn = (
  model: Model<Api>,
  opts: {
    systemPrompt: string;
    messages: { role: "user"; content: string; timestamp: number }[];
  },
) => Promise<{ content: Array<{ type: "string"; text?: string }> }>;

// ── Factory ── adapter を構築時に注入
export interface CommitPromptDeps {
  complete: CommitCompleteFn;
  resolveModel: (ctx: ExtensionContext, config: PiAutocommitConfig) => Model<Api> | undefined;
}

export function createCommitPrompt(deps: CommitPromptDeps): CommitPromptModule;

export interface CommitPromptModule {
  completeSingleMessage(
    ctx: ExtensionContext,
    config: PiAutocommitConfig,
    content: string,
  ): Promise<string>;

  completeCommitGroups(
    ctx: ExtensionContext,
    config: PiAutocommitConfig,
    content: string,
  ): Promise<CommitGroup[]>;
}

// ── Composable parts ── caller が個別に組み立て・拡張可能
export function buildSingleSystemPrompt(config: PiAutocommitConfig): string;
export function buildGroupsSystemPrompt(config: PiAutocommitConfig): string;
export function buildSingleUserContent(diff: string): string;
export function buildGroupsUserContent(diff: string, reasoning: string): string;
export function extractAssistantContext(
  messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>,
): string;
export function cleanupResponse(raw: string): string;
export function parseCommitGroups(text: string): CommitGroup[];
export function injectScope(
  message: string,
  paths: string[],
  config: PiAutocommitConfig,
): string;

export interface CommitGroup {
  message: string;
  files: string[];
}
```

**不变量**:
- `createCommitPrompt` 接收 adapter 和 `resolveModel`，返回 `CommitPromptModule`。不调用 adapter 调用时的 param。
- `completeSingleMessage` 必定返回字符串。启发式 fallback 通过 `deps` 的 `resolveModel` 返回 `undefined` 时触发。
- `completeCommitGroups` 在内容为空或无法解析时 throw。
- 可组合部件全部为纯函数，可单独测试。

### Usage ── 两个 caller

```ts
// turn_end (checkpoint) — pipeline.ts
const prompt = createCommitPrompt({
  complete: await import("@earendil-works/pi-ai/compat").then(m => m.completeSimple),
  resolveModel,
});
const content = prompt.buildSingleUserContent(diff);  // ← helper 経由
const message = await prompt.completeSingleMessage(ctx, config, content);

// agent_end (reorganiser) — commit-organizer.ts
const reasoning = extractAssistantContext(event.messages);
const content = buildGroupsUserContent(diff, reasoning);  // ← helper 直接
const groups = await prompt.completeCommitGroups(ctx, config, content);
// fallback: catch → content = buildSingleUserContent(diff)
//           message = await prompt.completeSingleMessage(ctx, config, content)

// テスト:
const fakeComplete: CommitCompleteFn = async (model, opts) => ({
  content: [{ type: "text", text: "feat: stub change" }],
});
const prompt = createCommitPrompt({ complete: fakeComplete, resolveModel: () => stubModel });
const message = await prompt.completeSingleMessage(ctx, config, content);
assert.strictEqual(message, "feat: stub change");
```

### 实现隐藏在 seam 背后的内容

- `createCommitPrompt` 内部持有 `deps.complete` 和 `deps.resolveModel`
- `completeSingleMessage` / `completeCommitGroups` 内部: systemPrompt 组装 → `deps.complete` 呼叫 → 文本提取 → cleanup / parse → scope 注入 → 启发式 fallback
- 可组合部件虽然是实现详情，但也可以作为 interface 用于单独测试或自定义扩展

### 依赖策略与适配器

- **LLM adapter** ── 通过 `createCommitPrompt` 在构建时注入。port 在 factory 的 seam 上。每次调用时不会出现 adapter param。
- **resolveModel** ── 依赖注入。生产环境使用 `llm-commit.ts` 的 `resolveModel`，测试环境使用 fake。
- **scope-resolver / commit-message / commit-types / git-parser** ── internal

### 权衡

**leverage 高**:
- factory 构建时 adapter 注入 = 每次调用的 interface 很干净（没有 optional param）。
- 可组合部件可以单独测试，也可以用于自定义扩展。
- `resolveModel` 也可注入 = 测试时不需要 model registry。

**leverage 薄（薄弱处）**:
- **interface 过宽**。export 了 8 个可组合部件 + factory + module interface = 10+ entry points。每个部件都是浅层 pass-through。删除测试: 即使删除 `buildSingleSystemPrompt`，复杂性也只是移动到 caller。不满足深层模块的条件。
- factory 构建是无状态模块的过度仪式。调用方必须持有 `prompt` 变量并传递它。
- 可组合部件的 export 在提供灵活性的同时，降低了 locality（组装惯例可以自由改写）。

---

## 设计 3 ── 优化最常见的 caller（默认用例 trivial 化）

### 约束
让最常见的 caller（checkpoint at turn_end）变得极其简单。模块拥有内容构建。caller 传递原始素材。

### Interface

```ts
// src/commit-prompt.ts

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiAutocommitConfig } from "./config.js";

// ── Port ──
export type CommitCompleteFn = (
  model: Model<Api>,
  opts: {
    systemPrompt: string;
    messages: { role: "user"; content: string; timestamp: number }[];
  },
) => Promise<{ content: Array<{ type: "string"; text?: string }> }>;

export interface CommitGroup {
  message: string;
  files: string[];
}

// ── Entry point 1: checkpoint（最頻 caller）──
//    raw 材料（diff + nameStatus）を渡すだけ。content 組み立ては module 内部。
export async function generateCheckpointMessage(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  diff: string,
  nameStatus: string,
  complete?: CommitCompleteFn,
): Promise<string>;

// ── Entry point 2: reorganiser ──
//    diff + reasoning 文字列を渡す。extractAssistantContext は organizer 側に残る。
export async function generateReorganisedCommits(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  diff: string,
  reasoning: string,
  complete?: CommitCompleteFn,
): Promise<CommitGroup[]>;
```

**不变量**:
- `generateCheckpointMessage` 必定返回字符串。LLM 不可时为启发式 fallback。
- `generateReorganisedCommits` 在内容为空或无法解析时 throw。
- `complete` 省略时动态 import `completeSimple`。
- core 不 import pi-coding-agent 类型。
- **不导出 helper**。content 构建是模块的私有实现。

### Usage ── 两个 caller

```ts
// turn_end (checkpoint) — pipeline.ts
const message = await generateCheckpointMessage(
  ctx, config,
  diff,            // git.getStagedDiff()
  nameStatus,      // git.getStagedNameStatus()
);
// → wip(checkpoint): ... として commit

// agent_end (reorganiser) — commit-organizer.ts
const reasoning = extractAssistantContext(event.messages);  // ← organizer に残る
const groups = await generateReorganisedCommits(
  ctx, config,
  diff,            // git.getStagedDiff()
  reasoning,
);
// fallback: catch → message = await generateCheckpointMessage(ctx, config, diff, nameStatus)
```

### 实现隐藏在 seam 背后的内容

- 内容构建（`--- Staged changes ---` 块、`--- Agent reasoning ---` 块）── 模块私有
- 语言切换规则、`COMMIT_TYPES` 读取、`hasScopeMapping` 行 ── 共通，私有
- systemPrompt 组装（single 用 / groups 用）── internal seam
- `completeSimple` 动态 import + 文本提取 ── 共通
- `cleanupResponse` / `parseCommitGroups` ── 各私有
- scope 注入 ── 两个路径，内部
- 启发式 fallback ── `generateCheckpointMessage` 专用
- `resolveModel` ── 调用

### 依赖策略与适配器

- **LLM adapter** ── 通过 port `CommitCompleteFn` 在 interface 上 optional injection
- **scope-resolver / commit-message / commit-types / git-parser** ── internal
- `extractAssistantContext` ── 保留在 organizer 侧（不进入 core，不需要 pi-coding-agent 依赖）

### 权衡

**leverage 高**:
- 最常见的 caller（checkpoint）仅需提供 `diff` + `nameStatus` ── 无需了解内容构建惯例 = “只需提供原始素材，即可获得 commit 消息”。
- 内容构建惯例的 drift 完全消失 ── 模块拥有，私有。
- 不需要导出 helper ── 接口保持为 2 个入口点。
- 启发式 fallback 是实现详情。重组器的双重往返消失。

**leverage 薄（薄弱处）**:
- 参数比设计 1/2 多（4～5 个 vs 3 个）。但是，caller 只需准备 diff 和 nameStatus，这在准备难度上低于构建 content 字符串。
- `extractAssistantContext` 留在 organizer 侧 ── 推导提取的惯例不会集中在一个地方。但是，这是一处且很小，drift 风险低。
- 方法名稍长（`generateCheckpointMessage` / `generateReorganisedCommits`） ── 但是，它直接表达了 domain term（CONTEXT.md 的“Checkpoint commit”、“Commit reorganiser”），直观易懂。

---

## 3 个设计的比较

| 维度 | 设计 1（最小化） | 设计 2（最大化灵活性） | 设计 3（优化最常见的 caller） |
|---|---|---|---|
| **入口点数** | 2 | 10+（factory + module + 8 helpers） | 2 |
| **内容构建** | caller（drift 风险） | 可组合部件（drift 可避免，但 interface 过宽） | 模块私有（drift 消失） |
| **adapter 供应** | 每次调用 optional | 构建时注入 | 每次调用 optional |
| **参数数** | 3（ctx, config, content） | 3（ctx, config, content）但需要 factory 构建 | 4-5（ctx, config, diff, nameStatus/reasoning） |
| **helper export** | 无 | 8 个纯函数 | 无 |
| **深度** | 深（2 个方法，大量实现） | 浅（helper 为 pass-through，不满足删除测试） | 最深（2 个方法，内容构建也为私有） |
| **locality** | 中（内容构建 drift） | 低（组装惯例可自由改写） | 高（全惯例为模块私有） |
| **seam 中立性** | 高（无 pi-coding-agent 依赖） | 最高（resolveModel 也可注入） | 高（reasoning 为字符串接收） |
| **leverage** | 中 | 低（interface 过宽） | 高（最常见的 caller 最简单） |

## 我的推荐

**设计 3 最强**。理由:

1. **深度最深**。内容构建惯例也是模块私有的 = “只需提供原始素材，即可获得 commit 消息 / commit 组”。删除测试: 即使删除模块，内容构建、prompt 组装、adapter 呼叫、提取、清理、scope 注入、启发式 ── 所有复杂性都会在 N 个 caller 中重新出现。集中复杂性。

2. **最常见的 caller 最简单**。checkpoint（turn_end）只需准备 diff 和 nameStatus。不需要了解 content 字符串的结构。设计 1 要求 caller 构建 content 字符串 = 需要了解 `--- Staged changes ---` 块的惯例，leverage 流失。

3. **不需要导出 helper**。设计 2 为了避免 drift 导出了 8 个 helper，但每个都是浅层 pass-through，interface 过宽。设计 3 将内容构建放入模块私有，从而消除了 drift 且没有增加 interface。

4. **权衡很小**。参数数多 1～2 个，但 caller 只需准备 diff + nameStatus，比构建 content 字符串更简单。`extractAssistantContext` 留在 organizer 侧是一个妥协，但它是一处且很小，drift 风险低（与 prompt 规则的双重复制相比）。

5. **方法名直接表达 domain term**。`generateCheckpointMessage` = CONTEXT.md 的“Checkpoint commit”+ 生成。`generateReorganisedCommits` = “Commit reorganiser”+ 生成。符合 AI 的导航性。

**混合的可能性**。设计 3 + 设计 1 的 `CommitGroup` 型 export（已经包含在设计 3 中）。另外，如果将来有第三种调用方式，设计 2 的可组合部件可能会发挥作用 ── 但现在是 YAGNI。

---

设计 3 推进实现可以吗？还是还有其他想探索的地方？