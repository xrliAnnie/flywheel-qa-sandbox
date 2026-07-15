# FLY-1285 tmux server 丢失 + 恢复配置漂移 — 调研

Issue: FLY-1285 (https://linear.app/geoforge3d/issue/FLY-1285/incident-2026-07-15-0016-runner-tmux-server-丢失10-runner-阵亡-恢复机制以)
日期: 2026-07-15
基于: exploration.md

## 1. 根因实验（本机 tmux 3.5a，全部用隔离 -L socket，不碰 default）

脚本：scratchpad fly1285-tmux-experiments.py（三段，输出全文见 git 提交说明；结论如下）。

### E1：backlog 打满 → "恢复"动作顶替活 server（假说 A 复现成功）
1. 隔离 server 启动后 SIGSTOP（模拟 load 122 下的调度饥饿——server 不 accept）。
2. 裸 connect() 循环：kernel 恰好收下 **128** 个连接（tmux listen backlog=128），第 **129** 个返回 **ECONNREFUSED**。
3. 此时 `tmux ls` 输出 **"no server running on /private/tmp/tmux-501/fly1285e1"** —— 与生产 Bridge probeServer 判 down、supervisor `list-panes` 判窗口消失看到的一模一样。注意 `ls` 只报错**不**顶替 socket。
4. `tmux new-session -Ad` 则**直接 unlink 旧 socket、原路径建新 socket、fork 第二个 server**（inode 变更实测），冻结的老 server 原地存活 → **split-brain 完整复现**。

**结论**：事故里 00:16:20 建新 server 的那次 `ensure_tmux_session`（`new-session -Ad`）**就是顶替 socket 的行为人**。链条自洽：load 122 令 x86/Rosetta tmux server 饥饿 → 常态客户端洪峰（Bridge 逐 session capture-pane、LeadWatchdog、14 个 supervisor 各 3s 一次 list-panes、cmux-sync、00:09 重启后的 14 连发探测）排满 128 backlog → 客户端连环 ECONNREFUSED → supervisor 判 crash → relaunch → `new-session -Ad` 顶替 socket → 老 server 连同全部 window 变孤儿。**"恢复机制"本身就是凶器。**

### E2：socket 丢失、server 活着 → SIGUSR1 复活（通道验证）
unlink socket 后 `tmux ls` 报 "error connecting … (No such file or directory)"；对 server 发 **SIGUSR1** 后 socket 在原路径重建（新 inode），客户端立刻重新连上，window 完好。→ 复活通道可用。

### E3：路径已被新 server 占用 → SIGUSR1 是反向抢占（护栏验证）
老 server 的 SIGUSR1 会**夺回**路径（inode 再次变更），`tmux ls` 从此看到的是老 server 的 session，**新 server 反被打成孤儿**。→ **一旦已有第二个 server，任何自动 SIGUSR1 都被禁止**；rescue 只允许发生在"路径上没有可达 server"的时刻。

### 三分类 rescue 语义（Fix A 的精确规格，由 E1/E2/E3 推出）

对目标 socket 路径 P，任何"连不上"都必须先分类再动作（孤儿扫描 = 同 uid、ppid==1 的 tmux 进程中，lsof 显示引用 P 者；ppid==1 是 daemonize 后的 server 特征，attach/probe 客户端的 ppid 是 shell）：

| 情形 | 判据 | 动作 |
|---|---|---|
| ① socket 文件不存在 + 孤儿 server 活 | stat 无 + 扫描命中 | SIGUSR1 → 有界等 socket 重现 → 复用；**不建新 server** |
| ② socket 文件存在 + connect 被拒/超时 + server 进程活 | stat 有 + 扫描命中 | **饱和态**：退避重试（server 排空后自然恢复）；**绝不 new-session**；响亮告警一条 |
| ③ 无任何活 server 进程 | 扫描无命中 | 真死：允许创建 / 允许如实宣判 |

埋点（创建侧）：`claude-lead.sh:ensure_tmux_session`、`TmuxAdapter.ensureRunnerSession`。埋点（宣判侧）：`ServerLossCoordinator.check()` 的 server_down 分支（probe=down 先跑分类，①②都不埋人）与 server_fresh 分支（targetGone 全灭前先扫孤儿：命中=有另一个 server 抱着这些 window，不埋，发 needs_human 的 split-brain ticket）。

## 2. PR-0：restart-services.sh 健康窗（Lead 裁决最先单独出）

事实：
- 部署路径 `deploy_and_verify`（scripts/restart-services.sh:1288-1301）：`for i in $(seq 1 30)` × `sleep 2` = **60s 硬窗**，超时即 `rollback_and_restart`。
- bridge-only 路径（~:1380-1395）：同款 60s 窗，超时发 severe 告警。
- 实测启动时长：7/14 17:15 Bridge 被 SIGKILL 后 KeepAlive 拉回 **~110s 才恢复健康**（Lead 提供，claims 数据）——60s 窗对当下真实启动时长**必假阴性**：若那次是 updater 部署，健康的新 Bridge 会被误判失败并回滚。
- 现有测试资产：scripts/__tests__/ 有 7 个 restart-* 测试（含 restart-stabilization.test.sh），PR-0 的回归测试有挂点。

修法（极小）：两处循环共用一个可配置窗口 `FLYWHEEL_BRIDGE_HEALTH_TIMEOUT_SEC`（env / ~/.flywheel/.env），默认 **240**（≥2× 实测 110s，留 load 余量）；循环改为按秒数推导次数（sleep 2 不变）；dry-run 文案与 severe 告警文案同步改；下限护栏（<30 视为 30，防误配置秒杀窗口）。与 FLY-1290 的关系：FLY-1290 即健康窗修复票（无已存在 PR/分支，gh + git branch 均查无），**PR-0 = FLY-1290 的实现载体**，PR 标题双票号，避免撞车。

## 3. 7/14 17:15 Bridge SIGKILL 关联分析（Lead 指令 43fa1a9e）

- unified log 在 17:10–17:20 窗口内：kernel `memorystatus`/jetsam 记录 **0 条**、launchd 关于 flywheel.bridge 的记录 **0 条**（info 级不持久，取证面有限）→ **排除不了也证实不了 OOM killer；但 macOS jetsam 击杀通常有 kernel memorystatus 日志，一条都没有 → 内存压力击杀可能性低**。
- 特征拼图：exit 137（SIGKILL）+ KeepAlive 秒级拉回 + sha 不变 + self-ship marker 全程 parked（排除 updater）+ 9 runner 全幸存（tmux 未受波及）→ 签名最接近**外部 SIGKILL**（`launchctl kickstart -k` 类监督替换、或手工/脚本 pattern-sweep；后者有前科：FLY-176 时代的 pgrep 管道）。
- 与 00:16 tmux 事故的关联：**因果独立**（17:15 事件没碰 tmux；00:16 是 socket 层）。但两者共享同一背景放大器——高 load + 频繁重启窗口；且 17:15 的 ~110s 恢复时长正是 PR-0 的实证输入。
- 建议（纳入 plan 的 PR-0 附带项，不扩权）：abnormal-exit ticket（FLY-1082 prevExitMarker 路径）里补记 `launchctl print` 的 last-exit 原因字段与时间戳，下次 SIGKILL 留下可归因面包屑。

## 4. 活体 split-brain 现状清单 + 处置 runbook（Lead 裁决 ②）

### 现状（2026-07-15 10:30 实测，ps 以 3738 为父的存活清单）

孤儿 server 3738（7/13 08:29 起）上**仍挂着 ~46 个进程**：
- **14 个旧世代 Lead claude**（7/14 13:09–13:18 启动）：cos-lead、ops-lead、product-lead、joycon-lead、belle-lead、rafiki-lead、reflection-lead、sub-lead、tidal-echo-cos/content、flywheel-cos-lead、flywheel-product-lead、claude-infra-bot-lead 等——**只有 eng-lead 的旧进程在事故夜被手动收敛**，其余 Lead 都处于新旧双实例状态（旧实例可能仍持 Discord 连接 → 双回复/抢答风险；FLY-183 的 adapter reap 只认 ppid==1 的孤儿 adapter，旧 claude 活着时其 adapter ppid=claude，永远不会被收）。
- **~20 个旧 runner claude**（含 7/13 起的 runner-7a10c953 等）+ **~12 个 codex resume 进程** + 3 个 pane shell。
- 这批孤儿在持续消耗 CPU/内存（当前 load 25–30 的一部分即来自它们），且其中 runner 仍可能经 HTTP/CommDB 触达 Bridge 写状态。

### P0 步骤单（已验证 pid 清单，2026-07-15 12:34 PDT 快照；Tadashi 核对后手动执行——本 Runner 不执行）

**验证方法**：① 旧世代 = `ps -axwwo pid,ppid,command | awk '$2==3738'` 中 argv 为 `claude --agent <lead>`（非 --agent-id runner-*）的进程；② 每个旧 Lead 都用同法在 93009 下找到**活着的新世代同名实例**（配对齐全才许杀）；③ 19 个旧 runner 的 exec-id 前缀逐一对照 Bridge `/api/sessions`（Bearer 认证）。当前 running 的 9 个 session **无一**在 3738 上。

**铁律（执行前逐字确认）**：绝不 kill 3738 本体（最后一步除外）；**绝不对 3738 发 SIGUSR1**（E3 实证会反向抢占 default 路径，把现役 server 93009 打成孤儿=事故二次上演）；每个 pid kill 前用 `ps -p <pid> -o lstart,command` 重验启动时间与 argv 一致（防 PID 复用）。

**第一批：13 个旧世代 Lead（双 Discord 连接=双回复风险，先断）**——逐个 `kill <pid>`（TERM），等 10s，仍活再 `kill -9`：

| 旧 pid（杀） | Lead | 启动时间（重验用） | 新世代 pid（勿动，在 93009 上） |
|---|---|---|---|
| 24821 | claude-infra-bot-lead | Jul 14 13:09:16 | 79766 |
| 44090 | flywheel-cos-lead | Jul 14 13:09:56 | 96601 |
| 72462 | flywheel-product-lead | Jul 14 13:11:17 | 25056 |
| 88479 | cos-lead | Jul 14 13:11:57 | 39665 |
| 8021 | ops-lead | Jul 14 13:12:37 | 61770 |
| 31652 | product-lead | Jul 14 13:13:19 | 79249 |
| 70606 | rafiki-lead | Jul 14 13:14:25 | 19026 |
| 84083 | reflection-lead | Jul 14 13:15:05 | 46758 |
| 98676 | joycon-lead | Jul 14 13:15:45 | 65941 |
| 15796 | belle-lead | Jul 14 13:16:25 | 80059 |
| 28274 | sub-lead | Jul 14 13:17:05 | 99640 |
| 45900 | tidal-echo-content-lead | Jul 14 13:17:46 | 14690 |
| 60215 | tidal-echo-cos-lead | Jul 14 13:18:27 | 38835 |

（flywheel-eng-lead 的旧实例事故夜已手动收敛，新实例 pid 9040 在 93009 上，无需处理。）旧 Lead 死后其 Discord adapter 会孤儿化（ppid→1）——FLY-183 的 adapter 自清 + 下次 launch 前扫除会收，无需手动。

**第二批：19 个旧 runner claude + ~9 个 codex resume + 4 个 zsh**（第一批完成、观察 Discord 无双回复后再做）：
- StateStore 对照结论（已核）：**仅 `060d6ca9`（sub-lead 的 nightly cron 会话）仍是 awaiting_review** ——它的 worktree 可能有未收割产物，终止前由 sub-lead/Tadashi 先看一眼其分支；该进程本就在孤儿 server 上（wake 打的是新 server，永远到不了它），杀之不破坏任何在途 review。其余 18 个 runner 前缀均不在活跃账本（终态/已清），逐个 TERM→KILL。
- codex resume 进程（argv 含 `codex resume --remote unix:///…cdx-sock/…`）与 3 个交互 zsh：直接 TERM。
- 每杀一个前同样 `ps -p` 重验。

**第三批：3738 本体**——确认 `ps -axo pid,ppid | awk '$2==3738' | wc -l` 归零后，`kill 3738`（TERM 即可，空 server 会自退）。验证：`ps -axo pid,ppid,command | awk '$2==1'` 中 default 路径 tmux server 仅剩 93009；load 应显著回落（这批孤儿是当前 load 25-30 的主要成分）。

### 收敛 runbook（原始版本，机制与原则说明）

1. **铁律：绝不对 3738 发 SIGUSR1**（E3 实证：会反向抢占 default 路径，把现在承载全部现役 Lead/runner 的新 server 93009 打成孤儿——事故二次上演）。
2. 清点：`ps -axo pid,ppid,lstart,command | awk '$2==3738'` 得孤儿清单；按 argv 里的 --agent（Lead）/ --agent-id runner-xxxx(Runner) / codex resume sock 归类。
3. 旧 Lead claude（13:0x–13:1x 那批）：逐个 SIGTERM（先 TERM 等 10s 再 KILL）。风险低：新实例已在 93009 上服役 >10h；杀旧不影响新。**先杀 Lead 再杀 runner**（防旧 Lead 对旧 runner 的死亡做出反应）。
4. 旧 runner claude / codex resume：先对照 StateStore（/api/sessions）确认对应 execution 已是终态或已被重新派发；worktree 有未提交改动的（git status 逐个查）先知会对应 issue 的现役 runner/Lead 收割，再终止进程。
5. 全部子进程清空后：SIGTERM 3738（无 session 的 tmux server 会自行退出；TERM 兜底）。
6. 验证：`ps -axo pid,ppid,command | awk '$2==1'` 中 default 路径的 tmux server 仅剩 93009；load 应显著回落。
7. 时机建议：低活跃窗口执行（避免与在跑 QA/review 抢 CPU）；执行前后各存一份 ps 快照作事故档案。

### 附录：锁不可用（tmux_hold kind=lock_unavailable）的人工诊断 runbook

rescue 库的临界区跑在 OS advisory lock 下（锁文件 ~/.flywheel/locks/tmux-*.lockf；能力探测链 flock(1) → lockf(1) → /usr/bin/python3 fcntl 封装；进程退出内核自动释放，**不存在需要手工删除的陈旧锁**）。收到 kind=lock_unavailable 的 tmux_hold 告警时按序诊断：

1. **能力缺失**：逐个探测 `command -v flock`、`command -v lockf`、`/usr/bin/python3 -c "import fcntl"`——三者全缺=探测链塌了（如系统 python 被移除），装回任一能力即自愈（下一次调用重新探测）。
2. **锁被长期占用**：`lsof ~/.flywheel/locks/tmux-*.lockf` 找持锁 PID → `ps -p <pid> -o pid,lstart,command` 审计 liveness——持锁者是活的 rescue 调用（毫秒~秒级临界区）属正常瞬态；持锁者是**卡死的孤儿**（如 SIGSTOP/僵尸）→ 按进程处置（founder 授权后终止），锁随进程退出由内核释放。
3. **锁文件/父目录权限异常**（被误 chmod/chown）：修正 ~/.flywheel/locks 为当前 uid 所有、非 group/world-writable。
4. 任何情况下**不要删除锁文件来"解锁"**——advisory lock 绑定打开的 fd 不绑定路径，删文件只会造成下一个调用建新文件、与旧持有者互不可见的假解锁。

## 5. Fix B（model/effort SSOT）设计细节

- 读点：`_launch_claude` 内、每次拉起前现读 `MANIFEST_FILE` 的 `.model`/`.effort`（该文件由 fleet apply 权威写入、claude-lead.sh 启动时原子重写并 preserve 两字段——见 claude-lead.sh:511-559），赋给 `_fly241_lead_model`/effort 的解析处。优先级：**manifest > env（FLYWHEEL_LEAD_MODEL/EFFORT，降级为 fallback 与测试 seam）> 不传**。空串/空白串视为未设（沿用 FLY-241 的 xargs trim 语义）。
- 字节兼容：manifest 无 model 字段（"Absent fields stay absent — never injected"）→ 走 env → 与今日行为逐字节一致。dry-run launch-plan（FLY-231）会如实反映新来源，相关 sentinel 断言按 FLY-217 先例做 LEGITIMATE RETARGET。
- drift 可观测：manifest 与 env 都有值且不同 → log 一行 `model drift: env=… manifest=… → using manifest`（供 fleet 面板/取证 grep）。
- 为什么不直读 projects.json：fleet plan/apply 的事务边界（journal/rollback/CAS）以 manifest 为 carrier；直读 SSOT 会绕过事务、可能读到半程 staged 状态；且 wrapper/supervisor 侧 shell 解析嵌套数组更脆。
- **验收（Lead 裁决 ③，真机证明）**：QA 场景 = 改 manifest 的 model（模拟 staged apply）→ 触发 supervisor 的自然 relaunch（对 claude 窗口发退出/等 crash 路径）→ 断言新 claude 进程 argv 的 --model 是 manifest 新值且 plist env 未动。可在 QA slot 的隔离 lead 上跑，不碰生产。

## 6. Fix C（双实例互斥）设计细节

- `_launch_claude` 成功后 `tmux display-message -p -t "$LEAD_WINDOW_ID" '#{pane_pid}'` 取 pane 首进程 PID（new-window 直接 exec claude，pane_pid 即 claude PID），写 `${PID_DIR}/${PROJECT_NAME}-${LEAD_ID}.claude.pid`。
- crash 检测后、relaunch 前：读该文件；PID 存活 → `ps -o command=` 验证含 claude 且含本 lead 的辨识特征（--agent <lead-id> 或窗口注入的 FLYWHEEL_LEAD_ID 环境——实现时选 argv 校验，防 PID 复用误杀）→ 先 TERM、有界等待（≤10s，轮询）、仍活则 KILL → 再 `_launch_claude`。graceful cleanup() 同步清理该文件。
- 这同时消解「同一 session id 双 resume」：旧实例必死于新实例 resume 之前。
- 与 Fix A 的关系：A 落地后 socket 类"窗口消失"多数会被 rescue 拦下不进 crash 路径；C 是纵深防御（真 crash、真 server 死、以及 A 覆盖不到的窗口级异常）。

## 7. 实现形态（两宿主共享）

- 新 `scripts/lib/tmux-server-rescue.sh`：函数 `tmux_socket_classify <socket-path>`（输出 ①/②/③ 三态 + 孤儿 PID）与 `tmux_socket_rescue <socket-path>`（仅 ① 执行 SIGUSR1 + 有界验证；②只退避；③返回 create-allowed）。shellcheck + bats/sh 测试同 FLY-183 reap 库的形态。
- claude-lead.sh `ensure_tmux_session` 与 TmuxAdapter/Bridge 侧各自薄接入：shell 直接 source；TS 侧（`probeTmuxServer` 前置 + `ensureRunnerSession` 前置）经 execFile 调该 helper（正是 FLY-142 syncFlywheelCliBin 同款分发思路，或按 implement 阶段评估直接 TS 重写三态逻辑——行为规格以本节表格为准，双实现需共享 fixture 用例）。
- ServerLossCoordinator 侧新增 dep `classifySocket()`，在两个宣判分支前调用；①②路径把 episode 转为 informational/`socket_lost_rescued` 或 split-brain needs_human ticket，不迁移。

## 8. 运维附录（不做代码交付，随 PR 文档带出）

- tmux 换 arm64 原生二进制（现为 /usr/local/Cellar x86_64 经 Rosetta，饥饿概率放大器）；`kern.ipc.somaxconn` 现值 128 = backlog 上限来源。
- 探测洪峰减载（Bridge 逐 session capture-pane 批量化、supervisor 3s 轮询在 server 忙时指数退避）→ 独立 follow-up 票，不塞本票。
- 老 server 3738 的收敛按 §4 runbook 由 Lead/founder 择机执行。
