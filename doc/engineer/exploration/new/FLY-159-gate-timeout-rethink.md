# Exploration: Generic Gate Timeout Model — FLY-159

**Issue**: FLY-159 (Extend brainstorm/plan gate timeout from 1h to 24h — 通用 gate timeout 模型)
**Date**: 2026-05-17
**Status**: Draft — brainstorm closed with Annie (3 questions answered), pending Codex plan

> 触发点：Designer Runner 在 brainstorm gate 上等 Annie 等了 ~12h 才 timeout 退出。Peter（之前的 IC）的 framing 是"把 brainstorm/plan gate timeout 从 1h 改 24h"。本文先校正现状，再固化 Annie 的 scope decision，最后留下 Codex plan 需要回答的实施细节。

---

## 1. Problem statement

### 1.1 Peter 原 framing（部分错）

> "Designer Runner 在 brainstorm gate timeout 后退出。把 brainstorm/plan gate timeout 从 1h 延到 24h。"

Codebase 实证后这条 framing 有 3 处偏差：

| Peter 说 | 实证结果 |
|---|---|
| 默认 1h | **CLI fallback 才是 1h**（`packages/flywheel-comm/src/index.ts:613` `: 3600_000; // default 1 hour`）。生产 Runner 走 Blueprint 注入路径，默认是 **30 min**（`packages/edge-worker/src/Blueprint.ts:503` `cpConfig.timeout_ms ?? 1_800_000`，`packages/config/src/types.ts:131` 同步注释 "Default: 30 min"）。 |
| Designer 超时 12h | 12h 不是任何 default。Designer 项目 `.flywheel/config.yaml` 里 `checkpoints.brainstorm.timeout_ms` 被显式设成 `43_200_000`（12h）。即"项目 yaml 写死覆盖了 default"，不是 fallback 行为。 |
| "brainstorm/plan gate" | **`plan` gate 在代码里不存在**。Blueprint 硬编码只有 3 个 gate：`brainstorm`、`approve_to_ship`、`question`，外加一条 generic `<cpName>` 通配。"plan" 是 `/write-plan` slash command + Codex review 流程的概念，不走 `flywheel-comm gate`。 |

→ 真正要改的不只是"把 1h 改 24h"。是：
1. Blueprint 默认 30min 太短
2. CLI fallback 1h 太短
3. 项目 yaml 可以把它设得比 default 还低（Designer 12h 也不够）
4. 超时后 fail-open 默默继续，相当于"Annie 没审过就跑下去"

### 1.2 真正的痛点

`flywheel-comm gate` 是 **人等机器**变成 **机器等人**的那条线。Annie 是 bottleneck（自己讲过），人等的时间天然是按"天"算的，不是按"分钟"算的。今天默认全部按"分钟"配，每个项目自己改，改不到的就死。

---

## 2. Gate taxonomy — 全是 human-wait

`grep -rE 'cpName ===' packages/edge-worker/src/Blueprint.ts` + `gate <name>` 全搜结果：

| Gate name | 调用方 | 阻塞条件 | 当前 default timeout |
|---|---|---|---|
| `brainstorm` | Runner 写代码前 | 等 Lead 在 chat thread 确认理解 | `cpConfig.timeout_ms ?? 30 min`（Blueprint.ts:503） |
| `approve_to_ship` | Runner PR 创建后 | 等 Lead/Annie 在 chat thread 回 `:cool:` | 同上 |
| `question` | Runner 主动 ask | 等 Lead 在 chat thread 回 |  同上 |
| `<custom cpName>` | 任意 `.flywheel/config.yaml` 启用 | 由 project 自定义 | 同上 |

**全部都是 human-wait**——Runner 起 gate，等的是一个人坐到 Discord 前面手敲一句回复。没有任何一个 gate 是"等系统状态变化"。

Stuck-detect / watchdog 是另一条独立线（不要混进 FLY-159）：

