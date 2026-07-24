# FLY-1456 62 flag 逐条定值执行 — 探索

Issue: FLY-1456 (https://linear.app/geoforge3d/issue/FLY-1456/flag治理清存量eng-62-flag-逐条定值执行-按-hl-盘点圈选-删固化动态化承接-fly-1413)
日期: 2026-07-24
基于: 无(上游为 FLY-1413 收敛版裁决,commit `67b35748` `tab-decisions.js`)

## 1. 任务本质

FLY-1413(PRD/审计单,PR #682 已合 `6019e021`)盘点了 FLY-1136 基线之后新增的 **62 个 feature flag**;HL + Tadashi 已完成收敛裁决(裁决源 = branch `flywheel-FLY-1413` commit `67b35748` 的 `tab-decisions.js` + `flag-tab.html`,含 2 条 hard-call 终裁)。Annie 已下放 ratify(msg 1530097242994770000:「你们俩收敛好了就可以了」)。

本单 = **按收敛裁决逐条执行**的 eng 单。本文档是执行的 design 节点产物。

## 2. 裁决全景(62 条互斥分组,来自 build-tab.mjs guard 3)

| 桶 | 条数 | 内容 | 本单动作 |
|---|---|---|---|
| default_only(没显式设过 ∩ 其余) | 40 | 跑代码默认值,复核未见异常 | **零代码动作**;记入执行台账,整体标记给 FLY-1405 动态化评估 |
| explicit_dead(显式设过 ∩ 已判死) | 1 | `checkpoint_watchdog` | **删除**(死壳) |
| dead_only(没显式设过 ∩ 已判死) | 12 | park 家族 5 + delivery 家族 6 + 总闸 `legacy_delivery_watchdogs` | **删除**(死壳) |
| explicit_unknown → 已裁 | 2 | `cmux_linked_view` → **frozen@0** 归 FLY-1446;`quota_daemon_cutover` → **keep@1 固化候选** | 前者零动作(归 1446);后者**固化**(写死 retired 后删 flag,本单执行) |
| explicit_other | 6 | `three_stage_codex_design_toggle`(保持关)· `skill_framework_mode`(保持 split)· `workflow_claims_write/read`(在用)· `cmux_view_invariant`(护栏)· `workflow_template_dispatch`(**frozen,RESERVED**) | 前 5 条零代码动作,记台账;最后 1 条 **RESERVED 绝对不碰** |
| owned_elsewhere | 1 | `workflow_generalized_templates`(FLY-1436 owned) | **RESERVED 绝对不碰** |

**等式:40 + 1 + 12 + 2 + 6 + 1 = 62**(all 9 guards passed)。

## 3. 硬约束(Annie 红线)

- **RESERVED 组 = work-kind cutover 两个 flag:`workflow_template_dispatch` + `workflow_generalized_templates`** — FLY-1436 菜单系统的急停杆,本单绝对不碰。执行范围 = 62 − RESERVED = 60。
- 绝不出圈选 HTML(废流程)— 本单不做任何「待圈选」交互物;design HTML 是执行方案汇报,不是圈选页。
- merge founder-gated:每个 PR 走正常 :cool: 流程,绝不自 merge。

## 4. 实际要动代码的 = 14 条

**删除 13 条死壳**(裁决:两档均「确认可删」,FLY-1413 已逐条取证到调用点):

- park 家族 5:`park_watch` `park_watch_cadence` `park_watch_n1_ms` `park_watch_n2_ms` `park_watch_qa_n3_ms`
- delivery 家族 6:`delivery_ack` `delivery_unconsumed_v2` `delivery_ack_timeout_ms` `delivery_max_redeliver` `delivery_max_transport_failures` `ack_late_window_ms`
- 总闸 + checkpoint 2:`legacy_delivery_watchdogs` `checkpoint_watchdog`

**固化 1 条**:`quota_daemon_cutover`(keep@1;固化 = 把 retired 路由写死后删 flag)。

其余 46 条(40 default + 5 keep + `cmux_linked_view` frozen@0)零代码动作,只进执行台账。

## 5. 关键设计问题(本探索的核心取舍)

### Q1:删「flag 壳」删到多深?

13 条死壳的共同结构:读点全部接在 `retiredWatchdogLaneEnabled(): false`(硬编码返回 false,参数根本不看)这条已退役巷道后面。两条切线:

- **切线 A(壳删除)**:删 registry 定义 + truth.ts 加墓碑 + 删/折叠 env 读点(常量折叠,保留 OFF 分支)。巷道机器(park-watch.ts、gapScanTick、LeadEventDeliveryCoordinator legacy 路径等)不动。
- **切线 B(巷道拆除)**:连同死巷道机器一起删。

**选 A**。理由:① `legacyDeliveryWatchdogsOn` 布尔穿透 plugin.ts 20+ 处下游消费者(watchdog 状态上报、GatePoller opts、多个子系统),巷道拆除的爆炸半径 = FLY-1261 量级,需按巷道单独立项;② 本单合同是「flag 逐条定值执行」,死壳的死因(巷道退役)FLY-1413 已取证,壳删除即兑现裁决;③ 隔离审的 reviewable PR 要求小 diff、零行为风险。巷道拆除列为 follow-up 建议(见 plan §7)。

**边界内例外**:仅当死代码**唯一可达自被删读点**且局部(如 gate-poller 的 checkpoint patrol 方法),随同 PR 删除并在 PR 描述列明——这是 FLY-1240/1242 的删除粒度,不是巷道拆除。

### Q2:「固化」对 keep 类意味着什么?

派单基线只对 `quota_daemon_cutover` 定义了固化(=写死 retired 后删 flag)。其余 keep 裁决(保持关/保持 split/在用/护栏)= 值已是现状,**零代码动作**,台账记录即执行。不做「把 keep 值写进 .env」之类的多余动作(那会把 40 条默认值变显式,违背 FLY-1412 的创建时治理方向)。

### Q3:PR 怎么切?

照 FLY-1240-1243 模式:**按内聚单元切,不按单 flag 切**。4 个 PR:park 家族 / delivery 家族 / 总闸+checkpoint / quota 固化。全部触碰 registry.ts + truth.ts → **串行落地**(#588 冲突教训)。顺序:先叶子旋钮(PR-1/2),后总闸(PR-3),固化独立(PR-4 任意位)。

### Q4:与 FLY-1405 的交接形态?

「动态化类标记」= 执行台账里给每条幸存 flag 标 `1405-migrate-candidate` 与否 + 台账整体交接。不改任何读点 timing(那是 1405 的活)。

## 6. 不做什么(诚实边界)

- 不碰 RESERVED 2 条;不碰 baseline(FLY-1136 前)的 76 个 flag。
- 不拆巷道机器(park-watch/gap-scan/legacy delivery/misroute patrol 等留 follow-up)。
- 不做动态化迁移(FLY-1405)、不做 flag 创建时治理(FLY-1412)。
- 不替 FLY-1446 处理 `cmux_linked_view` 的活不一致线索。
- 生产 `.env` 两行清理(`FLYWHEEL_CHECKPOINT_WATCHDOG` 显式行、`FLYWHEEL_QUOTA_DAEMON_CUTOVER=1`)是 ship 时运维步骤,不进 repo diff。
