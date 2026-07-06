# Research: FLY-887 status-line 在本快照中的实现事实 — FLY-896

Issue: FLY-896 (https://linear.app/geoforge3d/issue/FLY-896)
日期: 2026-07-05
基于: exploration.md、快照 `c9324ee` 源码实读

## 1. 被观察对象:status line 的实现锚点(全部在本快照内核实)

| 锚点 | 位置 | 事实 |
|---|---|---|
| 状态词表 | `packages/teamlead/src/bridge/phase-orchestrator.ts:110` | `PhaseLineState = "pending" \| "active" \| "parked" \| "done"` |
| 派生规则 | 同文件 `computePhaseLineStates` (:129-150) | 纯函数,按 session `status` 字段:无行=pending;`running`=active;`completed/failed`=done;其余(design_done/awaiting_review/approved_to_ship)=parked |
| 渲染格式 | 同文件 `renderPhaseStatusLine` (:152-159) | `🎨design(x)·🔨implement(x)·🧪qa(x)`,顺序固定 design→implement→qa |
| 投递方式 | `StateStore.ts:4102-4104`、`discord-utils.ts:186-188`、`auto-qa-effects.ts:154` | **单条消息 in-place edit**,挂在 issue 的**主 chat thread**(绝不发 per-role `phase_chat_threads`);消息 id 持久在 `chat_threads` 新列(:5125 幂等迁移) |

**关键 cosmetic 取舍(:98-108 注释原文明示)**:状态行**刻意不**交叉核对 CommDB declared-state(park/wake)。被 wake 的 fix-in-progress implement 其 `status` 仍是 `awaiting_review` → 状态行照旧渲染 `parked`,直到它再次 `complete` 才翻。外部 QA 观察时**不得**把"FAIL 修复中 implement 显示 parked"记为 bug——这是 FLY-887 文档化的设计决定。

## 2. 载具运行面(keep-alive,同为被观察对象)

- park/wake/turn 协议、单 worktree 接手、fix-round 账本:见 `engineering/doc/FLY-887-phase-session-keepalive/plan.md`(M1-M9),实现散布 `phase-orchestrator.ts` / `plugin.ts:3948,4163` / `event-route.ts:1462,1890`。
- QA FAIL → wake implement(kind:`fix`)→ fix 后 re-`complete --route needs_review` → wake QA(kind:`retest`,worktree 已在新 head,零 checkout)。fix-round cap=3(`DEFAULT_MAX_FIX_ROUNDS`, :96)。

## 3. 快照与载荷事实

- 本分支 `project-slot-3-FLY-896` 是 orphan 快照 `c9324ee`(squashed,无历史;fixture secrets 已 neuter)。
- **`doc/qa/sandbox-notes.md` 不在本快照树中**(`git cat-file -e` 验证)——FLY-895 的载荷文件在另一条 lineage 上。故本轮 Implement 合同是**创建**该文件(含 `## E2E run log` 节),非追加。
- FLY-895 先例可复用的 QA 结构检查维度:章节名、日期、issue 号、**条目句尾句号**(FLY-895 round 1 正是以缺句号做 deliberate FAIL,round 2 RE-TEST 翻 PASS,commits `95f0eac→f260f1c→9512c09`)。

## 4. 结论

无未知技术风险:载荷 doc-only、被观察机制已在快照内 build 完成、FAIL→PASS 循环有 FLY-895 逐字先例。可直接进 plan。
