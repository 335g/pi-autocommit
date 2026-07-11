我已经掌握了整体概况。下面将提交 Agent 3 的设计方案（针对通用调用者优化）。

---

## 提交提示模块接口 — 设计提案 (Agent 3: 针对通用调用者优化)

### 1. 接口入口

```ts
// src/commit-prompt.ts

import type { Api, Model, AssistantMessage, Context } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiAutocommitConfig } from "./config.js";

// ── 端口: LLM 适配器 (ports & adapters — 双适配器证明该接缝是真实的) ──

/** 
 * LLM 完成端口的接口。生产环境适配器延迟导入 `completeSimple`；
 * 测试适配器为实现此接口的内存模拟对象。
 */
export type CompleteFn = (
  model: Model<Api>,
  context: Context,
) => Promise<AssistantMessage>;

// ── 输入类型 ──

/** 
 * 单次提交路径的输入。高频调用者仅需传入
 * git 已经收集的原始字符串。
 */
export interface SingleCommitInput {
  /** `git diff --cached` 输出。发送给 LLM，并用于 fallback 的 subject 上下文。 */
  diff: string;
  /** `git diff --cached --name-status` 输出。用于 scope 注入 (ADR-0003) 和 heuristic fallback 的路径分析。 */
  nameStatus: string;
  /** `git diff --cached --stat` 输出。用于 heuristic fallback。 */
  stat: string;
}

/** 
 * 重组器组的分割路径输入。每个 agent 循环调用一次。
 * reasoning 将从 assistant 消息中提取并传递。
 */
export interface GroupsInput {
  /** `git diff --cached` 输出。 */
  diff: string;
  /** 从 turn 中提取的 assistant reasoning。通过 `extractAssistantContext` 生成。 */
  reasoning: string;
}

// ── 主接口入口点 (2 方法 + 辅助函数) ──

/**
 * 为单个暂存变更集生成一个 Conventional Commits 消息。
 *
 * **高频调用者** (重组器内的检查点 fallback / 单次提交)。
 * 调用者仅需一行代码及原始 git 字符串即可。
 *
 * 不变量:
 * - 始终返回非空字符串 — 绝不会因 LLM 失败而 throw。
 * - LLM 不可用或响应为空时 → 通过 `commit-message.ts` 进行 heuristic fallback。
 * - 启用 scope 映射 (ADR-0003) → LLM 不输出 scope，由确定性的 `injectScopeIntoMessage` 注入。
 * - `complete` 省略时 → 在内部延迟导入 `@earendil-works/pi-ai/compat` 并使用生产环境适配器。
 *
 * 错误模式:
 * - 不会 throw。LLM 错误、空响应、导入失败 → 全部静默回退到 heuristic。
 *
 * 排序约束: 无。调用即完毕，单次操作。
 */
export async function completeSingleMessage(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  input: SingleCommitInput,
  complete?: CompleteFn,
): Promise<string>

/**
 * 将暂存变更集提议分割为逻辑提交组。
 *
 * **低频调用者** (每个 agent 循环调用一次)。
 *
 * 不变量:
 * - 返回 `CommitGroup[]`。绝不会返回 `null` 或 `undefined`。
 * - 组的数量由 LLM 决定 (没有组分解的 heuristic)。
 * - 启用 scope 映射 (ADR-0003) → 每个 group.message 都会注入确定性的 scope。
 * - `complete` 省略时 → 在内部延迟导入生产环境适配器。
 *
 * 错误模式:
 * - LLM 响应无法解析、为空或模型不可用 → **throw** `Error`。
 *   调用者 (重组器) 将 catch 后通过 `completeSingleMessage` 进行 fallback。
 *   → 静默的双重 LLM 往返消失，作为深度的自然结果。
 *
 * 排序约束: 无。
 */
export async function completeCommitGroups(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  input: GroupsInput,
  complete?: CompleteFn,
): Promise<CommitGroup[]>

// ── 辅助函数 (从 core 导出，在调用者侧持有惯用表达) ──

/**
 * 从代理循环消息中提取 assistant reasoning。
 * 使用结构性类型 — **不导入 pi-coding-agent 类型**。
 * `AgentEndEvent["messages"]` 满足此结构性类型，因此无需转换即可通过。
 */
export function extractAssistantContext(
  messages: Array<{
    role: string;
    content: Array<{ type: string; text?: string }>;
  }>,
): string

/**
 * 逻辑提交组 (重组器路径的返回元素)。
 */
export interface CommitGroup {
  /** 完整的 Conventional Commits 消息 (subject + 可选的 body/footer)。 */
  message: string;
  /** 属于该提交的文件。 */
  files: string[];
}
```

