# Exploration: Port Jido Directive Pattern + FSM Strategy — GEO-158

**Issue**: GEO-158 (Port Jido Directive Pattern + FSM Strategy to TypeScript)
**Domain**: Backend / Architecture
**Date**: 2026-03-15
**Depth**: Deep
**Mode**: Technical
**Status**: final

## 0. Product Research

Product research skipped (Technical mode)

## 1. Affected Files and Services

| File/Service | Impact | Notes |
|-------------|--------|-------|
| `packages/core/src/decision-types.ts` | modify | DecisionResult 可能新增 `directives` 字段 |
| `packages/teamlead/src/StateStore.ts` | modify | `upsertSession()` monotonic guard → FSM validation；新增 transition 审计 |
| `packages/teamlead/src/bridge/event-route.ts` | modify | if/else 事件处理 → FSM transition + directive 模式 |
| `packages/teamlead/src/bridge/actions.ts` | modify | `ACTION_SOURCE_STATUS` → FSM 查询；`forceStatus` → FSM validated transition |
| `packages/edge-worker/src/Blueprint.ts` | potentially modify | 副作用链可用 directive 描述（但风险高） |
| `packages/edge-worker/src/decision/DecisionLayer.ts` | minor | 已经基本是纯函数，改动小 |
| `packages/core/src/` | add | 新增 `directive-types.ts`, `WorkflowFSM.ts` |
| `packages/teamlead/src/bridge/types.ts` | minor | BridgeConfig 不变 |

## 2. Architecture Constraints

### 2a. 当前副作用分布（Side Effect Map）

代码中副作用集中在以下位置：

**event-route.ts (最混乱)**：
- `session_started` → `store.upsertSession()` + thread 继承 + `notifyAgent()`
- `session_completed` → status 映射逻辑 + `store.upsertSession()` + `notifyAgent()`
- `session_failed` → `store.upsertSession()` + `notifyAgent()`
- 决策逻辑（status 映射）和副作用（DB 写入 + HTTP 通知）完全交织

**actions.ts (半结构化)**：
- `approveExecution()` → `ApproveHandler.execute()` (git merge 副作用) + `store.upsertSession()`
- `transitionSession()` → `store.forceStatus()` 绕过 monotonic guard
- 已有 `ACTION_SOURCE_STATUS` map（本质是手写的部分 FSM）

**Blueprint.ts (顺序管道)**：
- `run()` → emitStarted → runInner → emitTerminal
- `runInner()` → worktree → git → hydrate → skills → memory → adapter → evidence → decision → memory → cleanup
- 副作用是顺序的，directive 化收益有限

**DecisionLayer.ts (已经接近纯函数)**：
- `decide()` 返回 `DecisionResult`，调用者负责执行副作用
- 唯一的副作用是 `auditLogger.log()`（best-effort）

### 2b. 当前状态机（隐式）

```
States: pending, running, awaiting_review, completed, approved,
        blocked, failed, rejected, deferred, shelved
```

隐式 transitions（从代码中推断）：
```
pending       → running          (session_started)
running       → awaiting_review  (session_completed, needs_review)
running       → approved         (session_completed, auto_approve + already merged)
running       → blocked          (session_completed, route=blocked)
running       → completed        (session_completed, fallback)
running       → failed           (session_failed / orphan reaping)
awaiting_review → approved       (approve action)
awaiting_review → rejected       (reject action)
awaiting_review → deferred       (defer action)
blocked       → deferred         (defer action)
failed        → running          (retry, via forceStatus 绕过 guard)
blocked       → running          (retry, via forceStatus 绕过 guard)
rejected      → running          (retry, via forceStatus 绕过 guard)
*             → shelved          (shelve action, 多个 source status)
```

**问题**：
1. `pending → completed` 跳过 running — 无校验
2. `forceStatus()` 可以绕过所有 guard — 无 transition 审计
3. 没有 `session_transitions` 记录
4. TERMINAL_STATUSES 用 Set + if 判断，不是声明式的

### 2c. GEO-163 冲突风险

**关键发现**：GEO-163 正在将通知系统从 Slack/OpenClaw 迁移到 Discord。这意味着：
- `event-route.ts` 中的 `notifyAgent()` 将被替换
- `hook-payload.ts` 的结构可能改变
- `SlackNotifier`, `SlackInteractionServer` 等将被替换

