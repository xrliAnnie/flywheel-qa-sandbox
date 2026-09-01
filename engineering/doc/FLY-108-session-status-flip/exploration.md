# FLY-108 Session Status 不 Flip — 探索
Issue: FLY-108 (https://linear.app/geoforge3d/issue/FLY-108/session-status-不-flip-runner-session-completed-两类-bug-geo-362-empty)
日期: 2026-09-01
基于: 无

**Mode**: Technical · **Depth**: Deep · **Status**: final(无人值守节点,审批走 design_review 门)

> **沙箱基线声明(诚实边界)**:本 worktree baseline 已包含 FLY-108 的生产修复
> (`packages/flywheel-comm/src/commands/complete.ts` 头注 "FLY-108"、
> `packages/teamlead/src/bridge/event-route.ts` 的 "FLY-108 Decision 4/6" 标记;
> 仓库 CLAUDE.md 记录 PR #155 已 merge)。本节点是 generalized workflow 沙箱重跑,
> 设计工件以 issue 原始两类 root cause 为题、以本仓真实代码为审计依据,
> 产出 = 该修复的完整、可实施技术设计。已在开工时向 Lead 发非阻塞说明
> (question id `5b416b27`),未收到方向变更指令则按下述推荐方案成稿。

## 1. 问题定义

Runner ship 完成后 Bridge StateStore `sessions.status` 不 flip 到 `completed`,
下游三条链路全部被阻塞:close_runner(409 status_not_eligible)、B3 🏁 完工通知
(Lead 永远不知道 Runner 完工)、post-ship cleanup(tmux 僵尸、chat thread 不
archive)。同一症状家族,两类不同 root cause:

| Variant | 场景 | session_completed 发了吗 | Payload | 卡在 |
| -- | -- | -- | -- | -- |
| **A. GEO-362** | 走完 approve→ship 流程 | ✅ 发了 | ❌ 空(无 decision/route) | `awaiting_review` |
| **B. GEO-363** | Docs-only compressed pipeline | ❌ 从没发 | n/a | `running` |

### Variant A 双层 root cause
1. **Runner 侧**:发 `session_completed` 时 payload 为空字符串(应带 decision.route
   / evidence / landingStatus)。
2. **Bridge 侧 FSM dead-end**:`event-route.ts` 对空 `decision` 走
   `route=undefined → status="completed"` fallback,而 WorkflowFSM
   (`packages/core/src/workflow-fsm.ts`)中 `awaiting_review` 的合法后继原本只有
   `[approved_to_ship, rejected, deferred, shelved, terminated]` — `completed`
   不在列 → `applyTransition` 拒绝 → status 静默保持 `awaiting_review`。
   合法路径是 `running → awaiting_review → approved_to_ship → completed`。

### Variant B 架构缺口
Lead-driven auto-start 的 Runner 是 claude CLI + tmux 自跑流水线,**整条链路没有
任何组件发 `session_completed`**:
- `flywheel-comm stage set <stage>`(`packages/flywheel-comm/src/commands/stage.ts`)
  只发 `event_type: "stage_changed"`,无 complete 子命令(修复前)。
- 唯一生产级发射点 `eventEmitter.emitCompleted()` 在 edge-worker Blueprint 路径
  (`packages/edge-worker/src/ExecutionEventEmitter.ts`),Lead-driven Runner 不走它。
- `event-route.ts` 显式把 `stage_changed` 当 informational only,不触发 FSM。
- B3 🏁 通知链全部 gated on session_completed(`DirectEventSink.emitCompleted` 是
  唯一入口,`isPostApproveShipComplete` 要求 status 已被 session_completed 更新)。

## 2. 受影响文件与服务(审计表)

| 文件/服务 | 影响 | 说明 |
| -- | -- | -- |
| `packages/flywheel-comm/src/commands/complete.ts` | **新增** | Runner-driven `session_completed` 发射器(修复主体) |
| `packages/flywheel-comm/src/commands/stage.ts` | 参照 | 只发 stage_changed;读 `land-status.json`(status/prNumber/mergeCommitSha)作 landingStatus 附件 |
| `packages/teamlead/src/bridge/event-route.ts` | **修改** | session_completed 分支:严格 route guard(Decision 4, :865)+ status 映射(:921)+ CIPHER backfill(Decision 6, :1492);stage_changed 分支:merged fallback(FLY-60 W2)|
| `packages/core/src/workflow-fsm.ts` | **修改** | `awaiting_review` 增加受守卫的 `completed` 边(:146-153,守卫在 call site)|
| `packages/teamlead/src/DirectEventSink.ts` | 对齐 | in-process sister sink;status 映射与 HTTP sink 必须逐字段一致 |
| `packages/teamlead/src/applyTransition.ts` | 不变 | FSM validate 统一入口,拒绝时不 upsert |
| `packages/teamlead/src/StateStore.ts` | 不变 | sessions.status 唯一真相 |
| Runner 协议(prompt 注入) | **修改** | pipeline 终点必须调 `flywheel-comm complete --route <...>` |

## 3. 架构约束(从代码发现)

1. **FSM 语义不可破坏**:`awaiting_review → completed` 直通若无条件放开,等于绕过
   founder approve/ship 语义。任何新边必须带 call-site 守卫(merge 证据)。
2. **双 sink 对齐铁律**:`session_completed` 有两个消费面 —— HTTP `/events`
   (event-route.ts)与 in-process `DirectEventSink.emitCompleted`。status 映射、
   route 语义、finalization 触发条件必须逐字段一致,否则同一事件走不同 sink 得到
   不同终态。
3. **stage_changed 的 informational 契约**:它是展示/巡检信号,不是 FSM 驱动。
   任何 fallback 必须是显式、窄守卫的例外(merged 证据在手),不能把
   stage_changed 整体升格为状态驱动 —— 否则乱序/重放的 stage 事件会打穿 FSM。
4. **Runner 无 Linear SDK / 无 Discord 权限**:payload 拿不到 labels/projectId,
   Bridge 侧需从 StateStore backfill(CIPHER snapshot 契约)。
5. **事件可能丢**:tmux Runner 的 CLI 调用没有持久化队列,发射失败必须 fail-close
   留 marker,由 Bridge 巡检 reconcile(否则 bug 原样复发)。
6. **`pr_head_sha` 绑定**:route=needs_review 的 completion 携带 worktree HEAD,
   verify-approval 据此 fail-close —— completion payload 是审批绑定的证据源之一。

## 4. 外部调研

跳过 WebSearch(纯内部 orchestrator 状态机 bug,无外部技术选型)。适用的通用
工程原则:at-least-once delivery + 幂等消费(事件可重放)、fail-closed 发射
(丢事件 = 复发)、单一真相(FSM 状态只经 applyTransition 变更)。

## 5. 方案比较(issue 四选项 + 组合)

### Option 1 — Runner 侧补 emit(`flywheel-comm complete`)
- **核心**:新增 `complete --route <auto_approve|needs_review|blocked|...> [--pr N] [--merged]`
  子命令,Runner 在 pipeline 终点调用,POST `/events` 带完整 payload。
- **Pro**:修在源头;payload 由 Runner 完整填(evidence/landingStatus/headSha),
  同时修 A(不再空 payload)和 B(事件必然发);payload 与 edge-worker
  `emitCompleted` 字段对齐,老路径零改动。
- **Con**:Runner prompt 改动面大;Runner 忘调/发射失败时 bug 原样复发 →
  必须配 fail-close marker + Bridge 巡检 reconcile。

### Option 2 — Bridge 侧 merged fallback(stage_changed=completed)
- **核心**:stage_changed=completed 且 landingStatus.status="merged"(land-status.json
  随事件到达,不需额外 GitHub API)时,走受守卫的 `awaiting_review→completed`
  FSM 边 + runPostShipFinalization。
- **Pro**:不依赖 Runner 自觉;对 A(事件到了但坏)和 B(事件没到)都兜底。
- **Con**:守卫必须窄(merge 证据在手才转),否则破坏 approve 语义;
  它修不了 payload 质量(evidence 缺失,🏁 通知信息降级)。

### Option 3 — PR-merge webhook 独立 handler
- **Pro**:与 Runner 完全解耦。
- **Con**:Bridge 要新增 webhook 面;merge 事件已能经 land-status.json 到达
  (GEO-362 evidence),重复建设;webhook 与 session 的归属映射要新做。**否决**。

### Option 4 — FSM 无条件放宽 awaiting_review → completed
- **Con**:破坏 approve/ship 语义,任何空 payload 事件都能跳过 founder 门。**否决**
  (issue 亦标 ❌)。

### 推荐:Option 1(主)+ Option 2(兜底)+ 严格 route guard
- **Rationale**:A 的两层 root cause 决定了单选项修不全 —— Option 1 修 payload
  源头与 B 的缺失发射;Option 2 兜住"Runner 忘调/事件丢"的残余风险;
  再加 **Decision 4 严格 route guard**:空/外来 route 的 session_completed
  不再静默 fallback 成 `completed`,而是 loud warn + skip FSM(发射器 bug 立即
  可见、不腐蚀状态)。FSM 只加一条受 call-site merge 证据守卫的
  `awaiting_review→completed` 边,approve 语义不破。
- **Appetite**:M(1-2 周):comm 子命令 + Bridge 两分支 + FSM 一条边 + 测试。
- **显式不做**:PR-merge webhook;FSM 通用放宽;stage_changed 升格为状态驱动。

## 6. 澄清问题(→ 非阻塞 ask 已发 Lead)

1. **Scope**:设计取向(Option 1+2 组合)是否认可?—— ask `5b416b27`,未收到
   否决则按此成稿。
2. **数据模型**:无 schema migration(events 表已有 payload 列;sessions 表已有
   status/pr_number)。确认无需新列 —— 从代码审计自答:是,零 migration。
3. **负面守卫**:no-merge 类 route(no_code/pr_handoff/phase_design_complete)
   是否只允许从 `running` 终态化?—— 从代码自答:是(review-gated 状态不得经
   no-merge route 洗白)。

## 7. 结论 → 下一步

- [x] 审计完成,方案锁定:Option 1 + Option 2 + route guard,FSM 窄边。
- [ ] `stage set research` → research.md(机制细节:payload 契约、双 sink 对齐、
  marker/reconcile、FSM 边守卫、测试证据)
- [ ] `stage set plan` → plan.md(实施步骤 + 回滚边界 + 测试计划)
- [ ] design_review 门 → founder HTML → phase_design_complete