- `packages/teamlead/src/HeartbeatService.ts:247` — 发 `session_stuck` event 给 Bridge → Lead → Annie
- `packages/teamlead/src/__tests__/StuckWatcher.test.ts` — Bridge-side stuck patrol
- `packages/edge-worker/src/Blueprint.ts:658` — Runner 整体 `sessionTimeoutMs ?? 86_400_000`（24h hard safety net，FLY-97）
- `cleanup-tmux` / FLY-92 idle watchdog — 按 stdout 静默判 idle

这条线触发器和 gate timeout 不同，处理动作（kill Runner / 通知 Annie）也不同。Codex plan 不要把两条线合并。

---

## 3. Scope decision（Annie 答的 3 个问题）

### Q1 Timeout 策略 → **24h 一刀切**

所有 gate 默认 timeout 改成 **24h**（`86_400_000ms`），不分 checkpoint 类型。

Rationale（Annie 没明说，但推断）：
- 简单 > 巧妙。brainstorm/approve_to_ship/question 都是等 Annie，Annie 在不在线不取决于 gate 类型
- 跨夜场景成立（Annie 晚上不工作，Runner 早上还在等）
- 短于 24h 都救不了 Designer 这种凌晨起 Runner 的场景

### Q2 超时行为 → **Fail-close + Discord 升级**

CLI/Blueprint default `timeoutBehavior` 改 `fail-close`。超时后：
1. Runner exit non-zero（不继续往下走，不"默默 ship 没审过的代码"）
2. Lead 收到 `session_stuck` 或新事件类型 → Lead 通过 Discord MCP 给 Annie 发 ping："Runner X 在 gate Y 上 timeout 24h，需要决定 retry / kill / approve"

旧的 fail-open 行为只在 `--timeout-behavior fail-open` 显式 opt-in 时保留（向后兼容 `question` 这种"问完一句话不答就算了"的场景）。

### Q3 修哪些位置 → **三处全改 + 加 floor**

| 位置 | 现状 | 改成 |
|---|---|---|
| `packages/flywheel-comm/src/index.ts:613` CLI fallback | `3600_000` (1h) | `86_400_000` (24h) |
| `packages/edge-worker/src/Blueprint.ts:503` Blueprint 注入默认 | `1_800_000` (30 min) | `86_400_000` (24h) |
| `packages/config/src/types.ts:131` `CheckpointConfig.timeout_ms` 注释 | "Default: 30 min" | "Default: 24h" |
| ConfigLoader 校验（**新增**） | 无 floor | 项目 yaml `timeout_ms < FLOOR` 时强制提到 FLOOR + warn log |

Floor 的目的：防 Designer 这种"项目 owner 误把 12h 写成 1h"的 footgun。即使有人 yaml 里写 `timeout_ms: 3600000`，ConfigLoader 强行拉到 floor（候选 4h）+ stderr warn。

---

## 4. Open questions（要 Codex plan 回答）

下面 3 个 Annie 没明说细节，Codex 写 plan 时要决定 + 列 trade-off：

### 4.1 Discord 升级走哪条路？

Annie 说"Lead 给 Annie 发 Discord 通知"。具体两种实现：

**(A) 复用现有 `session_stuck` event**：Runner fail-close exit → Bridge 检测到 exit code → 合成 `session_stuck` event → 已有的 EventFilter (`packages/teamlead/src/bridge/EventFilter.ts:117`) → Lead chat thread。
- 优：零新 event 类型，复用 FLY-83 LeadWatchdog Discord 通路
- 缺：`session_stuck` 语义混了——"agent 卡死"和"agent 因 gate timeout 主动退出"是两件事，Lead/Annie 看到通知不知道哪个

**(B) 新 event type `gate_timed_out`**：Runner exit 时 stage 写 `gate_timed_out`，Bridge 路由到新 EventFilter rule，Lead 收到结构化 payload（checkpoint name、原 message、等了多久）。
- 优：语义干净，Lead/Annie 一眼知道"是 gate 超时不是 crash"，可以专门 prompt"是要 retry 还是 cancel"
- 缺：新 event type 要走全链路（types.ts、EventFilter、teamlead 行动 schema、Lead identity.md 教学）