如果现在为 Slack 通知构建 Directive 系统（`NotifySlackDirective`），GEO-163 完成后需要重建为 `NotifyDiscordDirective`。**这是浪费。**

FSM 不受此影响 — 状态转换逻辑与通知渠道无关。

## 3. External Research

### Industry Practices

**FSM in TypeScript**:
- **XState** (16.7 kB): 功能最全的状态机库，但对 Flywheel 来说过于复杂（actor model, statecharts）
- **TS-FSM** (lightweight): 强类型 FSM，async support，零依赖
- **自建 FSM** (~100 LOC): [Dev.to 文章](https://dev.to/davidkpiano/you-don-t-need-a-library-for-state-machines-k7h) 论证简单 FSM 不需要库
- **Robot** (1.2 kB): 函数式 + 不可变

**推荐**：自建。Flywheel 的 FSM 需求简单（~10 个状态，~20 个 transition），引入库反而增加依赖和学习成本。

**Directive / Command Pattern**:
- 核心思想：决策函数返回 "做什么" 的描述，runtime 单独执行
- TypeScript 中用 discriminated union 实现（`type Directive = A | B | C`）
- 与 fp-ts 的 IO/Task 模式类似，但更轻量

### Jido 源码分析

Jido 的核心模式：
1. `cmd/2` 返回 `{agent, directives}` — agent 是新状态，directives 是副作用描述
2. FSM Strategy 用 transitions map 校验状态变更
3. `RunInstruction` directive — 执行结果路由回 `cmd/2`（递归模式）

Flywheel 的差异：
- Jido 是 Elixir（OTP supervisor, immutable data, pattern matching）
- Flywheel 是 TypeScript + SQLite（mutable state, imperative style）
- Jido 的 agent 是长生命周期 actor；Flywheel 的 session 是 request-response

## 4. Options Comparison

### Option A: FSM-First (Minimal)

**Core idea**: 只做 FSM，不做 Directive Pattern。定义声明式的 transition map，替代 StateStore 的 monotonic guard + actions.ts 的 ACTION_SOURCE_STATUS。

**改动范围**：
- 新增 `packages/core/src/WorkflowFSM.ts` (~150 LOC)
- 修改 `StateStore.upsertSession()` — 用 FSM validate 替代 monotonic guard
- 修改 `StateStore.forceStatus()` — 改为 FSM-aware (仍可 bypass，但有审计)
- 修改 `actions.ts` — 用 FSM 查询替代 ACTION_SOURCE_STATUS
- 新增 transition 审计（复用 session_events 表，event_type = "transition"）
- 不改 event-route.ts 的通知逻辑
- 不改 Blueprint.ts
- 不改 DecisionLayer

**Pros**：
- 即时价值：捕获非法 transition（如 `pending → completed`）
- 低风险：只改 StateStore + actions，blast radius 小
- 与 GEO-163 完全兼容：FSM 独立于通知渠道
- 单元测试简单：transition map 是纯数据，直接 assert

**Cons**：
- 不解决 event-route.ts 的副作用混杂问题
- 不引入 Directive 的可扩展性
- Issue 的 acceptance criteria 部分未满足

**Effort**: Small (1-2 周)
**Affected files**: `WorkflowFSM.ts` (new), `StateStore.ts`, `actions.ts`, 测试文件

### Option B: FSM + Directive Types (不重构现有代码)

**Core idea**: Option A 全部内容 + 定义 Directive discriminated union + DirectiveExecutor。但只在新代码路径使用（FSM onEnter），不重构现有 event-route.ts / Blueprint.ts。

**改动范围**：
- Option A 全部
- 新增 `packages/core/src/directive-types.ts` (~100 LOC)
- 新增 `packages/teamlead/src/DirectiveExecutor.ts` (~150 LOC)
- FSM `onEnter` 生成 directives → executor drain
- 现有 event-route.ts / Blueprint.ts 不改

**Pros**：
- FSM 的全部好处
- Directive 类型系统就位，后续可渐进采用
- `onEnter` directives 让新状态进入行为声明式
- 现有代码不重构 = 低风险

**Cons**：
- 两套 side-effect 机制并存（旧 if/else + 新 directive）
- 增加抽象层但短期只在 FSM onEnter 使用

**Effort**: Medium (2-3 周)
**Affected files**: Option A 全部 + `directive-types.ts`, `DirectiveExecutor.ts`

### Option C: Full Jido Port (Issue 描述的完整范围)

**Core idea**: Phase 1 + 2 + 3 全做。Directive types + FSM + 全面重构 event-route.ts、Blueprint.ts、DecisionLayer、actions.ts。

**改动范围**：
- 新增 `directive-types.ts`, `WorkflowFSM.ts`, `DirectiveExecutor.ts`
- 重构 `event-route.ts` → transition() + drain() 模式
- 重构 `actions.ts` → transition() + drain() 模式
- DecisionResult 新增 `directives: Directive[]`
- StateStore 用 FSM validate 所有 transition
- Blueprint 副作用链用 directive 描述

**Pros**：
- 最完整的架构升级
- 完全满足 issue acceptance criteria
- 副作用可测试（pure decide() + mock executor）
- 新增副作用只需加 directive type + executor handler

**Cons**：
- **Blast radius 巨大**：改动 6+ 核心文件
- **Blueprint.ts 重构风险高**：600 行核心文件，已被 GEO-157 大改
- 两个月内第二次大规模重构（GEO-157 刚完成）
- 新增抽象层在当前规模下 ROI 不高

**Effort**: Large (4-6 周)
**Affected files**: 几乎所有核心模块

### Recommendation: Option B (FSM + Lightweight Directives)

**理由**：

1. **GEO-163 Wave 1 已合并** (PR #21)。Bridge 已经 platform-agnostic — `notifyAgent()` 发到 OpenClaw，由其决定投递 Slack/Discord。Directive 类型（如 `NotifyDirective`）不会因平台迁移过期。

2. **FSM 是即时价值**。缺少 transition 验证是真正的 bug 来源（`pending → completed` 跳过 `running` 无校验）。

3. **Directive 类型系统就位但不重构现有代码**。定义 types + executor，只在 FSM `onEnter` 使用。event-route.ts / Blueprint.ts 不动，避免在刚重构过的代码上再做大改。

4. **渐进路径**：Option B 完成后，后续可逐步将 event-route.ts 的 if/else 迁移到 directive 模式。

## 5. Clarifying Questions

### Scope

- Q1: 考虑到 GEO-163 正在迁移到 Discord，是否同意先只做 FSM（Option A），Directive Pattern 等 Discord 稳定后再做？

### Data Model

- Q2: FSM transition 审计是写入现有 `session_events` 表（event_type = "transition"），还是新建 `session_transitions` 表？前者简单，后者查询更方便。

### Integration

- Q3: `forceStatus()` 在 FSM 模式下应该怎么处理？选项：(a) 保留但添加审计日志，(b) 移除，所有 transition 都走 FSM（包括 retry 这种"回退"transition），(c) 重命名为 `bypassTransition()` 明确其危险性。

### Testing

- Q4: Issue 提到 "property-based 测试（随机状态序列不产生非法转换）"。是否需要引入 fast-check 之类的 property-based testing 库，还是用手写的 exhaustive transition 测试覆盖？

## 6. User Decisions

### Selected Approach: Option B (FSM + Lightweight Directives)

**决策过程**：
- 初始推荐 Option A（FSM-only），理由是 GEO-163 会让 Directive 类型过期
- 用户指出 GEO-163 代码已基本完成（Wave 1 已合并 PR #21），Bridge 已 platform-agnostic
- 重新评估后，GEO-163 冲突不成立，Option B 成为最佳选择

### Q&A 记录

| 问题 | 答案 | 依据 |
|------|------|------|
| Q1: 方案选择 | **Option B** — FSM + Directive 类型 + 轻量 executor，不重构 event-route.ts / Blueprint.ts | GEO-163 已完成，Directive 类型不会过期 |
| Q2: Transition 审计存储 | **复用 session_events 表** (`event_type = "state_transition"`)，不新建表 | Jido 的做法：追加到现有 thread/event log，不单独建表 |
| Q3: forceStatus() 处理 | **移除 forceStatus()**，所有 transition（包括 retry 回退）走 FSM | Jido 无 bypass 机制；retry 是 `failed → analyzing` 的合法 transition，写入 transitions map 即可 |
| Q4: 测试策略 | **手写 exhaustive 测试**，不引入 fast-check | Jido 用 ~25 个手写 test cases 覆盖，不用 property-based testing |

## 7. Suggested Next Steps

- [ ] 进入 /research 阶段，详细分析 FSM + Directive 实现细节
- [ ] 写 implementation plan
- [ ] 实现
