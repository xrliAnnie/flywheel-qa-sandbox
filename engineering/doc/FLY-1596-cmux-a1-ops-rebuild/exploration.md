# FLY-1596 cmux legacy grouped → A1 迁移 + 运维重建合法通路 — 探索

Issue: FLY-1596 (https://linear.app/geoforge3d/issue/FLY-1596/cmux承接1578-legacy-grouped-a1-迁移-运维重建-cmux-视图的合法通路现在缺口)
日期: 2026-08-04
基于: 无(上游材料 = `engineering/doc/FLY-1578-cmux-lead-session-grouping/` 四件 + issue 正文的 08-04 夜实证)

---

## 1. 一句话结论

**「9 个正确形态的 workspace 15 分钟内消失」不是清理器误杀外来行 —— 是收编机器(FLY-1605)先给它们发了合法收据,修复机器(repair)再拿着这张收据执行了一次「只完成破坏半、建设半静默失败」的迁移。** 侧栏行被合法关掉,tmux 侧的置换却从未成功,于是 create 被 ready gate 永久 defer,行再也回不来。每一环各自 fail-closed 且「正确」,组合起来是一台自毁机。

## 2. 现场已变 —— scope 必须按现物翻译

Issue 正文写于 08-01~08-04 晨,描述的是「14 个 legacy grouped 会话 + mismatch 刷屏」。
本节点开工时(08-04 晚)实测:

| Issue 假设的现场 | 今天的现场(证据见 research.md §2) |
|---|---|
| 14 个 legacy grouped tmux 会话在跑 | **0 个** —— 08-04 10:37 tmux server 重启把全部 grouped 视图连同旧窗口清场 |
| mismatch 每 25s 刷 | 最后一条 `Invariant mismatch` 停在 10:35:39(重启前 2 分钟);之后**零条** |
| 迁移无从谈起 | 10/15 个 Lead 视图今晚(18:48–18:59)已被 watcher 以 A1 形态**自动**重建并落 committed 收据 |
| — | **5 个 title 卡死**:rafiki / geoforge3d-ops / geoforge3d-cos / reflection(4 个 cmux 重启恢复出的 unledgered 行)+ flywheel-cos-lead(Cass 带 `:5` 的行卡 prepared) |

⇒ scope 第 2 条「把 14 个 legacy grouped 迁到 A1」翻译为:**清掉当前 5 个卡死 + 把两个 wedge 家族变成常驻自愈 + 证明「cmux/tmux 重启后 ≤5 分钟侧栏收敛」**。原文字面目标(grouped→A1)已被重启意外完成了 2/3——但用的是「全清重来」这种不可接受的代价,而且 4 个恢复行证明**每次 cmux 重启都会重新武装死锁**。

## 3. Annie 锤点的回答:为什么修了两单还修不好

> 「我们之前已经有两个单去修 Cmux 了,为什么修那两个单都修不好呢?」

三层答案,一层比一层深:

1. **各修各层,且各自修好了。** FLY-1605 修「title 收编/改名/去重」那一层(它的验收是收编正确);FLY-1482 修「QA teardown 与 watcher 抢锁死锁」那一层(它的验收是 handoff 收敛)。两单的验收都过了,今天还在正常工作。
2. **从没有一张单持有结果验收。** 「打开侧栏,永远是全的、对的」这个结果没有 owner——每单只对自己那层的不变量负责,没有人对**组合系统**的可见结果负责。
3. **最深一层:事故恰好发生在两层的接缝上。** FLY-1605 的收编给手工重建的行铸了 committed 收据 → 这张收据正好解锁 repair 里 legacy-grouped 迁移的拒绝闸 → repair 的 dismantle 不是原子的:先消耗收据关掉 cmux 行(破坏半),再在 tmux 侧对无 owner 标记的手工 grouped 视图 fail-closed 返回(建设半),且**所有失败分支静默 return 1** → 行没了、视图还占着 canonical 名字、create 的 ready gate 永久 defer。单看每一层都是「正确的 fail-closed」;组合起来 = 收编的善意成为破坏的授权。

这就是为什么本单的验收必须是结果导向的(§6),并且交付一个机器判官(`--verify-sidebar`)让「侧栏全且对」变成可断言、可回归的不变量,而不是靠人眼。

## 4. 三个观察的统一解释(issue 要求:必须同时解释 ①②③)

一个机制解释全部三条(逐条证据在 research.md §3-§4):

| 观察 | 解释 |
|---|---|
| ① 原生 4 个为何活 | 走了完整 create 路径:A1 视图 + committed 收据 + 拓扑不变量匹配 → repair 从不碰它们 |
| ② 手工正确形态 9 个为何 15 分钟死 | 正确形态 = 恰好能被 FLY-1605 收编(title/command 与 canonical 文法逐字一致)→ 数个 tick 后拿到 committed 收据 → repair 的迁移闸解锁 → dismantle 消耗收据关行 → tmux 半失败 → 永不重建。23:30 建、23:34 被关(`workspace:67-76`,审计日志实锤),「15 分钟」= 收编需要的 2-4 个 additive tick + 二次确认防抖 |
| ③ Cass 带 window-index 的 1 个为何(暂时)活 | `:5` 后缀使 surface title ≠ canonical raw 文法 → `complete_title_migration` 永远无法 commit → 收据卡在 prepared → repair 的 dismantle guard 只认 committed → **拆不动它**。它以「卡死」的方式幸存 —— 今天它(ws:60)正是 flywheel-cos-lead 无法收敛的直接阻塞物 |

**H1 判定(attach target 带 window index 是幸存差异):机制上成立,但不是 tmux 语义,而是收编文法失配的副作用 —— 幸存 ≠ 健康,它同时是 wedge。禁止把「带 index」当保护手段(与「pin 不是护身符」同理)。**

**H2 判定(新 runner 起跑触发 reconcile 剪掉非 ledger 条目):字面不成立 —— 生产代码里所有清理器对 lead-titled unledgered 行一律 preserve + 告警,从不清除**(`dedup`/`ghost` 在 A1 模式直接关闭;stock reaper 只认 runner 文法 title;dismantle 对 unledgered 同名行逐字拒绝)。时间吻合是因为 kill 波次由 60s additive tick 驱动,而 runner 起跑同样激发 tick 活动。**真实机制与 H2 相反:不是「不认 ledger 的被删」,而是「先被收编进 ledger、再被自己的收据合法处决」。**

## 5. 「pin 不是护身符」的机制确认

keeper 选择(`select_title_keeper`)里 pinned 只是**平局裁决的第 2 优先级**(receipt rank 之后);而所有破坏路径(dismantle / duplicate close / reconcile-view-dead)根本不读 pinned 字段。pin 只影响「谁当 keeper」,不影响「会不会被关」。方案层面禁用 pin 作为保护机制 —— 与 issue 裁定一致。

## 6. 设计方向(五件事,全部由验收条款反推)

| # | 方向 | 对应验收/裁定 |
|---|---|---|
| Fix 1 | **迁移原子化**:prove-before-consume —— dismantle 在消耗收据前必须先证明 tmux 半可完成(或干脆建设先行);所有静默 return 1 的失败分支必须落带原因的日志 | 「9 个消失」根因;结果验收的前提 |
| Fix 2 | **restored-row 常驻收编**:cmux 重启恢复出的 unledgered 同名行(view 缺席形态)可被自动收编 + self-heal 重挂;死 title 的 lead 行可被自动清除 | 「每次 cmux 重启重新武装」;「活 session 必有行、死 session 必无行」 |
| Fix 3 | **`--rebuild-views --handover` 运维通路**:骑 FLY-1482 已落地的 claim/让位窗口,新 mode=`ops_rebuild`,per-title 事务 + 全程审计 + 默认 dry-run | scope 第 1 条;「显示层单一写者或仲裁」;手修裸命令从此非法 |
| Fix 4 | **`--verify-sidebar` 只读判官**:活 window ↔ 侧栏行 ↔ pane 真活(pane_pid 相等 + 非裸 shell)三方对账,exit code + 报告 | 结果验收的机器化;QA drill 的判分器 |
| Fix 5 | **mismatch 告警 per-title episode 去重限频**(状态变化才报 + 周期汇总),类不静音 | Tadashi 裁定 #2 唯一允许的降噪形态 |

## 7. 明确不做

- 不改 FLY-913 部署护栏(ops 通路完全绕开 bootout,护栏无需碰)。
- 不整类静音 Invariant mismatch(只做 Fix 5 允许的去重限频)。
- 不做 FLY-1578 plan §17.2 的七项基建补课 —— Fix 1 的 prove-before-consume 使其中 R5#5/R5#6(settlement predicate / construction recovery 驱动者)不再被本单路径依赖;§17.3 的 S0 spike(unlink-window 非破坏迁移)对现存 fleet 已无对象(grouped 视图已清零),其结论并入 Fix 1 的形态选择。
- 不修 alert 投递链(今天 `optional alert library unavailable; alerts disabled` + cmux_cleanup 全部 dead-letter 是真缺陷,但归 FLY-1577 家族 —— 本单验收因此**不得**依赖告警送达,只验产出)。
- 三个 launchd job 真失败(growth-mufasa / v2-scheduler / codex-infra-bot)不在本单(issue 原文即如此)。
- FLY-1570 的「有序回填 writer」拆除(msg 36a78232)是另一子系统(episode 账本),仅作背景,不进本单 scope。

## 8. 与上游文档的关系

- FLY-1578 exploration/research 的**根因(授权收据死锁)与收编取证框架(C1-C4)全部沿用**;其 plan.md 是 CHANGES REQUESTED 的诊断件(见同目录 LANDING-NOTE.md),本单不继承其 §5 崩溃安全面的实现方案,只继承其结论与约束(代次翻盘 → 收编必须常驻;mutator lease 单写者;告警只验产出)。
- 本单新增的、上游没有的事实:**dismantle 非原子 + 建设半静默失败**(上游只看到「拒绝迁移」,没看到「迁移到一半」);**cmux app 重启会自动恢复侧栏行**(unledgered 行的第二来源,比手工重建更常态);**FLY-1605 收编与 repair 的接缝缺陷**。
