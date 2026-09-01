# FLY-108 Session Status 不 Flip — 探索

Issue: FLY-108 (https://linear.app/geoforge3d/issue/FLY-108/session-status-不-flip-runner-session-completed-两类-bug-geo-362-empty)
日期: 2026-08-31
基于: 无

> **本文档语境**:本探索产生于 QA slot-3 的 generalized workflow 设计节点重放。审计起点即发现:
> 本分支的**代码快照 `1855f7a1`**(含 main 已 merge 的 PR #155)**已包含 FLY-108 的修复**,
> 原始已批设计归档于 `doc/engineer/plan/archive/v1.23.0-FLY-108-session-status-flip.md`。
> (注:本节点自身的 docs-only 提交会持续推进分支 HEAD;文中「本 HEAD」一律指代码快照 `1855f7a1`,
> 其上没有任何代码改动。)
> 因此本探索的目标是:(a) 独立重建问题空间与选项分析;(b) 对照已落地实现验证方向选择仍然成立;
> (c) 标注实现落地后仍存在的残余缺口。文中一切「现状」描述均以本 worktree HEAD 实际代码为准。

---

## 1. 问题空间

Runner ship 完成后,Bridge StateStore 的 `sessions.status` 不 flip 到 `completed`。被阻塞的下游:

- `close_runner` endpoint → 409 `status_not_eligible`,Lead 无法关 Runner tmux
- B3 🏁「Runner 完工可关闭」通知 → 从不触发,Lead 不知道 Runner 完工
- post-ship cleanup(tmux 关闭 + chat thread archive)→ 不跑,Runner 成僵尸
- PM 报表 / Runner lifecycle metrics → 失真

**同一症状,两类彼此独立的 root cause**:

| Variant | 触发场景 | session_completed 事件 | Payload | 卡住的状态 |
|---------|---------|----------------------|---------|-----------|
| **A — GEO-362** | 走完 approve + ship 流程 | ✅ 发了 | ❌ 空字符串 | `awaiting_review`(FSM 拒绝转 completed) |
| **B — GEO-363** | Docs-only compressed pipeline | ❌ 从没发 | n/a | `running`(只有 stage_changed) |

### 1.1 Variant A 的两层结构

- **Layer 1(Runner 侧)**:emitter 发出的 payload 为空——没有 `decision.route`、没有 `evidence.landingStatus`。
- **Layer 2(Bridge 侧 FSM dead-end)**:空 `decision` → `route=undefined` → 旧代码 fallback `status="completed"`;
  但 pre-state 是 `awaiting_review`,而 FSM 转移表里 `awaiting_review` 的合法后继当时不含 `completed`
  → `applyTransition` 拒绝 → status 不 upsert,永卡 `awaiting_review`。

### 1.2 Variant B 的架构缺口(更普遍、更严重)

Lead-driven Runner auto-start 流程里**没有任何组件负责发** `session_completed`:

1. Runner(claude CLI in tmux)只会 `flywheel-comm stage set <stage>` → 仅发 `stage_changed`;
2. 生产级唯一的 `session_completed` 发射点是 edge-worker `Blueprint.emitCompleted()`,但 Lead-driven Runner 不走 Blueprint;
3. Bridge `event-route.ts` **当时**显式把 `stage_changed=completed` 当 informational only,不触发 FSM
   (这是 bug 发生时的状态;修复后的现状见 §4——现 HEAD 已有两条 stage-driven 终态化通道:
   FLY-60 W2 merged re-finalize 与 FLY-324 no-PR live fallback);
4. 🏁 通知链全部 gated on `session_completed` 已把 status 更新过。

→ 任何 docs-only / compressed pipeline 都中招。FLY-102 Round 3 的 `runPostShipFinalization` orchestrator
在这个缺口下**实际上永远触发不了**——不只是 GEO-363 一例。

---

## 2. 约束

1. **approve/ship 语义不可破坏**:`awaiting_review → completed` 直通会绕过 founder 批准闸,不可接受(排除 Option 4)。
2. **terminal event 必须可靠**:在 bug 发生时的基线上,`stage_changed` 丢了无所谓(informational),
   `session_completed` 丢了 = bug 原样复现。(as-built 注:该对比限定在**修复前基线 / 非终态 stage 值**;
   现 HEAD 上 `stage=completed` 的投递在 W2 / FLY-324 两条通道下**承载生命周期语义**,不再是纯 informational
   ——`event-route.ts:1977-1981` 也把「informational only」限定到其他 stage 值。)
3. **payload 消费契约已存在**:`event-route.ts` 消费的字段 shape 由 edge-worker `TeamLeadClient.emitCompleted()` 定义,新发射器必须逐字段对齐,否则制造第三种半兼容 payload。
4. **runPostShipFinalization 的第一个破坏性阶段是 tmux cleanup**(其前置的 disposition 预仲裁 /
   atomic claim / shadow hook 均无破坏性):发射时机必须在 Runner 全部收尾动作(docs commit/push、
   worktree remove)之后,否则 Bridge 会 teardown 还没做完收尾的 Runner。
5. **不能掩盖上游 bug**:Variant A 的教训是 silent fallback(空 route → "completed")把 emitter bug 变成 FSM dead-end;防御路径要 fail loud。

---

## 3. 选项分析

### Option 1 — Runner 侧补 emit(`flywheel-comm complete` 子命令)✅ 已选为主修

Runner 在 pipeline 收尾时调用 `flywheel-comm complete --route <r> [--pr N] [--merged]`,
POST `/events` 带完整 payload;prompt(spin.md)里加硬性要求。

- **Pro**:同时修 A 和 B(payload 由 Runner 完整填);**单一事实源正确**——Runner 是自己完成状态的 authority,评估「我完成了没有」本来就该在 Runner 侧;不给 Bridge 加 GitHub API 依赖。
- **Con**:Runner prompt 改动面大;与旧 edge-worker Blueprint 的 emitCompleted 逻辑重叠(可接受:两条产线各自的发射器,payload shape 逐字段对齐即可)。

### Option 2 — Bridge 侧 fallback 同步(stage_changed=completed 时查 PR state,synthesize completion)

- **Pro**:不改 Runner;两个 variant 一次兜住。
- **Con**:需要额外 GitHub API 调用或依赖 webhook 时序;**把「Runner 完成了没有」的判定挪到 Bridge 猜**,
  与事件驱动模型逆向;synthesize 的 payload 依然是猜的(route/evidence 不真实),长期制造第二种「半真」事实源。
- **结论**:不作为主修,但其**有限形态**有价值——见 §4「实际落地形态」的 W2 re-finalize。

### Option 3 — PR-merge webhook 独立 handler upsert status=completed

- **Con**:merge 事件≠session 完成(收尾动作还没做完就 flip 会提前 kill tmux,违反约束 4);Bridge 要新增 webhook 面。排除。

### Option 4 — FSM 放宽 `awaiting_review → completed`

- **❌ 排除**:破坏 approve/ship 语义(约束 1)。
  (注:后来 FLY-60 W2 在**带 merge-proof 守卫的调用点**前提下加了这条边,守卫在 event-route 调用侧,
  FSM 表只声明合法性——这不是无条件放宽,语义仍由调用点把守。)

### Issue 推荐 vs 实际选择

Linear issue 原文推荐 Option 2(「最安全」)。已批设计(v1.23.0 plan,Codex 3 轮 review)最终选择
**Option 1 主修 + Bridge 严格 route guard 辅修**,理由:

1. Option 2 的 synthesize 是对 emitter bug 的**制度化掩盖**——Variant A 的 root cause 恰恰是 silent fallback;
2. Runner-side emit 让 payload 真实(route/evidence/headSha 都来自现场),下游(verify-approval、CIPHER snapshot、PM 报表)拿到的是真数据;
3. Bridge 防御从「兜底造数据」改为「fail loud + skip」:非法/空 route → warn + 不 upsert,bug 可见而不是变形。

---

## 4. 实际落地形态(本 HEAD 审计结论)

| 组件 | 落点 | 状态 |
|------|------|------|
| `flywheel-comm complete` 子命令 | `packages/flywheel-comm/src/commands/complete.ts` | ✅ 已实现(retry×4 + backoff + fail-close marker) |
| spin.md Step 3.7 强制调用 | `.claude/commands/spin.md:412-474` | ✅ 已接线(needs_review + auto_approve 两位点) |
| Bridge strict route guard | `event-route.ts:865-895`(Decision 4/5) | ✅ 已实现,exempt `approved_to_ship` 自然完成路径 |
| CIPHER labels/projectId backfill | `event-route.ts`(Decision 6) | ✅ 已实现 |
| stage_changed=completed + merged → W2 re-finalize | `event-route.ts:1764+`(FLY-60 W2) | ✅ 已存在(Option 2 的有限安全形态:只认已发过 session_completed 且 landing 后到 merged 的 case) |
| stage_changed=completed + **无 PR/无 route** → FLY-324 live fallback | `event-route.ts:1928-1985` + boot sweep(`plugin.ts:4729+`) | ✅ 已存在(第二条有限 stage-driven 通道:`isDoneButRunning` 守卫 = running + stage=completed + 无 decision_route + 无 pr_number,且无 pending complete marker、incoming land-status 不带 prNumber——no-code/QA Runner 只报 stage 也能终态化) |
| FSM `awaiting_review → completed` 边 | `workflow-fsm.ts:146-153` | ✅ 已加(FLY-60 W2,merge-proof 守卫在调用点) |
| 专项测试 | `event-route-session-completed-guard.test.ts` 等 | ✅ 存在 |

后续迭代在此地基上生长:FLY-208 5a(evidence-gap completion)、FLY-945 Fix C(approved_to_ship→awaiting_review 重开 review)、FLY-222(`no_code` route)、FLY-493(`pr_handoff`)、FLY-793(`phase_design_complete`)。

## 5. 残余缺口(探索阶段识别,research 阶段核实)

1. **marker 重发**:`complete` 4 次全失败只写 marker(`~/.flywheel/state/complete-failed/`),
   重发/reconcile 由 FLY-172 boot drain 承接——research 需核实覆盖度。
2. **Variant A 的 GEO-362 pre-state 之谜**(Annie approve 后为何还在 `awaiting_review` 而非 `approved_to_ship`)
   被原设计明确划出 scope(FLY-58 territory)——不在本 issue 回收。
3. **QA session role**:**FLY-108 本体**的 `complete` 接线只覆盖 `session_role=main`(Decision 4)。
   注意这是「原始 scope」陈述,不是「现系统无 QA/no-code 完成通道」——现 HEAD 的 FLY-324 live fallback
   (§4 表)已让只报 `stage set completed` 的 no-PR/no-code/QA Runner 走 `running → completed` 终态化。

## 6. 开放问题(带入 research)

- Q1: W2 re-finalize 分支与 strict guard 的边界——空 payload 的 Variant A 复现今天会走到哪条路径?
- Q2: marker fail-close 后 stale patrol / boot drain 的实际衔接点在哪个文件?
- Q3: 双发 `session_completed`(needs_review 早发 + ship 后 auto_approve 再发)的去重锚点是否仍是
  post-ship-finalization 的 atomic claim?
