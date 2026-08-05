# FLY-1596 cmux legacy grouped → A1 迁移 + 运维重建合法通路 — 调研

Issue: FLY-1596 (https://linear.app/geoforge3d/issue/FLY-1596/cmux承接1578-legacy-grouped-a1-迁移-运维重建-cmux-视图的合法通路现在缺口)
日期: 2026-08-04
基于: exploration.md

取证对象:`scripts/flywheel-cmux-sync.sh`(7617 行,含 FLY-1482 handoff,main 已合入)、
生产 watcher 日志 `/tmp/flywheel-cmux-watcher.log`(17MB,跨 08-03 10:45 → 08-04 18:58,含 08-03 深夜完整审计)、
账本 `~/.flywheel/state/cmux-view-ledger`、live tmux/cmux 清单(全部只读)。

---

## 1. 调研要回答的四个问题

1. 08-03 夜「9 个正确形态 workspace 15 分钟消失」的**确切**机制链是什么?H1/H2 谁真谁假?
2. 今天(08-04 晚)的现场到底什么状态 —— 哪些收敛了、哪些卡死、卡死的形式化定义?
3. 现成机器有哪些可复用?运维通路缺的到底是哪一块?
4. 「侧栏永远全且对」拿什么当机器判据?

---

## 2. 今天的现场(2026-08-04 18:57–18:59 实测,三方对账)

**tmux 侧**:server 于 08-04 10:37 重启(全部会话 created Aug 4 10:37+,窗口 ID 从 @800+ 段跌回 @0/@2xx 段)。`flywheel` 源会话 14 个 lead 窗口全活(`pane_dead=0`)。**grouped 视图 0 个** —— 所有存活的 `cmux-*` 视图都是 1 窗口无 group 后缀的 A1 形态。

**cmux 侧**:当前代次 `16777230:481313503:1785814861`(socket 生于 **08-03 21:41:01** —— cmux app 上次重启点)。29 个 workspace。

**账本**:当前代次 committed 行覆盖今晚已收敛的 lead(ws:106/138→158 段);另有 4 条陈旧代次(07-23)行与若干 prepared 行。

**对账结果 —— 15 个 lead title 三分**:

| 状态 | title | 形态 |
|---|---|---|
| ✅ 已收敛 10 个 | eng-lead, product-lead, claude-infra, codex-infra, geoforge3d-product, joycon, belle, tidal-sub, tidal-cos, tidal-content | A1 视图 + committed 收据 + 行在侧栏。全部是今晚 18:48–18:59 watcher **自动**重建的(belle 18:58:17 建、18:58:50 前后完成改名,全程无人工) |
| 🔴 卡死 W1 形态 4 个 | growth-rafiki(ws:1), geoforge3d-ops(ws:2), geoforge3d-cos(ws:3), growth-reflection(ws:13) | cmux app 08-03 21:41 重启时**自动恢复**出的侧栏行(ref 极小 = app 启动瞬间铸的),**unledgered**(收据是代次键控的,重启即全废)。源窗口今活、视图缺席、行的 surface 挂空(侧栏可见但 pane 是死/空的) |
| 🔴 卡死 W1' 形态 1 个 | flywheel-cos-lead(ws:60) | Cass 带 `:5` window-index 的行:收据卡 **prepared**,surface title 先后 = `...cos-lead:5`(08-03)→ `~`(今天,旧 tmux 死后回落占位符),`complete_title_migration` 每 tick `surface drift ... preserving receipt` 死循环 |

**mismatch 现状**:日志全文 45490 条 `Invariant mismatch`,最后一条 **10:35:39**(tmux 重启前 2 分钟,belle grouped=1 members=17 个旧窗口)。重启后**零条** —— issue 的「mismatch 因现实改变而消失」这半句已被重启意外兑现;剩下的是 5 个卡死 title 每 tick 刷的 `unledgered cleanup refused ... manual resolution required` / `prepared title migration deferred`。

**告警链现状**:watcher 启动即 `WARN: optional alert library unavailable; alerts disabled`,且每条 cmux_cleanup 告警都 `delivery failed rc=2` + `dead-lettered`。**上面所有 refused 告警没有一条到过人眼前**(FLY-1577 家族,不在本单 scope,但本单验收因此不得依赖告警送达)。

## 3. 08-03 夜的完整机制链(审计日志实锤)

### 3.1 kill 波次 —— 全部有名有姓

`close_workspace_by_ref`/`close_ledger_workspace_ref` 是所有关闭的单一咽喉,每次落 `[audit]` 行。08-03 当天 lead 行的 close 波次(节选,同日志行号):

```
11:02:14-11:02:29  ws:2-17 + ws:2354        reason=view-invariant-mismatch   (10 个 lead)
21:14:21-21:14:42  ws:2458-2467             reason=view-invariant-mismatch   (9 个 lead;旧 app 代次末班)
—— 21:41 cmux app 重启,ref 归零,恢复行 ws:1/2/3/13 铸出 ——
22:16:18-22:26:24  ws:5-31                  reason=view-invariant-mismatch   (9 个)
23:03:01-23:07:18  ws:36-46                 reason=view-invariant-mismatch   (10 个)
23:16:02-23:16:03  ws:59-61                 (2 个)
23:34:24-23:34:36  ws:67-76                 reason=view-invariant-mismatch   (9 个)  ← Cass 23:30 那批,建成 ~4 分钟被关
```

`reason=view-invariant-mismatch` = `repair_view_invariants()` 的迁移分支调用 `dismantle_view_display()`(flywheel-cmux-sync.sh:5745)。**能走到这一步的前提是账本里有当前代次 committed 收据**(5735-5743 的拒绝闸)——收据从哪来?

### 3.2 收据来源 = FLY-1605 title 收编

`reconcile_workspace_titles()`(4472)对每个活的受管窗口:同 title/同 canonical-raw-command 的 workspace 行 → `authorize_stock_candidate`(拓扑证明,grouped 视图因 `title_source_authorized` 4274 的 grouped 分支——`session_group == source`、无 owner、无 marker——**通过**)→ 铸 prepared → 改名 → `complete_title_migration` commit。手工重建的行只要 title/command 与 canonical 文法逐字一致,**几个 tick 内必被收编成 committed**。这是设计内行为(收编本身正确);问题在收据被谁消费。

### 3.3 dismantle 非原子 —— 破坏半成功、建设半静默失败

`dismantle_view_display()`(5034)顺序:
1. **先**逐 ref `close_ledger_workspace_ref`(5102-5105)——关 cmux 行 + 删账本行(4025)。**收据在这里被消耗。**
2. **后**处理 tmux 侧:`_view_shell_owned_for_title`(5112)→ grouped 则 `escrow_view_session`(5117-5119,把 grouped 视图改名挪出 canonical 名)。

08-03 夜每一波的实况(belle 23:34 为例,日志连续两行):

```
23:34:36 [audit] guarded close workspace=workspace:70 title=personal-assistant-belle-lead reason=view-invariant-mismatch
OK workspace:70
23:34:37 WARN: invariant repair deferred for personal-assistant-belle-lead (no ledger authority)
```

第 1 行 = 破坏半成功;第 3 行 = dismantle 返回 1(repair 5750-5753 的 else 分支)——**tmux 半失败了,且日志标签失真**(此刻收据刚被它自己消耗掉,「no ledger authority」是果不是因)。失败点在 escrow 链上:`escrow_view_session`(4977)的 set-option snapshot guard(`_tmux_session_snapshot_guard` 3370 要求 sid|grouped|active|owner|marker|**members** 全量逐字相等 —— grouped 视图的 members = 整个 14+ 窗口共享池,活系统上窗口churn/active 漂移即失配)或 `_inventory_upsert`(4744)—— **两处失败分支全部静默 return 1,零日志**,keeper inventory 文件至今不存在(escrow 从未成功过一次)。确切子原因日志不可辨 —— 这本身就是缺陷清单的一项。

### 3.4 尾声:ready gate 永久 defer

行关掉、grouped 视图仍占 `cmux-<title>` canonical 名。下一 tick `create_workspace_for_window`(5285):行不存在 → 继续;视图存在 → 跳过重建(5364);ready gate `_linked_view_matches`(5389,要求 grouped=0)必失败 →

```
23:34:47 WARN: cmux-personal-assistant-belle-lead failed isolated topology ready gate — deferring create
```

全日志 **8073 条** ready-gate defer,每个受害 title 690–835 条。行从此不再回来 —— 直到有人再手建一个行,循环重演(21:14→22:16→23:03→23:34 四轮波次即四轮手工重建被逐一处决)。

### 3.5 H1 的机制(ws:60 实锤)

```
23:34:40 WARN: title migration surface drift ref=workspace:60
         expected_raw=env -u TMUX tmux attach -t '=cmux-flywheel-flywheel-cos-lead'
         observed=env -u TMUX tmux attach -t '=cmux-flywheel-flywheel-cos-lead:5'; preserving receipt
```

`:5` 使 surface ≠ canonical raw → `complete_title_migration`(4215)永不 commit → 收据停在 prepared → dismantle 的 close guard(`_ledger_close_guard` 3982 只认 `ledger_committed_ref`)失败 → **repair 拆不动它**。幸存 = 处决机器够不着,不是形态健康。今天它反而是 flywheel-cos-lead 收敛的阻塞物(W1' 形态)。

### 3.6 H2 的证伪(逐清理器排除)

A1 生产形态(`linked_view_enabled || view_invariant_enabled` 为真)下,对 **lead-titled、unledgered** 的行:

| 清理器 | 行为 | 证据 |
|---|---|---|
| `dedup_workspaces_by_title` | 整体关闭(1272-1274 直接 return 0) | 代码 |
| `reap_ghost_workspaces` | 整体转投 prepared 对账(1241-1249) | 代码 |
| `reap_unledgered_stock_workspaces` | 只认 runner 文法 title(`is_managed_runner_title` 1361-1364,显式排除 lead 窗口) | 代码注释 1358-1360 |
| `reap_orphan_workspace_pins` | 同上,runner 文法限定 | 代码 |
| `dismantle_view_display` 无收据分支 | 同名行存在 → **逐字 preserve** + `manual resolution required` 告警(5094-5099) | 今天 rafiki 等 4 行每 tick 刷这条 |
| `reconcile_existing_workspaces` strict 分支 | 只经 dismantle(exact-ref ledger authority),unledgered 同名行留给人工(5846-5848) | 代码 |

**没有任何路径清除「不认 ledger 的行」;真正的杀伤路径先把行收编进 ledger(3.2),再用收据合法处决(3.3)。** H2 的时间吻合来自双方都被 60s additive tick 驱动。

## 4. 两个 wedge 家族的形式化(设计的输入)

**W1(view 缺席 + 同名行无 committed 收据)—— 四重死锁:**
- create:同 title 行存在 → 5342-5349 提前 return(视图也因此永远不会被建);
- repair:视图缺席 → plan 行标 `absent` → 5716 跳过;
- dismantle:unledgered 同名行 → 5094 拒绝;
- 收编:`title_source_authorized` 需要视图拓扑(A1 匹配或 grouped 含窗)→ 视图缺席必失败(今天日志 `title stock topology proof refused`)。
来源两种:cmux app 重启自动恢复行(ws:1/2/3/13,**每次重启必然重现**);人工建行但没建视图。变体 W1' = 行有 prepared 收据 + surface 漂移(ws:60):比 W1 多一条死路(`reconcile_prepared_ledger`/migration 每 tick defer),同样四锁。

**W2(收据在手 + canonical 名被非 A1 视图占据 + tmux 半不可完成)—— 自毁迁移:**
dismantle 先消耗收据后失败(3.3),把 W2 转化为 W1 减一行(行没了)。触发条件:任何 receipted title 的视图是 grouped/手工形态且 escrow 链失败。08-03 夜四轮波次全是它。tmux 重启后现场暂无 W2 对象,但任何未来的手工 tmux 干预都能重造。

**推论:两家族互为再生产。** W2 的破坏半制造「行缺席」,操作员补行 → 变 W1;W1 的行被收编 → 变 W2。08-01 以来的全部现象(包括「越修越坏」的体感)都是这个二人转。

## 5. 现成机器盘点(哪些直接复用)

| 能力 | 函数(行) | 复用判定 |
|---|---|---|
| 让位窗口协议(claim 文件 + watcher yield/park + 回收 stale claim + 复归后 RESYNC bootstrap) | `maintenance_requested`(6827)/ `watcher_maintenance_checkpoint`(7354)/ `_read_qa_teardown_claim`(6799)/ `_reap_stale_qa_teardown_claim`(7097) | ✅ FLY-1482 已生产验证;**运维通路直接骑它**,只需新 claim 种类(mode 白名单 6781/7165 各加一词 + claim 文件名) |
| 单写者 mutator lease(incarnation 绑定、模式化、崩溃重建) | `acquire_mutator_lease`(7162)/ `run_mutator_once`(7393) | ✅ ops 模式作为一等公民进 mode 集合 |
| A1 视图原子构造(staging→claim,WAL 全程) | `create_or_replace_view_session`(5147) | ✅ 原样复用 |
| workspace 创建全链(存在检查→视图→ready gate→create→改名→收据→verify-attach) | `create_workspace_for_window`(5285) | ✅ 原样复用 |
| 收据事务(lease 断言 + 同代次同 title 判重) | `_ledger_upsert`/`_ledger_remove`(3879/3891) | ✅ 原样复用 |
| 收编取证(拓扑证明 + 双面 title 证明 + guarded 改名) | `title_source_authorized`(4274)/ `authorize_stock_candidate`(4321) | ⚠️ 复用但需扩一个形态:view-absent(W1)——现有两分支(A1 匹配 / grouped 含窗)都要求视图存在 |
| 裸 shell surface 复挂 | `self_heal_workspace_ref`(2530)/ `heal_send_attach`(2490) | ✅ W1 收编后的 surface 复活用它 |
| 只读预检 | `--probe-lease`(7599)/ `--list-lead-refs` | ✅ 判官命令的先例形态 |
| 审计咽喉 | `close_workspace_by_ref`(1204,含 DRY_RUN 短路) | ✅ ops 通路 dry-run 直接借 `FLYWHEEL_CMUX_DRY_RUN` 语义 |

**缺口清单(全部要新写/改):**
1. dismantle 的 prove-before-consume 重排(W2 根治);
2. escrow 链失败分支的带因日志(静默 → 可诊断);
3. W1/W1' 形态的常驻收编分支(含 lead-titled 死行清理 —— 「死 session 必无行」);
4. `ops_rebuild` claim 种类 + `--rebuild-views` 入口 + per-title 事务编排 + 审计报告;
5. `--verify-sidebar` 只读判官;
6. mismatch/refused 类日志的 per-title episode 去重限频。

## 6. 「侧栏永远全且对」的机器判据(Fix 4 的规格输入)

沿用 FLY-1578 research §5 的判别式并补「行↔窗」双向:对每个活的受管窗口 `(S, wid, T)` 与侧栏行集合:

1. **活必有行**:T 对应恰好 1 个 workspace 行;
2. **死必无行**:每个 lead/runner 文法 title 的行都有活源窗口;
3. **视图正确**:`cmux-T` 存在且 `grouped=0 ∧ active=members={wid} ∧ owner=S ∧ marker=0`;
4. **pane 真活**:`pane_pid(view:active) == pane_pid(S:wid)` 且 `pane_dead=0` 且 `pane_current_command` 非裸 shell;
5. **附着真实**:view session 至少 1 个 client(surface 真的 attach 上了)。

1-5 全过 = PASS(exit 0);任何一条 fail = 非零 + 逐 title 报告。QA drill 的判分器与运维日常巡检共用这一个命令。

## 7. 诚实标注的取证边界

- **escrow 失败的确切子原因不可辨**(set-option snapshot guard 失配 vs `_inventory_upsert` IO)——所有失败分支静默 return 1,keeper inventory 文件从未存在只证明「从未成功」,不区分败因。设计以「消灭整个失败族」(重排 + 带因日志)兜住,不押注单一子原因。
- 08-03 21:41 cmux app 为何重启未取证(不影响设计:恢复行的铸造是 app 行为,任何重启都会重演)。
- 「9 个」「15 分钟」的数字与审计波次(ws:67-76,9 行,23:34)吻合但 Cass 的建行时刻只有转述(23:30);不影响机制结论。
- 日志时间戳无日期(`log()` 只打 %H:%M:%S),跨日定位靠 `Watch mode:` 重启锚点 + 窗口 ID 段位推断;本文所有「08-03 夜」定位由 ref 段位(21:41 归零)双重锁定。
