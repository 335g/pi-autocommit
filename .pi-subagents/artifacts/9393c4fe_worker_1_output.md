我已经阅读了所有必需的文件。现在我将设计 commit prompt module 的接口，并提交一份强调“最大化灵活性”的设计方案。

---

## 设计方案 · 代理 2 “最大化灵活性”

### 1. 接口

```ts
import type { Model, Api } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiAutocommitConfig } from "./config.js";
import type { CommitGroup } from "./commit-organizer.js";

// ── Port: LLM adapter（2 adapters ⇒ real seam） ──────────

/** 在 LLM seam 上提供不同实现的函数类型。production 为 dynamic import 的 completeSimple，test 为 fake。 */
export type CompleteFn = (
  model: Model<Api>,
  request: {
    systemPrompt: string;
    messages: { role: "user"; content: string; timestamp: number }[];
  },
) => Promise<{ content: Array<{ type: string; text?: string }> }>;

// ── Prompt variant（内部 seam，可扩展点） ─────────────────

/** 定义“使用 LLM 做什么”的变体。single 和 groups 是预设的2种 default，但 caller 可以自定义。 */
export interface PromptVariant<T> {
  /** system prompt 构筑。根据 config 中的语言和 scope mapping 状态进行条件分支。 */
  readonly buildSystemPrompt: (config: PiAutocommitConfig) => string;
  /** 将 user content 的“骨架”。caller 传入 diff / reasoning / 等原始材料，并进行排版。 */
  readonly buildUserContent: (ctx: {
    diff: string;
    assistantReasoning?: string;
  }) => string;
  /** 从 LLM 原始文本中取出结构化结果的 parser。失败时返回 null（module 侧进行后续处理）。 */
  readonly parse: (rawText: string) => T | null;
  /** 对 parser 成功结果的 scope 注入钩子（根据 ADR-0003）。 */
  readonly injectScope?: (result: T, config: PiAutocommitConfig) => T;
}

// ── 工厂兼主 interface ─────────────────────────────────────

export interface CommitPromptOptions {
  /** LLM adapter port。省略时 module 内 dynamic import completeSimple。test 为 fake。 */
  readonly complete?: CompleteFn;
  /** 进度回调。LLM 调用前等，asynchronous 中间点 fire-and-forget。 */
  readonly onProgress?: (event: PromptProgressEvent) => void;
  /** dry-run 模式：LLM 调用后，在返回结果前停止。仅用于观测。 */
  readonly dryRun?: boolean;
}

export type PromptProgressEvent =
  | { type: "resolving-model" }
  | { type: "calling-llm"; systemPrompt: string }
  | { type: "llm-returned"; text: string }
  | { type: "scope-injected" }
  | { type: "heuristic-fallback" }
  | { type: "parse-failed"; rawText: string };

// ── factory ──

export interface CommitPromptModule {
  /** 使用预设的 single variant。返回1条消息字符串。确保始终不 throw（LLM 不可用则回退到 heuristic）。 */
  completeSingle(opts: {
    ctx: ExtensionContext;
    config: PiAutocommitConfig;
    diff: string;
    nameStatus: string;
    stat: string;
    moduleOpts?: CommitPromptOptions;
  }): Promise<string>;

  /** 使用预设的 groups variant。返回 CommitGroup[]。内容 inference 失败时 throw（回退委托给 caller）。 */
  completeGroups(opts: {
    ctx: ExtensionContext;
    config: PiAutocommitConfig;
    diff: string;
    assistantReasoning: string;
    moduleOpts?: CommitPromptOptions;
  }): Promise<CommitGroup[]>;

  /** 指定自定义 variant 的通用 entry point。variant 不限于 single / groups，可扩展第三个、第四个。 */
  completeWith<T>(variant: PromptVariant<T>, opts: {
    ctx: ExtensionContext;
    config: PiAutocommitConfig;
    diff: string;
    assistantReasoning?: string;
    nameStatus?: string;
    stat?: string;
    moduleOpts?: CommitPromptOptions;
  }): Promise<{ result: T; source: "llm" | "heuristic-fallback" } | { result: null; reason: string }>;
}

/** factory。在 module import 时尽早 resolve port default，在生产环境/测试环境间切换。 */
export function createCommitPrompt(defaults?: Partial<CommitPromptOptions>): CommitPromptModule;
```

