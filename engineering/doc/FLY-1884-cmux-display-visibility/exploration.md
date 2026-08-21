# FLY-1884 cmux 显示层完整性 — 探索
Issue: FLY-1884 (https://linear.app/geoforge3d/issue/FLY-1884/cmux体验-镜像-session-重建后cmux-旧-tab-挂死旧连接渲染全空-应自动重连或标记失效)
日期: 2026-08-19
基于: 无

## 1. 问题是什么

三层,由小到大:

1. **根因 1(issue 原始现象)**:runner 的镜像 tmux session(`cmux-<窗名>` view session)被重建后,cmux app 侧旧 tab 的 surface 还挂着重建前的死连接 → 打开渲染完全空白。founder 由此误判「QA 下线了」。
2. **根因 2(founder 2026-08-19 已定位)**:cmux-sync 的 rename 事务成批卡在 `prepared`(workspace 建好但顶着默认名「Terminal NN」),`reconcile_prepared_ledger` 把默认名误读成"标题漂移"永久 preserving,同时 prepared 回执占住逻辑槽位阻断重建(`Rename-lag receipt already owns logical slot`)——死循环。
3. **founder 硬要求(验收基线)**:「不管是他们那边的问题,还是他们没有问题、只是 CMux 没有显示,你都需要把 CMux 显示层做好。我需要那些活跃的节点,都可以在 CMux 上看到才可以。」三类实测「看不见」:①完工停驻体释放窗口后应显示终态摘要;②额度墙间隙无活体应显示「等待重生」;③remote-control 无窗形态应有可见表示。另:Bridge 侧 QA/generic 体的 tmux mirror 都在但 founder 侧看不到(7 条)。

## 2. 现状架构(审计所得,全部一手核实)

```
tmux 层(default server)
  flywheel session         — Lead 窗(含 codex-TUI carrier,如 growth-mufasa-lead @396)
  runner-<project> session — Runner 窗,窗名 = <FLY-XXXX>-<role>-<vendor>-<model>-<slug>
        │  每个 agent 窗 ↓ watcher 建独立 grouped view session
  cmux-<窗名> view session — 单窗,指向同一 window id(= issue 里说的「镜像 session」)
        │  ↓ cmux workspace 的 surface 里跑一次性命令
cmux app(brew cmux 0.61.0,unix-socket CLI 控制面)
  workspace(tab)= title 应等于窗名;surface command = `env -u TMUX tmux attach -t '=cmux-<窗名>'`
```

驱动者:`scripts/flywheel-cmux-sync.sh`(9837 行 watcher,launchd KeepAlive,mutator lease 单写者)。
- 事件驱动(tmux hooks → event file)+ 60s additive tick。
- create 三步事务:`new-workspace --command` → 账本 `prepared` 行(generation|ref|title)→ `rename-workspace` + `rename-tab` → 账本 `committed`。账本 = `~/.flywheel/state/cmux-view-ledger`。
- 自愈:`self_heal_sweep_all`(每 additive tick)→ 0-client + bare-shell 双 gate → 往 surface 里 send attach 命令;FLY-254 reopen sweep 处理 app 重启后的未渲染 surface。
- v2 Lead(claude-private)另有一条独立 reconcile:surface 命令是 **`flywheel-lead-attach.sh <socket>` 重连循环 helper**(FLY-1663),session 换代自动 2s 重连——**runner 侧没有这个,是裸一次性 `tmux attach`**。

## 3. 审计结论:两个根因的完整机制链(带实证)

### 3.1 根因 2 其实是「每次 create 都在赌一个竞态」,不只是崩溃残留

cmux 0.61 新建 workspace 会**默认命名「Terminal N」**(全局计数器)。而 create 事务的 rename 守卫 `_prepared_rename_guard`(flywheel-cmux-sync.sh:4939)只接受 pre-rename 标题 ∈ {`None`/`""`/`~`/provisional(attach 命令原文)}——**「Terminal N」不在其中 → 守卫拒绝 → rename 不执行 → 永卡 prepared**。恢复路径 `reconcile_prepared_ledger`(:5471)的 observed 分类同样只认这三种形态,「Terminal N」落 catch-all「title drift; preserving」。

实证(/tmp/flywheel-cmux-watcher.log,2026-08-18):
- 21:40:15 起十连 `WARN: prepared ledger title drift ref=workspace:29..38 expected=FLY-XXXX-... observed=Terminal 17..26; preserving` + 同 tick `Rename-lag receipt already owns logical slot; create deferred` ×10。
- 19:54:59 GC 掉**上一个 cmux generation 的几十条 prepared 行**(workspace:60/83/84/143/…/686)——说明该病在旧 generation 早已慢性存在,不是单次事故。
- 当前活案例:账本第 7 行 `prepared|…1787108044|workspace:52|growth-mufasa-lead`,ref 已不存在(`prepared ledger ref absent … preserving` 每 tick 刷),`cmux list-workspaces` 里 **growth-mufasa-lead 至今没有 tab**。

为什么有的 create 又能成功(账本里有 ~40 条 committed)?最可能是**默认命名是异步的**:读得够快时标题还是空 → 守卫放行;宿主高负载/重启潮时读得慢 → 标题已变「Terminal N」→ 拒绝。这正好解释「平时偶发、重启潮成批」——founder 最依赖 cmux 的时刻恰好最容易坏。(异步假设在 implement/QA 阶段用隔离 cmux 实例确证;设计对两种成因的修法相同。)

### 3.2 根因 1:一次性 attach 死亡后,自愈机器结构性无能为力

surface 的根进程就是那条 `tmux attach`。view session 一被重建(kill+recreate),attach 进程退出,surface 随之死掉/关闭 → tab 空白。此后:
- `self_heal_one_workspace`(:3170)要求 **committed 回执**(`ledger_committed_ref`)——prepared-stuck 的 tab 连自愈资格都没有(**两个根因串联**:根因 2 直接饿死根因 1 的自愈)。
- 即便有回执,`surface_looks_like_bare_shell`(:2261)要求屏幕最后一行以 `%`/`$`/`#` 结尾;surface 死亡态(空白/`[exited]`/未渲染 rc=2)全部 fail-closed → 永拒。
- send 类自愈本质上只能「往活着的裸 shell 里打字」;surface 进程死掉后**没有 shell 可打**。

镜像 session 为什么会中途重建(顺带查):日志证实 2026-08-18 19:51-19:54 cmux app 自身重启(socket missing → `cmux reopen detected (generation …1787108044)`)叠加全舰 restart 潮;watcher 侧有两条合法重建路径(`repair_view_invariants` 两遍确认后 dismantle+rebuild;`reconcile_existing_workspaces` 的 view-dead dismantle)。21:42 那一次的精确触发行不在现存日志里(该 QA view 的 dismantle 无记录)——**设计选择让"为什么重建"不再是承重问题**:重建变成无害事件,而不是继续加检测器去追每一种成因(founder 定案过「修结构别加报警器」)。

### 3.3 founder 三类「看不见」在现状下的机制

- 类①(完工停驻体):窗关 → pane-died hook → 30s 后 `cleanup_workspace_for` 关 tab → 节点从 cmux 完全消失。现网活证据:Bridge `/api/sessions?mode=active` 16 个活跃节点里 **5 个 implement 无窗**(ship_parked×4 + running×1)——cmux 上完全不可见。
- 类②(额度墙等待重生):同上,窗死 tab 关,但 Bridge session 还 active——没有任何可见表示。
- 类③(remote-control 无窗形态):从未有窗 → watcher 的发现层(只扫 tmux 窗)根本看不见它。
- 类④(QA mirror 看不到):QA 窗和 view session 都在,但 workspace 卡在根因 2 的 prepared 死循环 → 顶着「Terminal NN」或根本没建出来。founder 手工修的 workspace:49/55/56/59/60 正是这批。

关键事实:watcher **已经在消费 Bridge 名册**(`fetch_active_runner_roster` → `/api/sessions?mode=active`,只读,用于 runner-orphan 告警)且名册字段齐全(identifier / session_role / status / issue_title / workflow_node_id / adapter_type / heartbeat_at)。显示层要的所有数据都已存在,缺的只是「把名册渲染成 tab」这一层。

## 4. 方案空间与取舍

### 4.1 根因 1:三个候选

| 候选 | 说明 | 判定 |
|---|---|---|
| A. cmux app 侧检测换代自动重连 | 改第三方 app(brew 包)或等 upstream | ✗ 不可控,超出本仓半径 |
| B. **surface 命令换成重连循环 helper** | 镜像 FLY-1663 `flywheel-lead-attach.sh` 已上线模式:helper 循环 attach,session 死了等 2s 重试;断开期渲染明确状态文字 | ✓ 选定 |
| C. 修补 send 自愈的各道 gate | 治标:surface 死亡态没有 shell 可打字,send 机器结构性够不着 | ✗ 结构性不足 |

选 B 的决定性理由:**session 重建从「事故」降级为「无感事件」**(≤2s 自动重连),重建原因不再承重;断开窗口期 helper 打印「已断开,重连中…」——天然满足修法方向②「不许静默空白」;Lead 侧同构模式已在生产验证一年;且大幅减少对 send-heal 机器的依赖(删的比加的多)。send-heal 保留一个场景:cmux app 重启后 restore 出来的裸 shell surface 仍需要注入命令(FLY-254 reopen sweep),注入内容从 attach 原文换成 helper 调用。

### 4.2 根因 2:三刀,全部账本层

- **B1 默认名识别**:`^Terminal [0-9]+$` 在「prepared 行 ref-pinned」语境下视同未命名(等价 `__NULL__`),rename 守卫与 reconcile 恢复分支都放行重驱。安全性:prepared 行的 ref 是我们自己 create 的 before/after diff 钉死的,默认名不可能属于 founder 手工 workspace(founder 的 Terminal 没有 ref-pinned prepared 行)。**无回执语境(candidates 识别)不放行**——默认名不能用来铸所有权。
- **B2 prepared absent-ref 有界保留**:连续 N 次(跨 pass 持久计数)同 generation conclusive absent → GC 释放槽位(workspace:52 类)。
- **B3 prepared drift 有界占槽**:真漂移(非默认名,如被人改名)N 次后:释放逻辑槽位(删 prepared 行,让 create 重建正身),漂移 workspace 保留给人工,同时打一次 episode 告警。回应 issue 修法方向:「prepared 回执要有 TTL/重试而非永久占槽」。

### 4.3 显示层完整性:节点层(Bridge 名册驱动)叠在窗镜像层之上

核心结构选择:**不改动窗镜像机器的语义**(workspace=活窗的镜像照旧),新增一个 `reconcile_node_presence` 阶段,把「节点」渲染为 tab:

- 活跃节点有窗 → 照旧走镜像 tab(零改动)。
- 活跃节点无窗(额度墙/停驻/remote-control/headless)→ **placeholder tab**:surface 跑一个极薄的状态渲染 helper,循环显示 watcher 每 tick 从 Bridge 名册写下的状态文件(节点身份 + 状态词 + issue 标题 + 心跳年龄,「等待重生/停驻中/remote-control」)。
- 节点转终态 → 镜像 tab 因窗死被现有 cleanup 关掉后,node-presence 补一个**终态摘要 tab**(同一状态 helper,内容换成终态:最终 status/route/PR/完成时间),保留到 founder 关闭或 TTL(默认 24h)或同节点重生被镜像 tab 取代。
- placeholder 的 title 用稳定节点键(identifier+role),窗名因 vendor/model 轮转变化也不影响连续性;真窗出现即 supersede(经账本授权 close placeholder)。
- placeholder 同样走 prepared→committed 账本(受益于 B1),另有 node-registry 让窗镜像侧的 stale 清扫豁免节点 tab。

诚实边界:**只有 Bridge 名册里存在的节点才可见**。remote-control 体若不在 sessions 表(不被 Bridge 追踪),本设计给不出表示——这是数据源边界,不是显示层缺陷;审计确认现网 roster 含 adapter_type 字段,可如实标注形态。

### 4.4 共同验收(邻近案例的教训)

Linear comment 里 roster-derive-failed 案例(机制不同,后果相同)确立共同验收:「**系统知道它坏了但不告诉人**」在任何机制下都不许发生。落点:所有 preserve-for-manual 终局(drift 残留、absent 残留、unreceipted 拒绝)必须走 episode 告警(现有 `_alert_cmux_cleanup` 通道),不许 log-only。

## 5. 不做什么

- 不 fork/不改 cmux app 本体;控制面(CLI 0.61)够用。
- 不给「镜像 session 为何重建」加检测器/追因机器——helper 化后它不承重;hooks 每 ~90s 重注册(`was 1/2`)的观察记为 follow-up 线索,不在本单展开。
- 不动 v2 Lead 的 reconcile(已有 helper + 幂等收敛,是本设计的模板而非对象)。
- 不做 cmux app 内「标灰置疑」的原生 UI(app 不可控);断开可见性由 helper 文字态承担。
- QA 隔离房(`qa-*` 独立 socket)的可见性不在本单(框架合同即隔离)。
