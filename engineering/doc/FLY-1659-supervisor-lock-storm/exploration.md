# FLY-1659 supervisor 锁风暴根治 — 探索

Issue: FLY-1659 (https://linear.app/geoforge3d/issue/FLY-1659/supervisor-锁风暴根治外部重启后无收养分支15-supervisor-带锁死循环互相饿死-建窗验收噪声自杀-全舰)
日期: 2026-08-07
基于: 无

## 1. 事故是什么

2026-08-07,restart-services 外部重启后,15 个 Lead supervisor 整夜锁风暴不收敛(01:25 代 + 15:31 代两次复现)。本 Runner 在 HEAD(cecdb06e)工作区实测确认了事故日志(geoforge3d-cos-lead,即 Simba):

```
$ grep -c "lock_unavailable"        /tmp/flywheel-lead-geoforge3d-cos-lead.log   → 2247
$ grep -c "takeover hold (ambiguous)" ...                                        → 1042
$ grep -c "denied_holder_alive"     ...                                          → 142
最后一条: [lead] 15:50:49 tmux hold (lock_unavailable) while waiting for @1287
          lockf: ~/.flywheel/locks/tmux-1b08f661f4b07fa9.lockf: already locked
```

后果:**全舰 KeepAlive 事实失效**——Simba 04:25 Bun segfault 崩后 supervisor 5 小时抢不到锁没救成;15:50 前后 supervisor 抢到锁后又误收割了活体(Tadashi)。现状:operator 已 bootout 全部 supervisor(仅 Mufasa 留),14 具身体健康裸奔零监护。本单是恢复监护层的前置。

一个关键实证:`lock_unavailable` 出现在 `while waiting for @1287` —— 锁风暴不只发生在冷启动 takeover 路径,**连健康监控循环也在抢锁**。这把病根 B 的严重性从「冷启动风暴」升级为「稳态自放大风暴」。

## 2. 源码级病根(HEAD 审计,与老栈 4857d999 逐 diff 确认 supervisor 逻辑字节一致)

> 行号按 HEAD(cecdb06e)。老栈 4857d999 与 HEAD 在 `claude-lead.sh` 仅差 FLY-1650 model-effort 一段(+41 行,与 supervisor 路径无关);`tmux-server-rescue.sh` 零 diff。所以修在 HEAD 上,两栈同义。

### 病根 A — 外部重启后无收养分支(风暴触发器)

`packages/teamlead/scripts/claude-lead.sh` `_prepare_lead_launch()`(:1449-1496):archive 存在 + archived 进程活着时只有两个出口:

- `TMUX_RELAUNCH_PROVEN=1` → reap(杀掉重拉)。但 `TMUX_RELAUNCH_PROVEN` 是**进程内内存变量**(:1261 初始化为 0),supervisor 换代后必然为 0;
- 否则 → `ambiguous`(同代 server)/`split_brain`(跨代)hold,return 3,永远重试。

**没有「这就是我的 lead、健康、直接收养接管监护」的分支。**

审计新发现(比 issue 描述更深一层的结构性事实):FLY-1602 的 lease 层收养路径(case 5 `_lead_bound_body_ready`,:1525-1536)在冷启动下**结构性不可能成功**,不只是「实践中前置全败」:

1. `_lead_bound_body_ready` :1531 要求 `[ -n "$LEAD_WINDOW_ID" ]`,而 `LEAD_WINDOW_ID` **只**在本进程 `_launch_claude` :1950 被赋值——冷启动 supervisor 里它永远是空串 → return 3 → `denied_sensor_degraded` hold。它从不从 archive 的 `TMUX_ARCHIVE_WINDOW_ID` 恢复。
2. 更根本的:lease store(`packages/flywheel-comm/src/lead-lease.ts` acquire,:487-657)的 `idempotent_adopted`(rc 5)只发给 **requester == 记录在案的 supervisor(同 pid+start)** 的重入请求。换代后的新 supervisor(不同 pid)走的是另一条路:记录的旧 supervisor 已死 + body 活 → `holder_orphaned`(rc 4)→ shell 侧 `_lead_clear_orphan_body`(:1511-1520)= 抢救 session id 后 **hard-clear 杀掉健康活体**再重启。换句话说,现行契约里「新 supervisor + 活身体」的正常出路是**杀了重启**,根本没有收养。

于是外部重启后的实际状态机:lease acquire 若成功走到 rc 4 → 杀活体重启(15:50 的「误收割活体」);若被锁风暴/sensor 拖垮 → `denied_holder_alive`/`denied_sensor_degraded` hold;若 lease 层降级(store_error)→ 落到 `_prepare_lead_launch` → `ambiguous` hold。三条路没有一条是「接管监护」。

### 病根 B — hold 重试是带锁重操作 ×15(饿死引擎)

锁架构(`scripts/lib/tmux-server-rescue.sh`):

- `tmux_socket_ensure`/`tmux_socket_recover`(:1691/:1697)都经 `_tmux_rescue_run_with_lock`(:1622)抢**全局单锁**(锁名 = socket 路径哈希,15 个 supervisor 共用 `locks/tmux-1b08f661f4b07fa9.lockf`)。
- 锁等待 = `_tmux_rescue_effective_timeout lock` = 5s × load_factor(≤4)= 5-20s(:189-192)。
- 临界区(`_tmux_socket_ensure_locked` :664-830)跑 2-3 次全量 `tmux_socket_inspect` + verify + create + 复检;每次 inspect = tmux 探针 + `ps axww`(:340)+ 每个同 uid tmux server 一次 `lsof`(:270,超时 6s×factor)。静息实测 0.9s,负载态数秒到数十秒。
- **15 个排队者、锁等待 5-20s、临界区 5-30s → 数学上必然饿死**;主循环 30s 定步长重试让 herd 对齐,永不收敛。

监控循环(`_wait_tmux_window` :2020-2104)的两重问题:

1. 健康快路径本身就重:每 3s 一次 `_tmux_target_matches_archive`(:1302)→ `_tmux_generation_is_current`(:1294)→ **全量 `tmux_socket_inspect`**(无锁但 ps+lsof 全套)。负载态 inspect 超时 → verdict 非 reachable → matcher 假阴性;
2. matcher 假阴性 → 落入 `tmux_socket_recover`(:2062,带锁)→ 抢锁失败 → `hold (lock_unavailable)`。FLY-1598 加的 sleep 只 pace 了 recover-成功分支;recover 失败分支 backoff 3→30s,但**每一轮都是一次带锁操作**。

自放大环:load↑ → inspect 超时↑ → matcher 假阴性↑ → 更多带锁 recover → 锁排队 + load↑。这就是「稳态也风暴」。

### 病根 C — 建窗验收噪声自杀(重建又清掉)

`_launch_claude` :1961-1973:`new-window` 拉起 claude 后立刻全量 `tmux_socket_inspect` 验收,verdict 非字面 `reachable`(包括超时造成的 `saturated`/`ambiguous`/`unknown`)→ **杀掉自己刚建的窗**(里面是健康的新 claude)→ hold → 循环。负载态 inspect 极易翻车 ⇒ 整夜「窗口反复重建又清掉」,同时每轮重建又给系统加压。

### 噪声放大器 — 残留 tmux server

`tmux_socket_inspect` 枚举**所有**同 uid、ppid=1 的 tmux server(:340-364),对每个跑一次 lsof(exact socket 路径等值,不产生假候选,:331)。但每个残留 server 都增加一次 lsof 超时面;任何一次 lsof 翻车 → `scan_complete=false` → verdict 降级。实测现场:

- `tmux -L atlas`(Mufasa,合法);
- **QA 残留** `/tmp/q96/tmux.sock`(8/5 的 ad-hoc mutant-harness 演练台,还活着)——其 session 名**就叫 `flywheel`**(`flywheel: 2 windows ... (group flywheel)`)。当前 socket 精确匹配下它不产生假候选,但它是 (a) lsof 超时面,(b) 未来任何按 session 名操作的工具的定时炸弹。

## 3. 探索的方向选项

### 方向 1(采纳):收养分支 + 稳态零锁 + 删自杀,净删除优先

按 issue 修复方向逐条落地,全部在 shell 层(claude-lead.sh + tmux-server-rescue.sh + restart-services.sh preflight),**零 TS 改动、Bridge 不动、lease store schema 不动**:

1. **收养分支(根)**:archived 活体 + 身份匹配(`tmux_supervisor_archived_process_matches`,内含 `lead_identity_command_matches` 的 argv `--agent <lead_id>` 精确验证——已实测 body argv 带 `--agent`,:2401)+ 同代 server(`_tmux_target_matches_archive`)⇒ `LEAD_WINDOW_ID=$TMUX_ARCHIVE_WINDOW_ID`,直接进 `_wait_tmux_window` 监控。落点两处:lease rc 4(`holder_orphaned`)分支**先试收养再 fall back 到现有 clear+relaunch**;lease 降级路径的 `_prepare_lead_launch` archived-alive 分支同判。case 5 的 `_lead_bound_body_ready` 顺手补 `LEAD_WINDOW_ID` 从 archive 恢复。
2. **稳态零锁**:监控循环与「server 明显可达」的快路径全部换 cheap 探针(`tmux display-message -p '#{pid}'` 等值 + `list-panes`),只有硬证据(server 探针失败)才进带锁 rescue。
3. **删自杀**:建窗验收改直接证据(server pid 未变 + `list-panes -t $LEAD_WINDOW_ID` 有 pane);verdict 噪声永不触发杀窗;只在**阳性不匹配证据**下才杀。
4. **重试去同步**:hold backoff 加 jitter(20-40s 随机)。
5. **锁等待拉长**(≥30s,排队不放弃)——1-3 落地后锁流量趋近零,此条纯兜底。
6. **顺手**:restart-services preflight 清理残留 QA tmux server(显式模式匹配 + 审计日志);QA rig 不得以 `flywheel` 为 session 名。

### 方向 2(否决):把收养做进 lease store(TS 层新增 adopt 动词)

在 `lead-lease.ts` 加 `adopt` 动词,把 lease row 的 supervisor tuple 原子改指新 supervisor。**否决理由**:(a) 引入 TS+schema 改动,交付面从 scripts 扩到 flywheel-comm dist,老栈热修路径复杂化(老栈跑的是旧 dist);(b) shell 层收养不改 lease row 也是安全的——body pane 里的 `FLYWHEEL_LEAD_LEASE_KEY/GENERATION` env 与 store 里的 row 仍然一致,写边界照常;body 死后下一轮 acquire 走「holder 已死」→ 正常新 generation,账本自然收敛;(c) 净删除优先:方向 1 删的比加的多。留作未来如需强一致时的 follow-up。

### 方向 3(否决):砍掉全局锁,改 per-lead 锁

锁保护的是「对 shared tmux server 的 create/signal 类破坏性操作」,天然是 server 级资源,per-lead 化会让两个 lead 同时 create server 竞态回归(FLY-1285 之前的病)。正确解法不是拆锁,而是**让稳态根本不进锁**(方向 1 的 fix 2)。

## 4. 关键设计约束

- **净删除优先**:自杀验收整段删除换 2 个 cheap 探针;监控循环去掉全量 inspect;不加新 daemon、不加新 flag(Annie 铁律,FLY-1466)。
- **保守面不动**:真 split_brain(跨代活体)、身份不匹配(argv 不带本 lead id)仍然 hold/照旧——收养只在「三重硬证据全绿」时发生。
- **bash 3.2 兼容**(生产 macOS /bin/bash),`$RANDOM` 可用。
- **部署**:修的是 scripts,Bridge 不动;⚠️ 本地 main=4857d999 落后 origin/main 9 commits,**不许 ff 本地 main**——交付方式(老栈热修 vs 并入 run5 target)由 Lead 与 founder 定夺,PR 先出(base=main/HEAD)。
- 本单是 design 节点:产出 exploration/research/plan + founder HTML;实现由后继节点执行。

## 5. 验收方向(阳性对照先行,真机)

- 未修代码复现:外部拉起身体 + 冷启 3+ supervisor(隔离 socket,`FLYWHEEL_TMUX_SOCKET_OVERRIDE`)→ 实测进入 hold 循环(阳性对照);
- 修后:①15(隔离环境 ≥3)supervisor 冷 bootstrap → 全部 ≤2min 进入监控态、零 kill 新窗、稳态零 lock_unavailable;②杀一个 lead 身体 → ≤90s 拉回(KeepAlive 实证);③atlas+q96 残留在场仍收敛;④fly1285 既有套件(`scripts/__tests__/tmux-server-rescue*.test.sh` 等)全绿 + 新增 storm 回归。