**不变量**:
- `completeSingle` 不 throw — 始终返回1条 string。LLM adapter throw / 空响应 / parse null → 在 module 内 catch，回退到 heuristic（`commit-message.ts` 的 `generateCommitMessage` + `formatFullMessage`）。
- `completeGroups` 在 `resolveModel` 返回 `undefined` 时 throw `Error("No model available")`。LLM 响应为空或 `parse` 返回 `null` 时 throw `Error("..." )`。heuristic 没有 groups 版本，因此回退是 caller 的责任（caller 用 `completeSingle` 即可自然吸收单条回退）。
- `completeWith` 是通用扩展点。返回值为 discriminated union：成功时 `{ result, source }`，失败时 `{ result: null, reason }`。heuristic 回退是 `completeSingle` 预设的特别行为，不会发生在 `completeWith` 中（variant 级别的回退由 caller 侧 hook 处理）。
- 顺序：`resolving-model` → `calling-llm` → `llm-returned` → `parse` 成功 → `scope-injected` / `parse-failed`。如果 adapter throw 则 `heuristic-fallback`。
- progress callback 是 fire-and-forget。module 不 await，即使 callback throw 也会 swallow（module 不中断）。production caller 1层 try-catch 拦截。

---

### 2. 使用示例

#### Single call side — checkpoint commit 时（turn_end）

```ts
// src/pipeline.ts（runCheckpointCommit 内部）
import { createCommitPrompt } from "./commit-prompt.js";

const prompt = createCommitPrompt();

const message = await prompt.completeSingle({
  ctx,
  config,
  diff: stagedDiff,
  nameStatus: stagedNameStatus,
  stat: stagedStat,
});

await git.commit(message);
```

#### Reorganiser call side — agent_end

```ts
// src/commit-organizer.ts（proposeCommitGroups 置换）
import { createCommitPrompt } from "./commit-prompt.js";

const prompt = createCommitPrompt();

try {
  const groups = await prompt.completeGroups({
    ctx,
    config,
    diff: stagedDiff,
    assistantReasoning: extractAssistantContext(event.messages),
  });

  // 在 groups 为空时回退 → 1个粗大的 commit
  if (groups.length === 0) {
    throw new Error("No logical groups proposed");
  }
  // ... stage + commit each group ...
} catch {
  // 回退：如果调用 completeSingle，则通过 heuristic 吸收单条消息
  // 同时消除隐式双重 LLM roundtrip
  const message = await prompt.completeSingle({
    ctx, config, diff: stagedDiff, nameStatus, stat,
  });
  await git.commit(message);
}
```

#### 假想的未来 caller — `/autocommit-message` slash command（用户手动干预生成）

```ts
// 用户主导的 dry-run 模式消息生成
import { createCommitPrompt, type PromptVariant } from "./commit-prompt.js";

// 自定义 variant: 比如若允许在 prompt 中使用 emoji 的自定义 caller
const emojiVariant: PromptVariant<string> = {
  buildSystemPrompt: (config) => `${buildSingleSystemPrompt(config)}\n- You MAY use gitmoji emoji prefixes.`,
  buildUserContent: ({ diff }) => `--- Staged changes ---\n${diff}\n\nCommit message:`,
  parse: (raw) => cleanupResponse(raw) || null,
  injectScope: (msg, config) => injectScopeIntoMessage(msg, paths, config),
};

const prompt = createCommitPrompt({ dryRun: true, onProgress: (e) => console.log(e) });

const outcome = await prompt.completeWith(emojiVariant, {
  ctx, config,
  diff: stagedDiff,
  nameStatus, stat,
});

if (outcome.result) {
  // 将完整消息预览给用户，并接受编辑・取消的确认循环
  ctx.ui.notify(`Proposed commit (${outcome.source}):\n${outcome.result}`, "info");
}
```

---

### 3. Implementation 在 seam 背后隐藏的事物

