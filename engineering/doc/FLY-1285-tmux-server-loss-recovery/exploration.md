# FLY-1285 tmux server 丢失 + 恢复配置漂移 — 探索

Issue: FLY-1285 (https://linear.app/geoforge3d/issue/FLY-1285/incident-2026-07-15-0016-runner-tmux-server-丢失10-runner-阵亡-恢复机制以)
日期: 2026-07-15
基于: 无

## 0. TL;DR（取证结论，全部本机实证）

1. **tmux server 从没死。** 老 server（PID 3738，7/13 08:29 启动）**至今还活着**，7/14 22:46 启动的 runner 进程（runner-03deabaf）还挂在它下面在跑。真正发生的是：**7/15 00:16 前后 `/tmp/tmux-501/default` socket 文件被顶替**，老 server 变成"活着但不可达"的孤儿，所有 tmux 客户端瞬间看到 "no server running" → Belle 的 lead supervisor 在 00:16:20 用 `ensure_tmux_session` 建出**新** server（PID 93009）→ **split-brain**（两个 server 同名 session 并存，现在还并存着）。
2. Bridge 00:16:27 的判定是 **server_fresh**（boot leg，不是 server_down）：第一次 heartbeat 检查探到的是刚建 7 秒的新空 server，13 个 running session 的 window 在新 server 上"全部可证不存在" → 集体标 failed。**被埋的 runner 有一部分（至少 FLY-1282 的 runner）进程当时和现在都活着** —— 这是 FLY-1282「假接管/假判死」的又一层：不仅接管是假的，这次连"死亡"都是假的。
3. **恢复拉起 Lead 用 Fable 不是泄漏，是四层拷贝只消费最后一层**：projects.json（SSOT，7/9 起就是 opus-4-8[1m]）→ manifest（fleet carrier，opus）→ **plist EnvironmentVariables（7/6 写死 claude-fable-5，从未更新）** → 运行中 supervisor 的进程 env（启动时冻结）。`claude-lead.sh:1628` 只读 `FLYWHEEL_LEAD_MODEL` env。7/12 的 Opus 切换是 staged（重启 deferred），于是 plist/进程 env 停在 7/6 的 Fable。supervisor 的 crash-recovery 循环重放的是**启动时冻结的 CLAUDE_ARGS**，什么都不重读。
4. **双 Tadashi 是结构性的**：supervisor 的 `_wait_tmux_window` 把「窗口消失」等同「claude 死了」（`claude-lead.sh:1306-1309`），但 socket 顶替时窗口"消失"（不可达）而 claude 进程孤儿化存活；relaunch 前只清**同名窗口**（新 server 上没有）和孤儿 **Discord adapter**（FLY-183，只认 adapter 不认 claude 本体），于是旧 claude（PID 56004，Fable）+ 新 claude（--resume 同一个 session id，还是 Fable）并存。

## 1. 事故时间线（重建，PDT）

| 时间 | 事件 | 证据 |
|---|---|---|
| 7/13 08:28 | 机器开机；08:29 老 tmux server 3738（`new-session -Ad -s flywheel`，TmuxAdapter/裸形态）+ atlas server 建立 | uptime「up 2 days」；ps lstart；/tmp/tmux-501/ 各 socket mtime |
| 7/6 23:51 | eng-lead plist 写入 `FLYWHEEL_LEAD_MODEL=claude-fable-5`（此后未再改） | plist mtime + 内容 |
| 7/9–7/12 | projects.json leads[].model → claude-opus-4-8[1m]（7/9 14:14 mtime）；7/12 Opus 切换 staged、重启 deferred（当时 OOM 压力） | projects.json mtime；Lead 任务账本 #135 |
| 7/14 13:10 | 旧 Tadashi claude（PID 56004）由 supervisor 拉起，`--model claude-fable-5`（读的是冻结 env）——**分歧是存量的** | 事故取证（issue 内）+ 本探索的 env 链分析 |
| 7/15 00:09 | Bridge 重启（07:09Z）；00:09:23–00:10:41 对 14 个 session 逐个 `session_monitoring_reestablished`（FLY-1282 已证=假接管，无 liveness 验证） | bridge.log 387040-387057 |
| 7/15 ~00:16:0x | `/tmp/tmux-501/default` socket 被顶替（机制假说见 §3）；所有客户端「no server running」 | default socket mtime = Jul 15 00:16；老 server 3738 的 socket FD 指向已 unlink 的旧 inode（lsof） |
| 7/15 00:16:20 | Belle supervisor 的 relaunch 触发 `ensure_tmux_session` → **新 server 93009 诞生**（cwd=/Users/xiaorongli/Dev/personal-assistant，`-x 200 -y 50` 是 claude-lead.sh 签名） | ps lstart + cwd（lsof） |
| 7/15 00:16:27 | Bridge 首次 heartbeat 检查：probe=up（新 server）+ 13 个 running session target 全部 gone → **server_fresh** 集体迁移 failed + fleet ticket | bridge.log 387824 `[server-loss] server_fresh: 13 running tmux session(s) lost — episode tmux-server-lost:1784099787585`（=00:16:27 PDT） |
| 7/15 00:20–00:24 | 各 lead supervisor 陆续检测窗口消失 → 在新 server 上重拉 claude；eng-lead 00:22:15 检测（40299s ≈ 从 7/14 13:10）→ 5s backoff → 00:22:20 `--resume` 同 session id 拉新 claude → **双 Tadashi** | /tmp/flywheel-lead-flywheel-flywheel-eng-lead.log |
| 7/15 01:23 | 事故后 fleet 重启（restart-services），manifest 01:26 被刷新（model=opus 被 preserve），但进程还是 Fable（env 链未变） | bridge.log boot 行；manifest mtime |

当时 load 峰值 122（18 核）；内存 free 35%（内存不是主因，与 7/9 OOM 不同）。

## 2. 三个症状的机制（已实证部分）

### 症状 ①：10 个 runner 集体标 failed
- 判死路径：`ServerLossCoordinator.check()`（`packages/teamlead/src/bridge/server-loss.ts`）boot leg（`server_fresh`）：probe=up + wasFirst + ≥3 个 session 的 `targetGone()` 全 true → 集体迁移。
- `targetGone()`（`plugin.ts:7840-7853`）问的是**当前可达的那个 server**（lookupTmuxTarget + probeRunnerProcessLiveness）——它没有能力发现「window 在另一个不可达的孤儿 server 上」。在 split-brain 下这个判定**结构性必错**。
- 工作没丢（progress ledger 在分支 + FLY-795 resume），但「死亡」本身部分是假的——孤儿 server 上的 runner 进程还在烧 token 干活，只是无人监管、无人收割。

### 症状 ②：恢复拉 Lead 用存量 Fable
- 消费链唯一入口：`claude-lead.sh:1628` `_fly241_lead_model="${FLYWHEEL_LEAD_MODEL:-}"` → `--model`。注释自述「per-Lead via the launchd plist EnvironmentVariables」。
- wrapper（`~/.flywheel/bin/flywheel-lead-wrapper.sh`）读 manifest 的 leadId/projectDir/botTokenEnv/… **唯独不读 `.model`/`.effort`**。
- manifest 的 `model` 是 FLY-247 fleet apply 的权威 carrier（`claude-lead.sh:511-515` 只 preserve 不消费；`flywheel-fleet.sh` 读它算 drift）。
- 四层拷贝、一层消费：SSOT 与运行时之间隔了两层"应用时才同步"（plist 文件）+"重启才生效"（进程 env）。staged apply + deferred restart = 无限期漂移窗口。supervisor 每次 crash-recovery 重放冻结 args，把漂移复读出来。
- `FLYWHEEL_LEAD_EFFORT`（FLY-671）与 model 同构，同样的病。

### 症状 ③：双 Lead 并存（无互斥/接管）
- `_wait_tmux_window`（`claude-lead.sh:1298-1326`）：窗口/`list-panes` 不可达 → `CLAUDE_EXIT=1` 视为 crash。**「窗口不可达」≠「进程死了」**——socket 顶替时进程被孤儿化（reparent，claude 不退）。
- relaunch 前的清场（`_launch_claude`，1100-1116）：`tmux kill-window`（打新 server，旧进程不在上面）+ `reap_orphan_adapters`（FLY-183，只认 ppid==1 的 **Discord adapter**；旧 claude 活着时它的 adapter ppid=claude ≠ 1，也不会被收）。
- supervisor 不记录 claude 的 pane_pid，crash 路径没有任何「旧进程是否存活」检查 → 新旧并存，且新 claude `--resume` 了**同一个 session id**（同 session 双写风险）。
- wrapper 的 PID lock 只互斥 **supervisor 自身**双开，不覆盖 claude 层。

## 3. socket 为什么被顶替（根因假说，置信度排序）

**假说 A（主推）：tmux 客户端的 stale-socket 自愈机制在高负载下误杀活 server。**
tmux 客户端 connect() 到 unix socket 收到 ECONNREFUSED 时，视 socket 为陈旧遗留 → unlink socket 文件（配 lockfile）→（对会启动 server 的命令）fork 新 server。macOS 上当 server 的 accept 队列（listen backlog，tmux 用 128）被填满时，后续 connect() 正是返回 ECONNREFUSED。本机放大器：
- **tmux 是 x86_64 二进制跑在 Rosetta 下**（lsof 可见 rosetta runtime 映射）——天然慢一档；
- load 峰值 122（18 核），server 进程严重饥饿，accept 消费速度趋零；
- 客户端洪峰是常态：Bridge heartbeat 逐 session capture-pane、LeadWatchdog、~14 个 lead supervisor 各自 3s 一次 `list-panes`、cmux-sync、00:09 Bridge 重启后的 14 连发 re-establish 探测——排队 128 个待 accept 连接在 load 122 下完全可达。
- 反证外部清理器：同目录**更老**的 socket（atlas 7/13、codex-fly1239-* 7/13、fly1244-* 7/14）全部健在，只有被高频连接的 default 被顶替——年龄型清理器会一锅端，连接型自愈只打被连的那个。机器 uptime 才 2 天，也够不着 macOS 3 天 /tmp 清理线。

**假说 B（次）：某脚本/人为 rm 了 default socket。** restart-services.sh、qa-framework 均 grep 不到任何 kill-server / /tmp/tmux 清理；当晚 FLY-1256 QA 的 tmux E2E 全部用独立 `-L fly1256-e2e-*` socket 且其 socket 均健在。无嫌疑人。保留假说仅因 unlink 行为本身不留日志。

**关键点：修复对触发器不敏感。** 无论谁顶替了 socket，故障类别都是「**socket 丢失 ≠ server 死亡**」+「**创建新 server 前不查孤儿**」。设计按这个类别修，假说 A/B 只影响"降低复发概率"的运维建议（如换 arm64 原生 tmux、降探测洪峰），research 阶段可做一个隔离 socket 的复现实验（SIGSTOP server + 打满 backlog，看客户端是否顶替 socket）把假说 A 钉死。

## 4. 候选修复方向（按症状，各给选项+推荐）

### 方向 A：socket 丢失 ≠ server 死亡 —— 孤儿 server 侦测 + 复活（P0，root-cure）

tmux server 收到 **SIGUSR1 会在原路径重建自己的 socket** —— 这是官方复活通道。孤儿侦测：同 uid 的 tmux server 进程（pgrep）中，lsof 显示其绑定 socket 路径 == 目标路径、但与当前可达 server（若有）PID 不同 → 即孤儿。

- **A-1（推荐）：rescue-before-create + rescue-before-bury，双埋点。**
  1. 所有「会创建 server」的入口（`claude-lead.sh:ensure_tmux_session`、`TmuxAdapter.ensureRunnerSession`）在 create 前先跑孤儿扫描：发现孤儿 → SIGUSR1 → 短等 socket 重现 → 复用，不建新 server。防 split-brain 于未然。
  2. `ServerLossCoordinator` 在宣判前（server_down 的 probe=down 分支、server_fresh 的 targetGone 全灭分支）先跑同一个 rescue：孤儿复活成功 → 重新探测 target → 活着就**零伤亡**，不迁移不告警（或只发一条 informational「socket 丢失已自愈」）。
  3. 已成 split-brain（两个 server 并存，如当下现状）：**不自动 SIGUSR1**（会反向顶替新 server 的 socket，把新窗口打成孤儿）——发 needs_human ticket 列出两个 server 的 PID + 各自 window 清单，人/Lead 决策。
- A-2（备选）：server 身份钉扎——spawn 时把 server PID/start_time 记入 StateStore，probe 时比对，PID 变了才走 fresh 判定 + 孤儿扫描。比 A-1 更精确但改动面更大（StateStore 加列 + 全 spawn 路径写入）；作为 A-1 的增强留 follow-up。
- A-3（不推荐）：只加告警不自动复活。放着 10 个活 runner 变孤儿继续烧 token，没解决核心伤害。

### 方向 B：Lead model/effort 的 SSOT 收敛到「启动时读 manifest」（P1）

- **B-1（推荐）：`_launch_claude` 每次拉起时现读 manifest 的 `model`/`effort`**（fleet carrier，fleet apply 权威维护、与 projects.json 同步），优先于 `FLYWHEEL_LEAD_MODEL`/`FLYWHEEL_LEAD_EFFORT` env（降为 fallback/测试 seam）；manifest 无字段 → env → 无（字节兼容：今天没有 model 字段的 manifest 行为不变）。env 与 manifest 不一致时 log 一条 drift 警告。效果：staged apply 在下一次自然 relaunch（含 crash-recovery）即生效——这正是 7/12「staged、等重启」的操作者意图；plist 从此只是引导参数不再是真相层。
- B-2（备选）：启动时直读 projects.json。更"直达 SSOT"，但绕过 fleet 事务边界（plan/apply/journal/rollback 都以 manifest 为 carrier），可能读到未 apply 的半程配置；且 shell 里按 projectName+leadId 查 JSON 数组更脆。
- B-3（不推荐）：加强 fleet apply 纪律（每次都必须 bounce）。治标——staged/deferred 是 OOM 等现实约束下的合法操作，机制上就该允许。

### 方向 C：supervisor relaunch 互斥/接管（P1）

- **C-1（推荐）：pane_pid 记账 + takeover。** `_launch_claude` 启动后记录 `#{pane_pid}`（new-window 直接 exec claude，pane_pid 即 claude PID）到 `${PID_DIR}/<project>-<lead>.claude.pid`；crash 路径 relaunch 前：pid 存活且 ps 验明是 claude（防 PID 复用）→ SIGTERM → 有界等待 → SIGKILL → 再拉新。同时治了「同 session id 双 resume」。
- C-2（备选）：按特征 pgrep 全局清扫 lead claude（类似 FLY-183 adapter reap 扩展到 claude 本体）。特征匹配脆（lead claude argv 无 --agent-id 类稳定标识），误杀面大，仅作 C-1 的兜底讨论。

### 边界（不做什么）

- **自动复活 runner（memory-paced respawn）不做**：FLY-175 铁律 respawn 由 Lead 驱动；且方向 A 落地后 socket-loss 场景零伤亡，无需复活；真 server 死亡（如 7/9 OOM）维持现状 Lead 驱动。作为独立议题留给 FLY-1082 follow-up。
- **假接管（monitoring re-established 无 liveness 验证）不在本票修**：FLY-1282 正在做（design/implement runner 在跑），本设计只保证与其不冲突、且 A-1 的 rescue 探针可被它复用。
- 降探测洪峰（poller 合并）、tmux 换 arm64 原生二进制：运维建议写入 research/plan 附录，不做代码交付。

## 5. 开放问题（带进 research）

1. 假说 A 的复现实验：隔离 `-L` socket + SIGSTOP server + 并发 connect 打满 backlog，验证 tmux 3.5a 客户端是否 unlink+顶替。（安全：独立 socket 名，不碰 default。）
2. SIGUSR1 复活的边界：socket 路径被新 server 占用时 SIGUSR1 的确切行为（顶替 or 失败？）——决定 A-1 第 3 步的护栏措辞。
3. 孤儿扫描的实现形态：shell（lsof/pgrep）与 TS（Bridge probe）两个宿主如何共享逻辑（薄 shell helper + TS spawn 调用 vs 双实现）。
4. `server_down`（tick leg，probe=down）分支同样要 rescue-first——确认 probeTmuxServer 的 down 判定语义（list-sessions 的哪些输出算 down）。
5. B-1 的 manifest 读点放 wrapper 还是 claude-lead.sh 主循环内（决定「每次 relaunch 生效」还是「每次 supervisor 重启生效」——应放主循环/`_launch_claude` 内，前者）。
