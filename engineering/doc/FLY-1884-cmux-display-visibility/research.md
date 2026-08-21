# FLY-1884 cmux 显示层完整性 — 调研
Issue: FLY-1884 (https://linear.app/geoforge3d/issue/FLY-1884/cmux体验-镜像-session-重建后cmux-旧-tab-挂死旧连接渲染全空-应自动重连或标记失效)
日期: 2026-08-20
基于: exploration.md

本文是代码级核实记录:每个结论给出出处(文件:行,as-of 本分支 HEAD 3a335b295)与复核命令。行号会漂移,复核一律用 `git log -S` / grep 重定位。

## 1. 会过期的结论表(先读这个)

| 结论 | as-of | 过期条件 | 复核命令 |
|---|---|---|---|
| cmux 0.61.0 新建 workspace 默认名「Terminal N」(全局计数) | 2026-08-19, cmux 0.61.0 (73) | cmux 升级改默认命名 | `cmux version`;隔离实例 `new-workspace` 后 `list-workspaces` |
| 默认命名疑似异步(快读到空名,慢读到 Terminal N) | 未确证,仅日志间接证据 | implement/QA 用隔离 cmux 确证后以确证结论为准 | 见 §3.2 复现步骤 |
| `_prepared_rename_guard` 只认 None/""/~/provisional | 3a335b295 | 本单实施后即过期(这是要改的) | `grep -n '_prepared_rename_guard' scripts/flywheel-cmux-sync.sh` |
| `list-pane-surfaces` 可提供 create-time command/launch identity | **已证伪**,2026-08-19 cmux 0.61.0 | cmux 升级新增稳定 launch 字段后才可能重评 | `cmux --json --id-format both list-pane-surfaces --workspace <ref>`;见 `fixtures/cmux-0.61-surface-identity.json` |
| `new-workspace` 对象有不可复用 UUID,且 `list-workspaces --id-format both` 可把 UUID 与 ref/title 同帧回读 | 2026-08-19 cmux 0.61.0 | cmux CLI 输出/身份语义变化 | 自建 workspace 后运行 `cmux --json --id-format both list-workspaces`;见同 fixture |
| workspace:52 prepared 行卡死 growth-mufasa-lead | 2026-08-19 20:5x 实测 | 任何人手工修账本/重启 cmux 换 generation | `grep prepared ~/.flywheel/state/cmux-view-ledger; cmux list-workspaces \| grep mufasa` |
| Bridge 活跃名册 16 节点、5 个 implement 无窗 | 2026-08-19 20:5x 快照 | 分钟级过期(仅作类①活证据,不是设计输入) | `curl /api/sessions?mode=active` |
| `/api/sessions?mode=active` 字段含 identifier/session_role/adapter_type/issue_title/workflow_node_id | 3a335b295 生产 Bridge fe9e3de86 | Bridge API 改动 | 实测 curl + `grep -rn 'mode=active' packages/teamlead/src` |
| canonical attach 语法识别点 = 4 处消费 + 1 处生产 | 3a335b295 | 任何人改 build_attach_command | `grep -n "env -u TMUX" scripts/flywheel-cmux-sync.sh` |
| cmux 0.61.0 有原生 `respawn-pane --workspace --surface --command` 与侧栏 `set-status`/`clear-status` | 2026-08-20, cmux 0.61.0 (73) | cmux CLI 参数变更 | `cmux --help`;`cmux set-status --help` |
| watcher 日志起点 2026-08-18 19:48(更早已滚) | 2026-08-19 | 日志继续滚动 | `head -1 /tmp/flywheel-cmux-watcher.log` |

## 2. 关键代码座标(flywheel-cmux-sync.sh,9837 行)

| 机制 | 函数 | 行(约) |
|---|---|---|
| 发现层:扫 `flywheel` + `runner-*` 窗 | `get_tmux_agent_windows` | 571 |
| Bridge 名册只读消费(runner-orphan 告警) | `fetch_active_runner_roster` / `reconcile_runner_roster` | 971 / 1045 |
| exec-id↔窗 关联(`@flywheel_exec_id` window option) | `read_runner_tmux_exec_inventory` | 1011 |
| attach 命令生产(canonical 语法) | `build_attach_command` | 2406 |
| Lead 重连 helper 生产(模板) | `build_lead_attach_command` → `scripts/flywheel-lead-attach.sh` | 2440 |
| v2 Lead 幂等收敛(候选→keeper→改名→查重→heal) | `ensure_v2_lead_workspace` | 2593 |
| create 三步事务 | `create_workspace_for_window` | 6549 |
| 占槽阻断 | `ledger_rows_for_title` gate,"Rename-lag receipt already owns logical slot" | 6612 |
| rename 守卫(根因 2 主刀口) | `_prepared_rename_guard` | 4939 |
| 恢复分支(根因 2 第二刀口) | `reconcile_prepared_ledger` | 5471 |
| 自愈入口(要求 committed 回执) | `self_heal_one_workspace` | 3170 |
| 自愈 send 原语(bare-shell gate) | `self_heal_workspace_ref` / `surface_looks_like_bare_shell` / `heal_send_attach` | 2700 / 2261 / 2661 |
| 周期 sweep(60s additive tick + bootstrap + reopen) | `self_heal_sweep_all` | 3270 |
| view 不变量修复(dismantle+rebuild 重建路径) | `repair_view_invariants` | 6832 |
| view-dead 清扫(另一条重建/消失路径) | `reconcile_existing_workspaces` | 6968 |
| 窗死→关 tab(类①消失路径,30s 延迟) | `mark_for_cleanup` / `process_pending_cleanups` / `cleanup_workspace_for` | 7128 / 7154 / 2118 |
| 保守清扫(300s) | `cleanup_stale_conservative` | 7356 |
| 账本事务 | `_ledger_transaction` / `_ledger_upsert` / `ledger_committed_ref` | 3895 / 4003 / 4022 |
| 候选识别(title==目标 或 title==attach 原文) | `workspace_title_candidates` | 5333 |
| restoredv1(app 重启 restore 的收养,FLY-1596) | `recover_restored_transactions` / `adopt_restored_workspaces` | 4623 / 4746 |
| ops 工具(operator 半径) | `run_rebuild_views` / `run_verify_sidebar` | 8360 / 8426 |

常量:`VIEW_PREFIX="cmux-"`(:42);`CLEANUP_DELAY_SECONDS=30`(:54);create dedup TTL 30s(:2329);保守清扫 300s。

## 3. 根因 2 的机制核实

### 3.1 三处「未命名」判定都不认「Terminal N」

1. `_prepared_rename_guard`(:4948-4955):`w.title in (None,"","~") or w.title == provisional` 恰为 1 才放行 rename。
2. `reconcile_prepared_ledger` observed 分类(:5526-5576):`__NULL__|provisional` 重驱、精确 title 补迁移、`__ABSENT__` 永久 preserving、**其余(含 Terminal N)落 `*)` drift 永久 preserving**。
3. `_rollback_unreceipted_guard`(:4916-4922):同样形态,失败路径的 rollback 也会因默认名拒绝(残留未回滚 workspace)。

provisional = `build_attach_command` 原文(create 路径传 `$attach_cmd`,恢复路径重新构造)。即代码假设「未命名 workspace 读回 NULL/~ 或命令原文」——与 cmux 0.61 实测「Terminal N」不符。

### 3.2 「为什么有的 create 成功」——异步命名假设与复现步骤

日志同 generation 内既有成批 drift(Terminal 17..26)又有 ~40 条 committed。假设:cmux 在 create 后异步补默认名;守卫读得快(空名)→放行,读得慢(已命名)→拒绝。重启潮 = 宿主 load 高 + workspace 成批重建 → 读得慢 → 成批卡死。
复现(implement/QA,隔离 cmux 实例,勿碰生产 socket):
```
cmux --socket <隔离socket> new-workspace --command 'sleep 999'
立即 + 200ms 后各读一次 list-workspaces title,对比是否从空/缺失变为 Terminal N
```
无论确证结果如何(异步 or 一开始就命名),修法相同:把 `^Terminal [0-9]+$` 纳入 ref-pinned 语境的「未命名」集合。若「一开始就命名」,则现网 committed 的来路需要另一个解释(如旧版本 cmux 行为),QA 时一并核。

### 3.3 占槽与自愈饿死

- create gate(:6612):`ledger_rows_for_title` 有任何行(prepared 或 committed)即 defer——prepared 卡死 = title 永久占槽。
- `self_heal_one_workspace`(:3218):非 committed 回执 → `cmux attach heal refused` 告警 + skip——prepared-stuck 的 tab 无自愈资格。
- absent-ref prepared(:5527-5531):「preserve for operator diagnosis」无界。workspace:52 每 tick 刷 `prepared ledger ref absent … preserving` + `Rename-lag … create deferred`(现网日志,2026-08-19 全天)。

## 4. 根因 1 的机制核实

- surface 根进程 = attach 命令本身(`new-workspace --command`)。view session kill → attach 退出 → surface 死。cmux `surface-health` 返回 `in_window:false` 一类状态可观测(实测 workspace:87)。
- send-heal 三道 gate 在 surface 死亡态的行为:`workspace_terminal_surface_ref` 可能无 terminal surface(rc=1 skip);`surface_looks_like_bare_shell` 读到非 shell 尾行(rc=1 fail-closed)或读不到(rc=2,仅 reopen 升级态放行);全部到不了 send。**结论:send-heal 结构性覆盖不了 surface 死亡,只覆盖「裸 shell 待注入」**。
- 对照:`flywheel-lead-attach.sh`(FLY-1663)循环 attach + trap INT/TERM/HUP,session 换代 2s 重连,close workspace 即停循环——生产已验证的形态,恰好就是 runner 侧缺的那块。
- app 重启 restore 后 surface 是裸 shell(FLY-254 的存在理由),reopen sweep 往里 send——**helper 化后这条注入路径仍需保留**,注入内容改为 helper 调用。

## 5. 显示层(founder 三类)的数据源核实

- `/api/sessions?mode=active`(生产实测):字段 `identifier, issue_title, issue_url, session_role, workflow_node_id, status, adapter_type, session_stage, heartbeat_at, started_at, last_activity_at, pr_number, runner_model, worktree_path, session_params, …`。`session_params.pane_loss_generation.window_id` 仅 Claude 体有(FLY-1628 launch 凭证),不可作为「有没有窗」的判据;**窗存在性判据用现成的 `read_runner_tmux_exec_inventory`(`@flywheel_exec_id` window option 全局扫)**。
- watcher 已有该 API 的认证消费(loopback + TEAMLEAD_API_TOKEN,2s 超时,fail-indeterminate 不动存量)。
- 终态摘要需要的「最近终态」查询现网**不存在**(mode 仅 active/其他);需要 Bridge 侧加只读查询(mode=recent_terminal&hours=N 或等价),字段沿用现有行投影。这是本设计唯一的 Bridge 改动面。
- 现网快照(2026-08-19 20:5x):active=16,其中 5 个 implement 无窗(ship_parked×4 + running×1)= 类① 活证据;QA 体窗名形如 `FLY-1859-qa-claude-Opus-…`,由 `runner-flywheel` 承载,发现层可见(类④ 的不可见全部归因根因 2)。

## 6. canonical attach 语法的影响面(helper 化要动的识别点)

生产(1)+ 消费(4),`grep -n "env -u TMUX" scripts/flywheel-cmux-sync.sh`:
- :2417 生产(runner attach;:2435 QA 用 bin 覆写形态;:2445 Lead helper 形态,不动)
- :1355 `normalize_stock_workspace_title`(stock 归一)
- :1379 `stock_workspace_records`(raw 形态识别)
- :1397 前缀判断(stock 记录分类)
- :6269 `dismantle_view_display` 内 raw_re(未账本 same-title 识别)
另:provisional 传参(create :6674/:6734;reconcile :5514;loser close :5008)都以 build_attach_command 输出为值——生产端换语法后这些自动跟随,但**旧语法的存量 surface/标题在迁移期仍会出现**,识别端必须双语法并认。test-cmux-sync.sh(10380 行)内嵌该语法的 fixture 需同步。

## 7. cmux CLI 控制面(0.61.0,与设计相关子集)

`new-workspace [--command]` / `rename-workspace` / `rename-tab` / `close-workspace` / `list-workspaces (--json)` / `list-pane-surfaces` / `read-screen` / `send` / `respawn-pane` / `select-workspace` / `refresh-surfaces` / `surface-health` / `set-status` / `clear-status` / `notify` / `trigger-flash` / `capabilities`。
- `surface-health` 可作 QA 断言用(surfaces[].in_window 等),不引入生产周期依赖。
- `respawn-pane --workspace <ref> --surface <ref> --command <cmd>` 是精确 surface 的原生重建原语;无需 close workspace/new surface,也不会换掉已回执的 workspace ref。
- `set-status <key> <value> --workspace <ref>` 会在侧栏 tab 行显示 pill,`clear-status` 可恢复;适合把「已失效/等待重建」从空白变为明确状态。

## 8. 邻近前置单(半径确认,均不重做)

- FLY-1663:Lead helper + 私有 socket roster(模板)。FLY-1672:stale window_id 回落误判修复(已合)。FLY-1596:restoredv1 + ops rebuild/verify-sidebar(operator 工具,保留)。FLY-1482:mutator lease/QA teardown handoff(watcher 让位窗口 = 重启潮空档的来源之一,机制保留)。FLY-254:reopen sweep(保留,send 内容改 helper)。FLY-1605:tab/workspace 双改名 + title migration(B1 放行后继续复用其 `complete_title_migration`)。
- 手工修复痕迹:founder 2026-08-19 手工 rename + 账本 committed(workspace:49/55/56/59/60,备份 /tmp/cmux-view-ledger.bak-*)——B1/B2 落地后这类手术不应再需要。

## 9. 风险面清单(供 plan 展开)

1. B1 的安全边界:默认名放行**仅限 ref-pinned prepared 行语境**;candidates/所有权铸造一律不认默认名(founder 自己的 Terminal tab 不可误收)。
2. helper 化迁移:存量旧语法 surface 与新 helper 并存期,识别端双语法;绝不批量 close/重建存量 tab(founder 正在用)。
3. placeholder 键(identifier+role)与窗名(含 vendor/model/slug)不同形态,窗镜像清扫路径(`cleanup_stale_workspaces`/`reap_unledgered_stock_workspaces`/`cleanup_stale_conservative`)必须结构性豁免节点 tab(靠 node-registry,不靠标题猜形)。
4. Bridge 名册不可用时(indeterminate):node-presence 整相冻结(不建不关),沿用现有 roster fail-closed 纪律。
5. tab 总量:placeholder 有上限(env,默认 30)+ 超限告警,防名册异常撑爆侧栏。
6. watcher 是单写者(mutator lease):新增阶段必须在 lease 半径内,让位窗口可中断可重放(既有纪律)。

## 10. Implement hard-gate 实测结论(2026-08-19)

原计划 §3.1 要求先证明 `list-pane-surfaces` 存在稳定 surface-command 字段。真机
0.61.0 返回的 surface 对象只有 `id/index/ref/selected/title/type`;长期已 attach
的 surface title 是当前 tmux/window title,而 prepared abort 的 surface title 是
`Terminal N`,并没有 launch argv。这个字段既非稳定命令身份,也无法在最需要的
卡死恢复形态证明 ownership,所以原假设作废。

同一轮实测确认 cmux 已有更强的原生身份:每个 workspace 有 UUID;
`new-workspace` 返回该 UUID,`list-workspaces --id-format both` 同帧返回
`id/ref/title`。Lead 通过 question gate
`cf86a8d6-6d6f-4499-aaff-382267fb317e` 批准 plan R9 改用该 UUID 做 prepared
mutation-boundary 证明,legacy 无 UUID 行只老化、不重命名。详细链路与必测负例见
plan §3.1 的 implement hard-gate 修订。

## 11. 2026-08-20 生产证据增补:新建即空白 + no-PTY 死循环

Lead 转达的最新生产取证把半径从「session 换代后重连」扩到「任何新建/恢复的 workspace 必须最终有活 pane」:

- 2026-08-20 08:34 新出现的 `workspace:42`/`workspace:43` 底层 `cmux-*` tmux session 都存在,但 pane 反复显示 `open terminal failed: not a terminal`;其中多次 attach 为人工注入,不能恢复。
- app reopen 后曾有 25/31 个 workspace 空白;surface 存在但 attach 命令未进入。普通 runner/raw attach 与 v2 private Lead helper 两条路径都有证据,不能只修其一。
- 现有普通路径 `create_workspace_for_window` 虽有 3 次局部重试,但周期/reopen sweep 会继续无界 `send`;v2 `_v2_lead_heal_surface` 每轮只要还是 bare shell 也会再 `send`。两者都没有持久尝试计数、dead-letter 或重建终局。
- `surface_looks_like_bare_shell` 只能识别干净 shell;`not a terminal` 形态被当作「非 shell,不动」,因此现有自愈结构性不可能收敛。
- 若底层 linked/private session 不存在,普通路径会在解析 exact ref 前直接 return;留下的 workspace 没有 app 内可见的失效标识。

故障可以用已有证据最小分两类:

1. **A / clean bare shell**:仍有 PTY,`send` 可能恢复;只允许有界 N 次,每次在 mutation 前持久预占计数。
2. **B / no-PTY**:`read-screen` 精确含 `open terminal failed: not a terminal`;跳过 `send`,直接进入 dead-letter 并在原 workspace/surface 上 `respawn-pane --command <canonical attach>`。

一个共享持久表足够:`generation|ref|title|kind|attempts|phase|first_epoch|last_epoch|last_round`,`kind=view|v2`,`phase=retrying|unclassified|rebuild-issued|rebuilt|dead`。重试身份刻意不含 surface ref,避免 respawn 后 surface 换代重置额度;当下 surface 仍在 mutation guard 中精确重证。表内 mutation 授权仍必须每次重证 exact committed receipt/workspace title/surface/generation/0 clients,并在发命令前先持久化 attempt 或 `rebuild-issued`;进程崩溃最多导致少做一次,不能导致无界重放。底层 session 缺席、重建仍未活或状态表不可用时,用 cmux 原生 status pill 显示失效而不继续写 pane。

## 12. 扩域设计复审补证:`mode=active` 不是完整 live 名册

StateStore 的现有集合逐字核对:

- `getActiveSessions()` = `running|ship_parked|awaiting_review|approved_to_ship`。
- `getReadoptCandidateSessions()` 额外含 `design_done`,其注释已有同类 postmortem:design holder 停在非终态 `design_done`,恰被 active query 漏掉。
- workflow FSM 还声明 `pending` 与 `design_done` 都有出边,所以二者都不是终态;`design_done → running` 是 durable rework 的合法回边。
- `recent_terminal` 使用 `OPERATIONAL_TERMINAL_STATUSES`,不会也不应包含这两个 live 状态。

因此 “active + recent_terminal” 不是全集。若节点从 running 转 design_done,现有分支会连续两轮缺席后伪造 last-known terminal-summary,把仍活着的 holder 标成「已结束」。修订采用专用 `mode=live` 六态投影:`pending|running|ship_parked|awaiting_review|design_done|approved_to_ship`;原 `mode=active` 不改,避免影响已有调用者。live 与 terminal 两边都没有 exact 行只能证明**未知**,不能证明终态:两轮 debounce 后显示层进入有界的 `unresolved-summary`,明确写「失联·无法确认终态」并纳入 summary cap/TTL。另用 `LIVE ∪ OPERATIONAL_TERMINAL ⊇ WORKFLOW_TRANSITIONS keys` 的 CI 守卫防下一次状态集合漂移。

同轮复审还指出 attach 最小 A/B 集之外存在可读非 shell/空屏/不可读残余类。它没有足够证据安全 send 或 respawn,故定义 C 类:零 pane mutation,首轮中性 status pill;只有连续两次 determinate additive round 且达到 min-age 才转红并告警,避免 app reopen 时几十个瞬态主体同时告警。重试额度键移除 surface ref,避免 `respawn-pane` 若换 surface identity 时重新获得额度。

## 13. 扩域复审 R2 补证:guard 拒绝也必须有活性出口

带 UUID 的 prepared 行有四种可观测结局:ref absent、普通 drift、legacy 默认名、以及**默认名仍在但 UUID/ref/title/generation guard 持续拒绝**。最后一种在原 R11 三个桶之外,会永久占逻辑槽;且现有实现的 guard failure `return 1` 会中断整轮,让后续所有行一起饥饿。仓内 `same-ref-new-uuid` 测试已证明该状态可构造,只是只断言了「不误 rename」,没有断言最终释放。

R12 把它作为 B3(c) authority-mismatch:跨 round/min-age 有界计数,到限只删 prepared receipt、绝不碰 workspace、独立 episode 告警;单行 guard 拒绝改为 `continue`,不再毒住同 pass。另收紧两处证据边界:长驻 node helper 的动态 surface title 未经真机证明,所以 committed close/TTL 只要求 terminal surface 存在而不比较 title;prepared migration 才使用即时 surface title。失联节点用 `unresolved-summary` 有界承载,不会永久钉住 mirror 或绕过 cap/TTL。

R3 APPROVED 的 advisory 再收窄 B3(c):guard 只有在所有读都成功且 exact UUID/ref/title match 数明确不为 1 时才产出 conclusive mismatch;cmux JSON/账本/解析不可读或 generation 换代均是 indeterminate,不推进老化。summary cap 淘汰与 TTL/manual close 同半径:close 成功后清 exact receipt、registry row 与 status file。