- **语言切换规则的组装**（`subjectLangInstruction` / `bodyLangInstruction` 的 `lang === "ja"` 分支）— common core 内部，通过 `PromptVariant.buildSystemPrompt` 委托，但共用部分模板在 module 侧
- **`COMMIT_TYPES` 读现行**（`Object.entries(COMMIT_TYPES).map(...)`）— common core 内部
- **`hasScopeMapping(config)` 的 subject-format 行**（ADR-0003 的“LLM 不输出 scope”指令）— common core 内部，根据 config 自动切换
- **`completeSimple` 的 dynamic import + text 抽取**（`filter·map·join·trim`）— adapter 呼出部分（port 后方）。production adapter 内部，对 module 不可见
- **`cleanupResponse`**（markdown fence strip 等）— single variant 默认 parse 内部
- **`parseCommitGroups`**（`=== COMMIT N ===` 解析）— groups variant 默认 parse 内部
- **`injectScopeIntoMessage` 呼出**（ADR-0003 的事后决定论注入）— 各 variant 的 `injectScope` hook 经由，但 default hook 使用 module 内部的 `scope-resolver` 委托
- **`resolveModel`**（`validateModelString` 经由）— module 内部。caller 不可见
- **heuristic fallback**（`generateCommitMessage` + `formatFullMessage`）— `completeSingle` 专属隐藏逻辑。仅 groups 侧不拥有
- **`extractAssistantContext`**（`event.messages` 从 assistant reasoning 字符串提取）— helper export として提供, 采用结构类型, pi-coding-agent 非依赖
- **progress event 的 fire-and-forget 呼出** — module 内部, caller 不可见, 不会阻塞

---

### 4. 依赖策略和 adapters

**Port in interface (external seam)**:
- **LLM adapter (`CompleteFn`)** — 跨 ports & adapters seam。production 为 dynamic import 的 `completeSimple` adapter。test 为 in-memory fake adapter。2 adapters ⇒ real seam。可以通过 factory 的 `defaults.complete` 或 call 时的 `moduleOpts.complete` 覆盖。

**Internal seams (在实现内部, 不在 interface 出现)**:
- **`scope-resolver`** — local-substitutable（纯函数）。通过各 variant 的 `injectScope` hook 间接调用。不涉及 test adapter，直接调用。
- **`commit-message` heuristic** — local-substitutable（纯函数）。在 `completeSingle` 内部 LLM 失败时调用。不涉及 interface。
- **`commit-types` ・ `git-parser`** — in-process（纯计算）。内部使用。

**adapter 配置策略**:
- `createCommitPrompt()` 无参数: production default。LLM adapter 为 lazy dynamic import。
- `createCommitPrompt({ complete: fakeComplete })`: test。完全 in-memory。
- 各 `completeX` 调用时的 `moduleOpts.complete` 覆盖: 在用例级别使用不同 adapter 时（例如: 2个 model 对比 dry-run）。

---

### 5. 权衡 (Trade-offs)

**Leverage 高的场所**:
- `completeSingle` / `completeGroups` 的2个预设: 现有2个 caller 立即替换。caller 只需学习“单条返回消息”/“返回组”这两个事实。
- `completeWith` + `PromptVariant<T>`: 假想的第3个 caller（自定义 prompt 变体、emoji、dry-run 预览等）可在不修改 module 的前提下扩展。Future 需求的 leverage 很大。
- progress callback: 异步中间点的 UI 反馈（“生成中...”通知）可在不深入 module 的前提下实现。
- 消除隐式双重 LLM roundtrip: groups fail → `completeSingle` 的1次调用，由此通过 heuristic 吸收。在 caller 侧看不出 depth 的降低。

**Leverage 减少 / interface 变厚的场所**:
- `PromptVariant<T>` 泛型: interface 的 type 复杂度增加。不过，现有2个 caller 仅使用预设，因此 type 推断 完全 0 成本。仅在扩展自定义 variant 时才付出成本。
- `completeWith` 的返回值为 discriminated union（`{ result, source } | { result: null, reason }`）: caller 需要 narrow。button-down 虽多但成本小。
- factory pattern: module state 持有可能（认为 encounter：largely 无状态，但 defaults cache）。无状态 module 中的 factory 有时过于仪式化，但通过 mock-injection 一致性提升。
- progress event type 在 interface 中公开（`PromptProgressEvent`）: caller 可能根据 event type 进行 switch，interface 变厚。不过，省略时为完全 0 成本。

**与最小化方案的比较**:
- 如果仅有2个 method（最小化）: interface 更小，第3个 caller 出现时需修改 module = leverage 减少。
- 本方案（+ variant + factory）: 第3个 caller 出现也 0 module 修改 = 设计扩展性 leverage。代价是 type 复杂度 +1 层（struct → function）。
- 灵活性的成本 vượt 性回报: 这里是判断 分岐点。“不可能出现第3个 caller”预测的情况是 最小化胜。 只要有“可能会出现”的可能性 是本方案胜。