### 2. 使用示例

**高频 — 重组器内的单次提交 fallback (1 行)**:

```ts
// src/commit-organizer.ts — fallbackSingleCommit
import { completeSingleMessage } from "./commit-prompt.js";

// 替代:
//   const message = await generateCommitMessageWithLLM(pi, ctx, nameStatus, stat, diff, config);
// 改为:

async function fallbackSingleCommit(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  git: GitOperations,
  events: PipelineEvent[],
): Promise<void> {
  const diff = await git.getStagedDiff();
  const nameStatus = await git.getStagedNameStatus();
  const stat = await git.getStagedStat();

  // ← 高频调用者: 1 行，零装饰
  const message = await completeSingleMessage(ctx, config, { diff, nameStatus, stat });

  const result = await git.commit(message);
  if (result.code !== 0) {
    throw new Error(`Fallback commit failed (code ${result.code}): ${result.stderr.trim()}`);
  }
  events.push({
    type: "fallback",
    message: `Reorganisation fell back to a single commit:\n${message.split("\n")[0]}`,
  });
}
```

**低频 — 重组器组分割 (稍显冗长，但直接)**:

```ts
// src/commit-organizer.ts — proposeCommitGroups
import { completeCommitGroups, extractAssistantContext } from "./commit-prompt.js";

async function proposeCommitGroups(
  ctx: ExtensionContext,
  config: PiAutocommitConfig,
  event: AgentEndEvent,
  git: GitOperations,
): Promise<CommitGroup[]> {
  const diff = await git.getStagedDiff();
  if (!diff) return [];

  // 辅助函数也调用 — 组装惯用语集中在 core
  const reasoning = extractAssistantContext(event.messages);

  return await completeCommitGroups(ctx, config, { diff, reasoning });
}
```

**测试 — Fake 适配器注入**:

```ts
import { completeSingleMessage, type CompleteFn } from "./commit-prompt.js";

const fakeComplete: CompleteFn = async (_model, _ctx) => ({
  role: "assistant",
  content: [{ type: "text", text: "feat: add new thing\n\nBody here." }],
  api: "openai-completions",
  provider: "openai",
  model: "test-model",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
           cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: Date.now(),
});

const msg = await completeSingleMessage(ctx, config, {
  diff: "--- a/x.ts\n+++ b/x.ts\n",
  nameStatus: "M\tx.ts\n",
  stat: "1 file changed\n",
}, fakeComplete);
assert(msg.includes("feat:"));
```

### 3. 接缝背后隐藏的内容

- **面向单次和组的 systemPrompt 组装** — 语言切换规则 (`subjectLangInstruction` / `bodyLangInstruction`)、`COMMIT_TYPES` 参考表、`hasScopeMapping` 主题格式规则。分为两个私有构建器（`buildSingleSystemPrompt`, `buildGroupsSystemPrompt`），它们共享一个私有的规则组装核心。
- **面向单次和组的 userContent 组装** — `--- Staged changes ---` 块格式、`--- Agent reasoning ---` 插入。私有构建器。
- **LLM 适配器延迟导入** — 当省略 `complete` 时，私有 `loadDefaultComplete()` 将执行 `await import("@earendil-works/pi-ai/compat")` 并返回 `completeSimple`。调用者无需感知 import。
- **模型解析** — 内部私有调用 `resolveModel(ctx, config)` (来自 `llm-commit.ts`)。模型不存在 → 单次路径回退到 heuristic，组路径执行 throw。
- **文本提取** — `result.content` 的 `filter·map·join·trim`。私有 `extractText(result)` 在两条路径中共享。
- **响应清理** — Markdown 代码块去除、`Commit message:` 前缀去除、换行压缩。私有 `cleanupResponse(raw)`，仅单次路径使用。
- **组解析** — `=== COMMIT N ===` 块解析。私有 `parseCommitGroups(text)`，仅组路径使用。
- **Scope 注入 (ADR-0003)** — 在两条路径上内部调用 `injectScopeIntoMessage(message, paths, config)`。单次路径: 从 `parseNameStatus(input.nameStatus)` 中提取路径。组路径: 对每个 group 使用 `group.files`。
- **启发式 Fallback** — 私有 `heuristicFallback(input, config)` 内部调用 `commit-message.ts` 的 `generateCommitMessage` + `formatFullMessage`。仅 `completeSingleMessage` 路径使用。组路径没有 heuristic。

