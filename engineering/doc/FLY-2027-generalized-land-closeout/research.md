# FLY-2027 generalized land 收尾链 — 调研

Issue: FLY-2027 (https://linear.app/geoforge3d/issue/FLY-2027/engine收尾-generalized-land-路径缺-fly-369-收尾链ship-后停驻体不收thread-不自动归档8-24-双)
日期: 2026-08-24
基于: exploration.md

---

## 0. 调研方法与证据面

- 三路并行代码审计(land 执行路径 / 老 🆒 FLY-369 cascade / ship_parked-park 机制),关键结论由本人对源码抽查复核(`shipped-husk-escalation.ts:310-311`、`lifecycle-closeout.ts:136-160`、`post-merge.ts:180-260`、`codex-phase-shutdown.ts:82-86`)。
- 生产账本只读取证(`~/.flywheel/teamlead.db` `mode=ro`):8-24 双 ship(FLY-2000/FLY-2015)全时间线、8-22~8-23 generic run 对照组(FLY-1986/1987/1929/1894)、held/terminated land 案例(FLY-1830/1853)。
- GitHub 实测 PR merge 时刻(`gh pr view --json mergedAt`)。
- 子代理报告间的一处冲突已裁决:三号报告猜测 "FLY-2000/2015 大概率用 generic 节点" 与账本不符(实为 `tpl_simple_code` + `implement` 节点,`chat_thread_role='implement'`),以账本为准。

## 1. 结论一:收尾链存在且在生产自动跑通(issue 断言①③被账本推翻)

### 1.1 同一个编排器,两条入口

老 🆒 路径与 engine land 路径共用 `runPostShipFinalizationInner`(`post-ship-finalization.ts:668`)。land 走 resumable 变体(`runResumablePostShipFinalization` :656,FLY-1770),多出 step receipt、8 档退避(1/2/4/8/15/30/60/120min,第 9 次 held)与 landManaged 专属步骤(husk 强收 1a、land terminal 消息 2.5)。**不存在"generalized land 缺 cascade"的结构**——cascade 是同一份代码。

### 1.2 生产实证(两种 producer 都通)

| 案例 | producer | merge → 体收编 | merge → thread 归档 | 备注 |
|---|---|---|---|---|
| FLY-2000 (8-24) | implement (`tpl_simple_code`) | 63s | 125s | 温和 shutdown 失败 → FLY-1992 husk force reap 解开 |
| FLY-2015 (8-24) | implement | 35s | 90s | 同上;归档后 founder 发话 → FLY-1709 保护生效 |
| FLY-1986 (8-23) | **generic execute** (`tpl_generic_menu`) | ~3s | 13s | legacy 直杀一把过,worktree/branch 全清 |
| FLY-1987 / FLY-1929 / FLY-1894 | generic execute | 同形态 completed | 自动归档 | 对照组全绿 |

### 1.3 8-24 "实证" 的三个表象来源

1. **批准前的正常等待被误读为"ship 后未收"**:implement 体 05:57/06:09 完成即投影 `ship_parked`(keepalive 等 kickback,FLY-1448 设计语义),founder 17:12/17:13 才批准——体在 `ship_parked` 杵了 11 小时是**批准前**的等待,不是 ship 后的滞留。ship(merge)后 35-63 秒即收。
2. **founder_reopened 保护**:FLY-2015 thread 17:16:50 自动归档成功后,founder 在 thread 内发话(Discord 自动 unarchive)→ 17:24:35 / 17:32:13 两次再归档被 `founder_reopened` 拒绝(fail-closed,FLY-1709)。"连问两次"与两次拒绝时刻吻合。
3. **Lead 手动扫**:17:24:34-36 与 17:32:13-19 两轮批量归档 sweep(source=`bridge.done-thread-archiver`)是"手动扫"的账面痕迹,输出多为 `already_archived`(即:早已归档)。

已用非阻塞 ask(`ad25c887`)向 Lead 并排呈报,请求提供 Discord 面可能存在的账本外证据;未答复前按本调研推进,若有新事实按 §5 重定位。

## 2. 结论二:真实缺口在"纵深不对称"与"park 结算账",不在主链

### 2.1 缺口地图(按实害排序)

**D1 — generic 体的收尾纵深比 implement 少三层**(实害:低频但真实,触发即 held 需人工)

implement(phase role)体有 4 层收编:①优雅 Codex phase shutdown(daemon drain + credential scrub + founder-TUI removal,`codex-phase-shutdown.ts`)→ ②FLY-1992 husk 强收(`forceShippedHusks`)→ ③step 1.25 phase 收编(`finalizeWorkflowPhaseRoles`)→ ④step 1.7 issueCloseout 全量兜底。

generic 体(`chat_thread_role='main'`)只有 2 层:step 1 legacy 直杀(`cleanupTmuxTarget`)+ step 1.7 兜底。因为三处判据全部写死 phase role:

| 判据点 | 位置 | 形式 |
|---|---|---|
| `getPhaseSessionsForIssue` | `StateStore.ts:7587-7590` | `chat_thread_role IN ('design','implement','qa')` |
| `isWorkflowPhaseSession` | `runner-shutdown-evidence.ts:4,19-21` | 同上集合 |
| `isResidentCodexPhase` | `codex-phase-shutdown.ts:82-86` | `adapter_type==='codex-tmux' && isWorkflowPhaseSession` |

而 generic 节点的 role 由 `workflow-engine-dispatcher.ts:2732` 决定:`isWorkflowPhaseRole(node.type) ? node.type : "main"`,`generic` 在 `node-type-registry.ts:132` 是 `isPhaseRole:false`。

推演后果(与 8-24 账本对照):FLY-2000/2015 的 implement 体温和 shutdown 失败(`phase_shutdown_ack_timeout_heartbeat_stopped_live_pane`)→ husk force 在 retry 轮解开。**同形态发生在 generic 体上**(tmux kill 失败/pane 卡死):无 husk force → land partial 8 档退避 → 第 9 次 held,需 Lead 手工。另外 generic Codex 体被直杀,**没有 daemon drain / credential scrub 的优雅关闭语义**。

**D2 — park 结算账本三处硬伤**(实害:账死不清;未来消费者接线时踩雷)

- A:`settleReworkParksForRunTx`(`StateStore.ts:13785-13872`)SELECT 写死 `reason='rework_reachable_wait'`;写入端(`:33357-33359`)会产出 `runner_ship_gate_wait`,**全仓零消费者**——runner_ship 模式(FLY-1655 后仅 frozen/custom 兼容边界)的 park 永不结算。
- C:七项身份前置任一不满足即静默 `continue`(`:13834-13846`),无日志无审计——滞留完全不可见。
- D:结算只看 `generation === MAX(generation) FOR execution_id`(`:13792-13803`),而任何后续 activation admit 都会追加 generation+1 的 `park_cleared`,把旧 `park_opened` 筛出结算范围。
- 附:4 条 session status 解除路径(gate 物化 `:40547`、carrier rebind `:45653`、wake 复活、Lead 手动 done)**不追加 `park_cleared`**——(A) status 与 (B) park 凭证两本账没有一致性约束。

**D3 — completion_disposition 与 park 投影语义矛盾**(实害:kickback 返工时活体已死,靠 FLY-1628 恢复提案兜)

land 模式下 implement 体投影 `ship_parked`(等 kickback wake),但 disposition 分类器(`StateStore.ts:35246-35264`)只认 runner_ship 分支为 `runner_ship_park`,land 分支输出 `engine_gate_handoff` → runner CLI 提示 **"本节点已终结……立即收尾退出"**(`complete.ts:456-469`)。进程退出后 pane 成 husk,`ship_parked` 名不副实;kickback 的 wake_pointer 打在死体上。

**D4 — 观测与文案诚实性**(实害:直接导致了 8-24 的误读)

- `land_partial` 的 `issue_closeout_incomplete:cause=unknown`(FLY-2000 账本实测)——`land-closeout-cause.ts` 的 11 种 typed cause 未覆盖当日形态,复盘只能靠猜。
- founder_reopened 归档豁免消息:"原因解除后会由清理流程重试"——founder 的消息不会消失,原因**不可解除**,该 thread 此后永远不会自动归档(唯一出口:Lead 手动端点/新 run 复活)。文案对 founder 是误导。
- `ship_parked` 等待期(gate 开 → founder 批准,可长达数小时)对外无解释性可见物,是"滞留"误读的温床。

**D5 — FLY-1448 B2 死代码**(实害:无,纯账)

`isExactCurrentWorkflowEnginePark`(`workflow-engine-park-evidence.ts:9-27`)全仓仅测试引用;`plugin.ts:8583-8625` 构造 wake deps 时 `isDeclaredParked`/`isEngineParked` 均未传——CommDB `workflow_engine_park` 投影只写不读。

### 2.2 已被排除的方向

- FLY-1830 held@land 是 `ship_workflow_failed:failure`(CI 失败,FLY-1861 held resume 管辖),非本单缺口。
- step 1.7 `collectIssueCloseoutNodes`(`lifecycle-closeout.ts:136-160`)经复核确认 role 无关(按 issue alias 收全量 session),generic 兜底真实存在——D1 的实害因此限于"兜底层之前的三层缺失",不是"完全无收编"。
- FLY-1770 retry 预算跨 epoch 收敛已归 FLY-1940。

## 3. 相关既有机制(设计须兼容)

| 机制 | 来源 | 对本单的约束 |
|---|---|---|
| founder_reopened / archive-once | FLY-1709 | 验收②:保护语义原样保留 |
| 老 🆒 路径 finalization | FLY-369/1185 | 验收③:非 workflow session(`workflow_node_id` NULL)行为字节不变 |
| husk 强收证据门 | FLY-1992 | pane alive + shutdown 请求 >30s 未 ack + land claim 在手 + `retry_count≥1`;扩展候选集时证据门原样复用 |
| land 退避/held/resume | FLY-1770/1861 | held 出口与 resume 语义不动 |
| kickback / rework wake | FLY-1772/1912/1628 | D3 的修复牵动 rework wake 全链,越界风险高 |
| park authority append-only | FLY-1448 | 只能追加新结算路径,不改历史行 |

## 4. 方案空间(供 plan 收敛)

**S1(推荐)— 纵深对等 + 账本硬化 + 文案诚实,三刀小做:**
1. 三处 phase-role 判据加性扩展为"phase role **或** workflow-bound"(`sessions.workflow_node_id` 非空即 DAG 体):`getPhaseSessionsForIssue` 加并集查询(或新增 `getWorkflowSessionsForIssue`)、`isWorkflowPhaseSession` 的三个消费点(step 1.25 / husk force / codex-phase-shutdown)按点位评估接入。非 workflow session 路径零变化(验收③)。
2. park 结算硬化:结算覆盖 `runner_ship_gate_wait`(在 run 终结调用点);静默 `continue` 补结构化审计事件;generation 筛选改为"该 execution 仍 open 的 park 行"判定。
3. 文案与诊断:`cause=unknown` 补 typed cause;waiver 消息改为真话("此 thread 因 founder 发言保持打开,不再自动归档;需要时由 Lead 手动归档")。

**S2 — 字面"补链"**:审计证明链已在,空转;排除。

**S3 — 大做(含 D3 disposition 对齐 + park 可见性面 + isEngineParked 接线)**:D3 牵动 runner 退出行为与 rework wake 全链(FLY-1628/1731 的教训区),单独立单更安全;isEngineParked 接线属 FLY-1448 B2 收尾,与本单验收无关。均判 follow-up。

## 5. Lead 裁决(ask `ad25c887` 已答,2026-08-24)

1. **Annie 原文**(#flywheel-engineer 顶层,非 issue thread):17:23:36「已经完成的 thread 你去 Archive 掉」;17:30:40「can you archive those thread already finish? 另外…为什么它现在还是没有办法自己去 archive」——问的是"完成的 thread 为何不自动归档"。与账本的 17:24:34 / 17:32:13 两轮 sweep 时刻吻合(Lead 响应两条消息触发)。
2. **立单前提确认误读**:Lead 的 "滞留 ship_parked" 观察面是 Bridge patrol 名册,观察时刻在 17:12 批准**之前**——把批准前正常等门的 `ship_parked` 误读为 ship 后不收;merge 后 63s/35s 收体的账本为准。8-24 两单定位为"链条已通"的对照组。Lead 同步改 issue 标题防后人误读。
3. **scope 裁决(批准)**:按真实缺口收敛——①generic 体收体对等(D1);②`ship_parked` 投影去硬编码(`node.type==='implement'` → capability 判定,generic 也获得 keepalive park);③park 结算消费者补齐(D2);④诊断/文案诚实化(D4)。验收①对 generic producer 成立、②③不动。D3(disposition 语义矛盾)与 D5(isEngineParked 死代码)维持 follow-up 判定。

> 注:裁决②把 §4-S1 原判保守搁置的"park 扩展到 generic"圈进了 scope。连锁在 plan 中展开:generic park 后其收编依赖裁决①的对等判据,其结算天然落入 `rework_reachable_wait` 既有消费者;kickback 活体语义与 implement 完全对齐(包括与 D3 相同的既有缺陷与兜底,行为对等而非新造)。
