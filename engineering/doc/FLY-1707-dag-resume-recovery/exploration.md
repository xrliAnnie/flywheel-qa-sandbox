# FLY-1707 DAG 断点继续与恢复 epic — 探索

Issue: FLY-1707 (https://linear.app/geoforge3d/issue/FLY-1707/epic-重跑与恢复dag-断点继续fly-1699-prd-已定稿-建设)
日期: 2026-08-15
基于: 无(上游 PRD 在 `product/doc/FLY-1699-resume-entry-node/plan.md`,PR #810,§9 四条语义已锁)

---

## 0. 一句话

系统一直知道「这个 run 该做哪一步」(`workflow_run.current_node_id` 由转移事务权威维护),但没有任何东西能回答「凭什么现在还能接着做」。没有这个答案,重新进场只能从模板头重来 —— 2026-08-11 崩溃后五单全部从 design 重跑,单日白烧 4.1 小时墙钟。本 epic 给「当前该做的那一步」配一份可验证的恢复凭据,并把三个相邻的 run 生命周期死角(救援路径、force-cancel、close 级联)一并清掉。

## 1. 范围:E5 = 四张单并成一条流水线

| 章 | 来源 | 一句话 |
|---|---|---|
| Ch.1 断点继续 | FLY-1707 本单(FLY-1699 PRD) | crash/重启后重派,进场 = 当前权威目标节点,不退回模板头 |
| Ch.2 救援路径扶正 | FLY-1668 并入 | operator rework 的死角 #3(completed holder 不可唤醒)以「重派认领为主路径」收口 + 死角文档化 |
| Ch.3 force-cancel | FLY-1416 并入 | 原子「冻 run → 收活执行体 → 不再生」,消灭 RUN_HAS_LIVE_EXECUTIONS catch-22 |
| Ch.4 close 级联判终 | FLY-1711 并入 | close_runner 级联判终失去唯一活载体的 run,死预留随之释放;反向(run 判终收会话)对齐 |

已裁关不做:FLY-1713 / FLY-1714 / FLY-1736。级联设计可自然覆盖聋 runner 判活/释放的最小面,但不重建 1713/1714 的完整机制。

## 2. 已锁语义(Annie 2026-08-11,PRD §9)

1. **形状 = 恢复当前那一步**:代码没变就接着跑,变了就重跑。不做逐节点精确复用(会错误复用)。
2. **半成品 = 隔离归档后从该节点重跑**,不算「代码变了」。
3. **验收口径 = 1 单进 qa(FLY-1645)+ 3 单进 implement + design 零重跑**(替代「五单都进 qa」)。
4. **诚实口径**:「省 4.1 小时」必须和「8-11 那批要靠凭据重建才能重放」的 caveat 绑在一起说。

口径说明:③ 是 Annie 逐字「接受修正口径」;①②④ 是按推荐执行、已告知,她随时可推翻。

## 3. 工程边界(Tadashi 2026-08-15 已裁,ask 01f77c53)

5. **生命周期 = 路 A**:续同一个 run + 新增独立 resume admission。路 B(新 run 顶掉旧 run + 权威投影)留后续单。Tadashi 附活体证据:8-14 夜他手工判终一个被新 run 超越的僵尸 run(FLY-1715 相关,active@land 热循环两天)—— 路 B 的清理负担与双活风险是真实的。
6. **降级路径 = typed 409/hold + 显式 supersede 入口**,绝不静默回落模板头。附加两条硬要求:
   - **每次 hold/409 必须可观测**:落 log + 可查账(本 epic 的证据⑥就是 dispatcher consume 返回 false 零输出、事后无法归因)。
   - **typed reason 归一化**:StateStore 有 500 字上限拒绝门(FLY-1770 刀7 同族),reason 必须走归一化短码,细节进 payload。
7. **与在飞 PR 对账**:FLY-1770(PR #845 land 收尾自愈)、FLY-1772(PR #846 返工新卡闭环)都动 run 生命周期相邻状态机,方案必须写明各自辖区与交接面(见 §7)。

## 4. 根因(PRD §3,代码复核确认)

```
根:有「该做哪一步」(current_node_id),没有「凭什么还能接着做」的证据
├── 症状① 进场是模板头的纯函数(in-degree 0 节点,152/152 零例外)
│      runs-route.ts 的 successor-phase 409 让 mid-flight run 永远无法从 start 路由再驱动
├── 症状② 成功语义散在两处(done ≠ 成功;裁决节点写 workflow_claims,普通节点写 workflow_node_completion)
├── 症状③ 通用完成层零代码指纹(全库带 sha 的列只有 PR/gate/ship/文档物化四处专用)
└── 症状④ 恢复去问会消失的东西(tmux 活性 / worktree 在不在;T2/T3 证据不耐久)
```

三个并入单是同一根的邻接死角:**run 的生与死两个方向都缺原子入口**(1416 关不掉、1711 死不透、1668 救不活),和「进场只能从头」共同构成「run 生命周期不可运维」。

## 5. 关键选项与结论

### 5.1 恢复形状:整体验证 vs 逐节点缓存(已锁,PRD §4.1)
选 A(恢复当前那一步 + 一次性验证)。B(build cache)有致命反例:引擎不知道非 hermetic runner 实际读过什么;拿旧 `node_output` 现算天然恒等 = 空判据。

### 5.2 恢复凭据挂哪:新前沿账本 vs 挂在已有权威目标上(选后者,PRD §4.2)
引擎已有权威前沿:转移事务在同一事务里写 `edge_traversed`(event_uid = transitionUid)+ 目标 `workflow_run_node` 行 + `current_node_id`。**不造第二份前沿**,只给已有目标元组挂验证附件,唯一键绑 `(run_id, target_node_id, target_attempt, transition_uid)`。漏一种前沿变动(QA fail 的 loop、rework、operator rework、gate opening)附件就分叉 —— 每种转移都必须产出/继承附件。

### 5.3 「代码没变」的判据:严格相等 vs 祖先判定(选祖先判定,PRD §4③/K1)
严格相等会把「节点 3 跑到一半提交过东西」判成「变了」→ 退回模板头 = 白做。用 `git merge-base --is-ancestor`(现成原语 `GitResultChecker.isAncestorOf`,fail-closed:任何 git 错误 → false)判「同一条线往前走」。外部/未知来源 drift → hold,不许静默 reset。

### 5.4 恢复锚点:裸 SHA / 分支 head / 引擎受保护 ref(选受保护 ref,PRD V1)
裸 SHA 会被 GC(branch -D 后 dangling);分支 head 会被 `removeIfExists()` 删掉(worktree + 本地分支一起删)。FLY-1718 已让 fresh dispatch 物化 origin 同名分支再 pin startPoint —— 已 push 的历史有救,但**未 push 的本地提交仍会死**。引擎自有 `refs/flywheel/*` 命名空间已有两个先例(`materializations/` CAS claim、`archive/`),新增 `refs/flywheel/checkpoints/` 是同族第三个。

### 5.5 V5 围栏:全 run quiescence vs 目标 writer 围栏(选后者,PRD V5)
`validateRunQuiescenceEvidenceTx()` 已被 founder 指令中和为永远 ok(parked-alive holder 是 DAG 设计的一部分)—— 复用它 = 安全假绿。要围栏的是**将被替换的那个 writer**:execution/activation 不可再跑、credential 撤销/换代、worktree mutation lease 转移、延迟回来的旧进程不能再写。现有原语:`workflow_launch_owner` generation lease + `workflow_launch_cancellation`(append-only)、worktree generation nonce、FLY-1759 的 cwd 进程回收(拆 worktree 前物理杀掉旧 writer 进程树)、FLY-1718 pre-push guard。

### 5.6 rollout:一个注册 flag + 无条件 shadow 日志
FLY-709 中央 flag registry 是现行合法通道(`packages/config/src/feature-flags/registry.ts`,truth validator 拒绝未注册 FLYWHEEL_*)。PRD K7 要求 observe-only + default-off kill switch(爆炸半径 = 所有 DAG start)。取最小化方案:**恰好一个**注册 opt-in flag;shadow 解析(proposed target + reason 落账)无条件跑、不依赖 flag;flag 只控「是否按解析结果实际进场」。呼应 FLY-1466「不加新 flag」的精神:一个、注册制、有退役条件(enforce 稳定后转 default_on 或固化)。

### 5.7 Ch.2 的定位:修「唤醒 completed holder」vs 重派认领为主路径(选后者,E5 定稿)
`activateHolderForWake` 的 status 白名单(running/ship_parked/design_done/awaiting_review)是终态免疫的一部分,放开 `completed → running` 明确不做(PRD §4.9)。主路径 = 让 rework 走「关旧 zombie actor → 重派 fresh replacement」;协调器里 `isStateStoreIrreversibleTerminalForZombie → closeActorForReworkSupersession → replacement` 的骨架已存在,FLY-1772 Part 2 正在把 fresh replacement 的 dispatch(replacement context 先于 predecessor gate、base_revision 当 startPoint)修通。E5 的 Ch.2 收窄为:doctrine 定案 + 残余死角清点 + 一条真 run 端到端实证 + 死角文档化,不与 1772 重复建设。

## 6. 非目标(PRD §6 + E5 裁定)

- 节点内断点续传(R4);逐节点增量复用/build cache;崩溃恢复时自动换新模板语义(同 run 恢复跑 pinned snapshot);自动恢复(引擎自己发现并重派);复用 founder 批准 / land 效果 / 裁决 fail 结论;跨 issue / 跨分支复用;路 B;放开 `completed → running`;接管路 sessions/env 状态整合;模板/gate 语义(FLY-1691 线);FLY-1713/1714/1736 的完整机制。

## 7. 与在飞 PR 的辖区对账(Tadashi 附加硬要求)

| 面 | FLY-1770 (#845) | FLY-1772 (#846) | 本 epic (E5) |
|---|---|---|---|
| land closeout 重试/`held` 语义 | **辖区**(held = 人类终态;retry 走 partial 通道) | — | 不碰;force-cancel 的终态用 `terminated` 族,不产新 `held` |
| gate holder 卡片生命周期 / supersede | — | **辖区**(supersede→void→materialize→watch) | 复用其 `supersedeWorkflowGateHoldersTx`,不另建 |
| rework 白名单 / fresh replacement dispatch / PR binding mint | — | **辖区**(§13.1/13.3/13.6′) | Ch.2 只做 doctrine + e2e 实证,dispatch 机制交给 1772 |
| dead-exec sweep 本体 | — | 只消费其产物 | **辖区**(Ch.3/Ch.4 的 respawn 抑制与运维意图区分) |
| `workflow_start_reservation` / runs/start | 不碰 | 只读引用 | **辖区**(resume admission + 接线) |
| session↔run 终结级联 | 边缘(land_source_session_unavailable 改 retryable) | 不碰 | **辖区**(Ch.4 双向级联) |
| alert disposition union | 不加 | +6 literals | 会再加(文本合并冲突点,实施时 rebase 对齐) |
| dispatcher `workflow-engine-dispatcher.ts` 启动闸区域 | — | **改**(replacement context 提前) | resume admission 也要进同区域;**实施排在 1772 合入之后 rebase** |

交接面结论:E5 与两单无语义冲突,有两处文本/顺序耦合(dispatcher 启动闸、disposition union),排期上 E5 实施起点在 1770/1772 合入后,plan 里写死 rebase 对齐动作。

## 8. 验收锚点(细节在 plan)

- 机制验收 A1–A18(PRD §5.1,阴性对照 A2/A5/A8/A9/A11/A16 必须有;A3 必须先删 worktree + 本地分支)。
- 事故重放(回溯,最后做):只读生产副本 + 真 dispatcher;判据①四单 design 0 新 attempt ②FLY-1645 首个 running == qa ③附件精确绑当时权威目标元组 ④人为改 FLY-1614 PR head 一位必须拒绝。
- Ch.3/Ch.4 各自的正对照(close 后 runs/start 立即可用;force-cancel 后无 re-spawn)+ 阴性对照(多载体 run 不误判终;非目标 run 的 sweep 行为不变)。