### 4. 依赖策略与适配器

| 依赖 | 分类 | 接缝位置 | 适配器 |
|---|---|---|---|
| LLM (`completeSimple`) | **Ports & adapters** | **外部接口** — 将 `CompleteFn` 作为可选的第 4 个参数 | 生产: 内部延迟导入 `@earendil-works/pi-ai/compat`。测试: 内存模拟函数。两个适配器 ⇒ 真实的接缝。 |
| `resolveModel` / `validateModelString` (来自 `llm-commit.ts`) | **In-process** | **内部** — 不在接口中体现 | 模块内部直接调用。`llm-commit.ts` 保留为现有的导出源。 |
| `scope-resolver` (`hasScopeMapping`, `injectScopeIntoMessage`) | **Local-substitutable** (纯函数) | **内部** | 内部直接调用。模拟无需注入。 |
| `commit-message` (`generateCommitMessage`, `formatFullMessage`) | **Local-substitutable** (纯函数) | **内部** | 内部直接调用。仅在 `completeSingleMessage` 的 heuristic fallback 路径中调用。 |
| `commit-types` (`COMMIT_TYPES`) | **In-process** | **内部** | 直接从私有构建器引用。 |
| `git-parser` (`parseNameStatus`) | **In-process** | **内部** | 内部直接调用，用于从 `input.nameStatus` 中提取路径。 |
| `config` (`isJapanese`) | **In-process** | **内部** | 内部直接调用。 |
| pi-coding-agent types (`AgentEndEvent`) | — | **不导入** | `extractAssistantContext` 使用结构性类型。调用者传递 `event.messages`。 |

### 5. 权衡

**杠杆收益高的地方:**

- **高频调用者只需 1 行**。`await completeSingleMessage(ctx, config, { diff, nameStatus, stat })` — 无需了解延迟导入、模型解析、适配器、scope 注入或 heuristic fallback。生产环境适配器是零参数的默认值。调用者无需了解任何 LLM 内部信息即可完成调用。
- **不显式“接受依赖”，而是用零参数默认值**。与 codebase-design “显式接受依赖”原则的平衡：生产环境调用者无需任何动作，测试显式注入 `complete`。省略默认选项使生产代码对快速回归更友好，同时为测试保留了接缝。
- **Scope 注入隐藏**。ADR-0003 的复杂性完全包含在 core 中。无论路径如何，调用者都能获得正确 scope 的结果。
- **双重 LLM 往返消失，作为深度的自然结果**。重组器失败时 → catch → `completeSingleMessage` → 1 次调用(或 heuristic)。不再路径 1 LLM 失败后再次 LLM 调用。
- **行为保持**。单次路径的 heuristic fallback、组路径的 throw、ADR-0003 的 scope 注入、WIP marker 不变。

**杠杆收益薄的地方:**

- **`SingleCommitInput` 是 3 字段对象，而非纯 `content: string`**。比“只需传一个字符串”稍微学习成本要高。但启发式 fallback 需要 `nameStatus`/`stat`，因此仅传 `content` 会削弱接口。这 3 个字段均是调用者从 git 中已获取的原始字符串，因此无需额外工作。
- **为组注入而导出 `extractAssistantContext`**。并非调用者自由组装 content，而是强制由 core 辅助函数生成 reasoning 字符串。由于格式 (`\n\n---\n\n` 连接) 是 core 的惯用表达，因此保持 locality 是正确的，但调用者无法以其他形式传递 reasoning。
- **省略 `complete` 时的延迟导入变为内部实现**。测试时通过显式注入绕过，但生产路径的 import 失败处理变为单次路径静默 fallback / 组路径 throw。这在现有行为（延迟导入失败 → heuristic fallback）中已经存在，因此得到保留，但意味着测试无法通过错误注入模拟导入失败。由于模拟 import 失败的测试本身就不是通过接口进行的，所以没问题。

---