建议默认 (B)，但 Codex 评估实现成本。

### 4.2 ConfigLoader floor 设多少？

Annie 没明说。候选：

| Floor | Rationale |
|---|---|
| 4h | 跨午饭/会议合理上限。Designer 12h 还是 ≥4h，所以不会被强拉到 4h（4h 是地板，不是顶） |
| 8h | 跨夜半工作日 |
| 24h | 和 default 持平 = 项目根本不能调低 timeout |

24h 最简单但太硬。建议 4h（兜底防误配 + 不夺走项目自定义能力）。

### 4.3 fail-open 历史 caller 怎么处理？

CLI 现在默认 fail-open。改 fail-close 后，旧 caller（如果有人 shell 脚本里 `flywheel-comm gate question ...` 没传 `--timeout-behavior`）会从"超时就 exit 0 继续"变成"超时就 exit 1 死"。

- grep 一下生产里有没有这种 caller（`scripts/` 下、CI workflow 里、Runner skill 里）
- 如果有，Codex plan 里列出来，要么显式 patch 加 `--timeout-behavior fail-open`，要么决定接受行为变化

我快速 grep 过 `scripts/test-deploy.sh:444` + `scripts/test-auto-approve.sh:23` + `.claude/commands/spin.md:213` 都是 `gate approve_to_ship`（这条 Annie 答 fail-close 没问题，因为本来就该等审过才 ship）。Blueprint 注入的 `gate question` 是 Runner system prompt 里嵌的 + cpConfig 控制 timeout_behavior，影响面可控。看上去**没有 silent break 风险**，但 Codex plan 写之前再全量 grep 一次确认。

---

## 5. Codex plan 的 input 清单

写 plan 时要碰这几处：

| 文件 | 改什么 |
|---|---|
| `packages/flywheel-comm/src/index.ts:611-620` | CLI fallback 1h→24h、`timeoutBehavior` default `fail-open`→`fail-close` |
| `packages/flywheel-comm/src/commands/gate.ts:14-27` | 类型不变；考虑暴露 timeout reason 给 caller（payload 给 Bridge event） |
| `packages/edge-worker/src/Blueprint.ts:497-567` | Blueprint default 30min→24h、注入文本里"This command BLOCKS"段同步更新 fail-close 行为 |
| `packages/config/src/types.ts:128-142` | `CheckpointConfig.timeout_ms` 注释 30min→24h、`timeout_behavior` 注释 fail-open→fail-close |
| `packages/config/src/` ConfigLoader（具体文件 Codex 找） | 新增 timeout_ms floor 校验 |
| `packages/teamlead/src/bridge/EventFilter.ts` | 决定 Q4.1 后加新规则 OR 复用 `session_stuck` |
| `packages/teamlead/src/__tests__/` 相关测试 | 新 default + floor 边界 + fail-close 行为单测 |
| 项目侧 `.flywheel/config.yaml`（Designer、GeoForge3D、Flywheel 自己） | 项目 yaml 显式 override 的看是否还需要保留（如果保留 ≥ floor 就行，不强制改） |

---

## 6. Out of scope

- **不动 stuck-detect**：HeartbeatService、StuckWatcher、FLY-92、Blueprint.ts:658 24h safety net 都是另一条线
- **不引入新 gate 类型**（plan/review/implement 等暂时 generic `<cpName>` 已够）
- **不改 chat thread / forum 通知通路**（gate-poller → Lead → Discord 已经在跑，只看 Q4.1 加不加 event type）
- **不改 Designer 项目 yaml**（项目 owner 自己改 12h；FLY-159 只改 Flywheel infra default）

---

## 7. Decision log

- 2026-05-17 Annie ✓ 24h 一刀切（Q1）
- 2026-05-17 Annie ✓ fail-close + Discord 升级（Q2）
- 2026-05-17 Annie ✓ 三处全改 + ConfigLoader 加 floor（Q3）
- Q4.1/Q4.2/Q4.3 留给 Codex plan 决定

---

**Next step**: `/write-plan FLY-159` → Codex design review → `/implement`
