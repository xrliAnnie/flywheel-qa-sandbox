# FLY-1236 Codex goal objective 超 4000 上限 — 实施计划

Issue: FLY-1236 (https://linear.app/geoforge3d/issue/FLY-1236/bug-codex-implement-段-goal-objective-超-4000-字符上限-setup-failed-秒阻塞1225)
日期: 2026-07-14
基于: exploration.md, research.md

## 0. 决策(brainstorm gate 已批 — 方案 A;Codex design R1 已纳入)

Lead 批准方案 A,并指出 kick turn 通道比 issue 原文的文件指针更对:正文走 `turn/start`(协议本该走的通道,不受 goal objective 的 4000 上限约束,codex 实际读工作指令处)。TUI 秒死判**同因连带**不另立(验收需亲眼见窗口活着)。**Lead 加码硬要求**:必须钉 thread 重建路径的 re-kick 具名测试(crash→换 execId→新 thread,正文可重建重发,否则"目标在、指令空"静默降智)。

**Codex design review R1 采纳的修订**(全 6 项):objective 改为 **phase-neutral**(Codex 也跑三段式 Design/QA,不能写死"implement+开 PR");去掉"正文在 AGENTS.md / 首条消息"的不准确表述;新增 **client 侧 setGoal 最终边界 fail-closed 守卫** + 常量下沉到 protocol 层;具名测试改为**真·跨 execId 新 thread**;新增 **client wire-hop 测试**锁定最后一跳;objectiveIsOurs 语义澄清;断言收紧(精确分隔符/精确相等/4000-4001 边界)。

## 1. 目标

`Codex implement` 段真实规模 objective 不再撞 4000 → `thread/goal/set` 成功 → run 推进、founder 窗口存活。1225 冒烟检查点 2/3 通过。

## 2. 设计

### 2.1 通道重分配(核心)

| 通道 | 改前 | 改后 |
|------|------|------|
| `/goal` objective(≤4000) | systemLayer + 完整 prompt(超限炸) | **有界 phase-neutral north-star 短指针**(issueId+label 前缀) |
| kick turn `turn/start`(不受 goal 4000 上限约束) | stub「Begin working toward the goal now.」 | **完整正文**(systemLayer + prompt) |
| `AGENTS.md`(vendor 持久契约) | 不动 | 不动 |

### 2.2 phase-neutral objective(采纳 Codex R1-#1)

objective **不得**写死 implement/PR 语义(Codex 也跑 Design=不实现、QA=PR 已存在的阶段;写死会与阶段权威指令冲突、可能诱发二次 PR)。也**不得**声称正文在 AGENTS.md 或"首条消息"(AGENTS.md 是持久 vendor 契约非动态正文;重启后 kick 也未必是首条)。

`buildGoalObjective({ issueId?, label? })` 产出:
> `[<label | issueId | runner task>]` Complete the assigned runner task per the instructions delivered as a user turn in this thread. Follow that task's stated workflow, honor its gates, and take its required handoff/completion route. The persistent runner contract lives in `$CODEX_HOME/AGENTS.md`.

phase-neutral、含任务标识(north-star)、指向"thread 内 user turn 的指令",持久契约与动态正文分述。长度 ~250 字符 + label(label 病态超长走 §2.5 降级)。

### 2.3 "正文可重建重发"如何满足(Lead 加码,无需持久化文件)

`kickText = buildGoalKickText({ systemLayer, prompt: ctx.prompt })` —— **由 ctx 每次 execute() 重建**,不依赖旧 thread 历史。`runGoalToTerminal` 每次迭代都用同一 `input.kickText` 重发 `startTurn`(`codex-daemon-goal-runtime.ts:480-505` → `codex-daemon-client.ts:658-662`,现有逻辑已正确透传,**不改**)。因此:

- **同一 run 内新建/重建 thread**:每次迭代同一 kickText 重发。
- **跨 execute 重派**(crash→新 execId→新 thread):新 execute() 从 ctx 重建 kickText。Blueprint 每次 dispatch 都构造非空 role/task `prompt`(`Blueprint.ts:1073-1086`)并连同 `appendSystemPrompt` 传给 adapter(`Blueprint.ts:1938-1946`)。

**FLY-795 边界(修正 Codex R1-#2)**:FLY-795 resume **不替换** `ctx.prompt` —— 它把 `resumeModeInstructions(...)` 追加进 `appendSystemPrompt`(`run-dispatcher.ts:948-998`,`Blueprint.ts:1451-1490`),阶段 prompt 仍是 `ctx.prompt`。`buildGoalKickText` 合并 `systemLayer(含 appendSystemPrompt)` + `prompt` 两者 → 新 execution 的 kick 同时含 resume 指令与常规任务 prompt。∴ 无持久化仍成立。

### 2.4 objective 稳定性语义(修正 Codex R1-#5)

objective 由 issueId+label 派生,**对单次 execution 确定**,每次 run 内重启都重传同一串 —— 这利于**重试与诊断**。但 `objectiveIsOurs`(`codex-daemon-client.ts:550-564`,`730-739`)是**当前 runGoalToTerminal 这一代的守卫**:goal armed 后接受"省略 objective"或"与本次 `input.objective` 精确相等"。跨 execution 会重新 `setGoal`,故防误判 `goal_replaced` **不依赖**与上次 execution 的历史相等。∴ 不把跨 execution 稳定性当作正确性依赖(label 含可变 issue 标题)。

### 2.5 防御:两层 fail-closed(采纳 Codex R1-#3)

- **① adapter 优雅降级**(有完整 kick + 日志上下文的层):送 runGoal 前 `enforceObjectiveLimit(objective, issueId)`:≤MAX 直通;>MAX(病态超长 label)→ 降级为**固定短 fallback**(issueId 先 code-point-safe 截到 ≤80 码点,再拼固定文案,天然 ≤MAX,**不做 `slice(0,4000)`**,避免劈裂 UTF-16 代理对)+ **loud log**。正文永在 kickText,降级只换"指针文案"。
- **② client 最终边界硬守卫**(采纳 Codex R1-#3/#4 的核心):在 `CodexDaemonClient.setGoal()` 内、发 `thread/goal/set` RPC **之前**,若 `objective.length > GOAL_OBJECTIVE_MAX_CHARS` → 抛 `GoalRunError(..., "setup_failed")`,**本地 fail-closed**、绝不让超限帧到达 daemon(把 -32600 变成清晰的本地错误)。这挡住任何绕过 adapter 守卫的未来调用者/重构。
- **常量归属**:`GOAL_OBJECTIVE_MAX_CHARS = 4000` 定义在 **protocol 层 `codex-daemon-client.ts`**(helper 已 import client 的 GoalRunError,方向正确;若把常量放 helper 再被 client import 会形成反向依赖)。helper/adapter 从 client import;`index.ts` re-export。

## 3. 代码改动(逐文件)

### A. `packages/claude-runner/src/codex-daemon-client.ts`
1. `export const GOAL_OBJECTIVE_MAX_CHARS = 4000;`(附注释:Codex `thread/goal/set` 服务端硬限)。
2. `setGoal()` 内、`this.request("thread/goal/set", …)` 之前加守卫:`if (input.objective.length > GOAL_OBJECTIVE_MAX_CHARS) throw new GoalRunError(...setup_failed)`。**仅此一处逻辑新增**;`runGoalToTerminal` kick 透传等其余逻辑不动。

### B. `packages/claude-runner/src/codex-daemon-adapter-helpers.ts`
1. `import { GOAL_OBJECTIVE_MAX_CHARS } from "./codex-daemon-client.js"`。
2. 新增 `buildGoalKickText({ prompt, systemLayer })`:返回完整正文,与旧 `buildGoalObjective` body **逐字相同** —— `systemLayer + "\n\n---\n\n" + prompt`(**双换行分隔符**),无 systemLayer 时裸 `prompt`。
3. 改造 `buildGoalObjective({ issueId?, label? })` → §2.2 的 phase-neutral 短指针(不再收 prompt/systemLayer)。
4. 新增 `enforceObjectiveLimit(objective, issueId) → { objective, degraded }`:≤MAX 直通 `{degraded:false}`;>MAX → 固定短 fallback(issueId code-point-safe 截 ≤80)`{degraded:true}`。

### C. `packages/claude-runner/src/CodexTmuxAdapter.ts`(~344-349, 478-512)
- `systemLayer` 组装不变。
- `const kickText = buildGoalKickText({ systemLayer, prompt: ctx.prompt });`
- `const built = buildGoalObjective({ issueId: ctx.issueId, label: ctx.label });`
- `const { objective, degraded } = enforceObjectiveLimit(built, ctx.issueId);`
- `if (degraded) this.log("[CodexTmuxAdapter] goal objective exceeded " + GOAL_OBJECTIVE_MAX_CHARS + " chars — degraded to minimal pointer; full instructions ride the kick turn (issue=" + ctx.issueId + ")");`
- `runtime.runGoal({ objective, kickText, ... })` —— 新增 `kickText`。

### D. `packages/claude-runner/src/index.ts`
- 追加导出 `buildGoalKickText`、`enforceObjectiveLimit`(from helpers)、`GOAL_OBJECTIVE_MAX_CHARS`(from client)。

**不碰**:`codex-daemon-goal-runtime.ts`(kickText 逐迭代透传已正确,仅加测试锁定);fail-closed teardown / turn-belt reclaim;claude/kimi/antigravity adapter。

## 4. 测试(TDD:先红后绿)

### 4.1 helper 单测(`codex-daemon-adapter-helpers.test.ts`)
- `buildGoalKickText`:有 systemLayer → **精确等于** `SYS\n\n---\n\nprompt`(双换行);无 systemLayer → 裸 prompt。**含 appendSystemPrompt(resume 指令)+ prompt 两者**(锁 §2.3 FLY-795 合并)。
- `buildGoalObjective`:label 优先 / 无 label 用 issueId / 都无用泛化词;**phase-neutral**(不含 implement/PR 字样);长度 <MAX;**不含**任务 prompt 正文。
- `enforceObjectiveLimit`:≤MAX 直通 not-degraded;**恰 4000 → 直通**;**恰 4001 → 降级** 且返回 ≤MAX + degraded;病态超长 label/issueId → 固定 fallback code-point-safe 且 ≤MAX。

### 4.2 client 单测(`codex-daemon-client.test.ts`)— Codex R1-#3/#4
- **最终边界守卫**:`setGoal` objective >MAX → 抛 `GoalRunError(setup_failed)` 且 **FakeDaemon 收不到 `thread/goal/set` 帧**。
- **wire-hop 锁定**:代表性 kick(>4000 字符)→ 完成 fake goal → 断言 `turn/start` 帧文本**逐字节等于**该 kick,`thread/goal/set` 只收到短 objective(锁 `codex-daemon-client.ts:658-662`,防"instruction-empty"回退到 stub)。

### 4.3 适配器单测(`CodexTmuxAdapter.test.ts`)
- 改写「folds appendSystemPrompt into objective」→「systemLayer+prompt 经 **kickText** 精确投递;objective 为短指针,**不含** prompt 正文与 ponytail/system 动态文本」。
- ponytail 内容出现在 **kickText**(非 objective)。
- **FLY-1236 核心回归**:`ctx.prompt` >4000 → `runGoalInputs[0].objective.length ≤ MAX` **且** `kickText` **精确等于** `buildGoalKickText({systemLayer, prompt})`(非仅 toContain,防截断/重复混过);断言 kick 非空。

### 4.4 Lead 加码的具名测试 — 真·跨 execId 新 thread(Codex R1-#2)
- **`CodexTmuxAdapter.test.ts`**:命名 `FLY-1236: a fresh execution on a brand-new thread (no previousSession, new execId) is kicked with the full reconstructed instructions, never goal-only` —— 跑**两次** execute():execId-A(带 previousSession/persisted thread)与 execId-B(**无** previousSession、无 persisted thread、独立第二 runtime/thread)。断言 execId-B 的 `runGoal` 输入 kick **含完整重建正文**(systemLayer+prompt)、objective 仅短指针。证明:即便旧 thread 历史不在,新 thread 也从 ctx 拿到完整工作指令。
- **`codex-daemon-goal-runtime.test.ts`**:命名 `FLY-1236: same-thread in-run restart re-sends the exact same kick`(改名为 **same-thread**,不再叫"rebuilt")—— 强制一次 daemon 死→重启(同 thread resume),拦截 `runGoalFn` 断言两次迭代收到**逐字相同** kickText。

### 4.4b Codex R2 approved 的三条断言精修(实现时落实)
1. execId-B 测试:显式断言 `runGoalInputs[0].resumeThreadId === undefined`、ready thread 是**独立 B thread**、B 的 kick **精确相等**(防未来 adapter 误复用 A 状态而 fake runtime 忽略坏 resume)。
2. client 守卫边界:objective **恰 4000 ASCII → 发帧**;**恰 4001 → 不发帧且抛 setup_failed**(与 helper 边界镜像,防 `>=`/`>` 回归)。
3. phase-neutral 断言:禁**祈使短语**("implement the change"/"open a PR"),**不**禁裸 token `implement`/`PR`(label 合法可能含之)。

### 4.5 回归保护
- 失败路径(timeout/goal_replaced 传播、teardown/drain、founder-window、turn-belt reclaim)现有测试**不改、保持绿**。运行时循环**无需**为透传 kickText 做生产改动(已正确)。
- 全 `claude-runner` 包测试 + 仓库 lint 绿。

## 5. 验收

- 单测/CI:上述全绿;`pnpm --filter flywheel-claude-runner test` + 仓库 `pnpm lint` 绿。
- **真机(Lead 触发)**:重派 FLY-1225 implement 段 → Codex `thread/goal/set` 成功、cmux 窗口**亲眼可见且存活**、写码推进 = 1225 冒烟检查点 2/3 通过。

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| resume 重发完整正文冗余 | 无害:thread/resume 保留历史,重发重锚 goal;crash 后反而有益。 |
| objective 太泛致 goal 完成检测失准 | 指针含 issueId+label 任务标识 + phase-neutral 完成语义;codex 主要从 kick + AGENTS.md 执行,/goal 是 north-star。 |
| 现有测试断言 objective 含正文 → 需改 | 行为纠正的必要更新(正文迁 kickText),逐条改断言 kickText;失败路径测试不动。 |
| 未来调用者绕过 adapter 守卫 | client `setGoal` 最终边界硬守卫兜底(fail-closed,超限帧不出门)。 |
| founder 窗口秒死是否真自愈 | ~~同因~~ **真机推翻(见 §7)**:goal-set 成功后 TUI 仍秒死,真因=rollout 落盘前开窗的 race,与 objective 正交 → 另立新 issue。 |

## 7. 真机验证结果(scripts/qa-fly-1236-e2e.mjs — 真 codex daemon)

Lead pre-ship 铁律要求单测(mock runGoalFn)之外补真机。结果 **5/6**(证据 `qa/`):

| 断言 | 结果 |
|------|------|
| A0 split-shape | ✅ objective=297≤4000;old-folded=16636(会 -32600);kick=16636 载全文 |
| A1 goal-set 成功 | ✅ 16636 字符真实规模 SOURCE → terminal=complete、168s、**不再 -32600** |
| A2 kick 正文到达 | ✅ agent 提交仅存在于 >4000 kick 的 token → 全文到达 |
| B fail-closed 守卫 | ✅ 16636 objective 直送 setGoal → 本地 setup_failed、无 -32600 到 daemon |
| T teardown | ✅ 无 orphan daemon/socket |
| **A3 founder TUI 活着** | ❌ `codex resume --remote` 秒死 |

**A3 = 独立 race,非 objective 修复所致(brainstorm『同因连带』假设被真机证伪)**。root cause(remain-on-exit 抓原文):`thread/resume failed during TUI bootstrap: no rollout found for thread id ... (code -32600)` —— TUI 在 onThreadReady(thread/start 后、首 turn 前)开窗,thread rollout 尚未落盘,`codex resume --remote` 读不到 rollout 即退。与 4000 objective 正交(goal-set 成功照样死;diff 未碰 TUI 路径)。Lead 拍板 **A**:本 PR 按已证范围走,TUI rollout race **另立新 issue**(bounded wait/retry before openWindow),与本修复攒同一班重启(FLY-398 需两者齐才过 Annie 1225 检查点 2 验收)。详见 `qa/tui-death-rootcause.md`。
