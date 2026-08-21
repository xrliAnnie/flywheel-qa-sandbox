# FLY-1944 宿主终端链收口 — 实施计划

Issue: FLY-1944 (https://linear.app/geoforge3d/issue/FLY-1944/宿主终端链-tmux-统一升级-brew-护栏-cmux-守护看门狗并-19501951)
日期: 2026-08-21(R7 APPROVED;吸收 codex design review R1×10 + R2×6 + R3×5 + R4×2 + R5×2 + R6×3 + R7 两条非阻塞清理,零拒绝)
基于: exploration.md, research.md

## 0. 总览

五个工作流(W1-W5)。红线:简单优先 / 净删除优先 / 开新路同 PR 删老路 / **不加新告警层**(告警走现有 lead-alert.sh / LeadAlertNotifier 管道;新 alert kind 须同步 `ALERT_EVENT_TYPES`、lead-alert.sh allowlist、kind-contract/route/copy/owner/echo parity 测试;新守护 daemon / 新通知通道禁止)。

| 交付件 | 内容 | 性质 |
|---|---|---|
| PR-1 | W1 正确性:bounded cmux primitive + 心跳 + rider 判定 + 共享 recover 操作 + SLA 契约;W2 代码(decommission 一处 + 3.7c hooks 适配若测试门需要) | correctness |
| PR-2 | W4 全部 | correctness |
| PR-3 | W3 全部 | correctness |
| **PR-4** | **W2 窗口工装**(R3 项 1):独立 operator CLI `scripts/host-terminal-cutover.sh`(子命令 `pause-admission` / `inspect-admission` / `resume-admission` / `preflight-receipt` / `verify-receipt` / `build-closure` / `rehearse-rollback` / `quiescence`(具名零 runner 权威面,R5 项 1)/ `run-step`(bounded 执行器:timeout + 进程树回收 + 超时落 receipt,R5 项 2))+ 全部聚焦测试。**独立脚本,不挂 `restart-services.sh` flag**——后者正常路径拒未知 flag 后自分离,父进程可因子进程存活而假返成功,毁掉同步 exit-code/JSON 契约(restart-services.sh:1293-1371);窗口 R 依赖本 PR | correctness(窗口 R 前置) |
| PR-1b | D1e fork/cache 优化(**数据门控,PR-1 合入后**) | 收益型,独立评审 |
| 窗口 R | W2 运维事务(Phase A + 可选 B)+ W5 cutover 可搭 | founder-gated 运维(依赖 PR-1 + PR-4) |

顺序(R1 项 10 + R2 项 6):先 RED 测试钉死 W1/W4 的 destructive/identity 契约;**3.7c exact-binary 测试门是 PR-1 的开发/合入门**(发现的适配在 PR-1 内修);correctness PR 合入后同一测试工件重跑作窗口 preflight;可演练 runbook/rollback 就绪 → PR-1b 优化 → W3/W5 独立推进 → 最后窗口 R。

---

## 1. W1 — watcher 守护 + 镜像 SLA(PR-1)

### 1.1 D1a 有界化:in-process bounded cmux primitive

`scripts/lib/bounded-run.sh` 是 executable(只能跑外部 argv),不能包本 shell 函数;且 `cmux_call_guarded` 的契约是「guard 判定必须是真实 `cmux` spawn 前最后一个操作」(FLY-254 删掉的竞态不能回来)。因此:

- 在 sync.sh 内新增 Bash 3.2 兼容的 **in-process bounded cmux primitive**:后台起 `cmux` 子进程 + 计时器,超时对**进程组**回收(无孤儿),保留 stdout、真实 rc、超时=124、`GUARD_WAS_BLOCKED` 语义。
- 普通读路径(`cmux ping` :276、`cmux_call` :388、`get_cmux_workspaces_json` :1165、裸 `read-screen` :2265)直接换用 primitive;**guarded 路径**(:426)把 watchdog 准备动作全部排在 guard 判定**之前**,guard 之后的下一次 spawn 就是 `cmux` 本体——保持"最后一个操作"不变量。
- 超时预算:ping 10s、其余 20s(env 注册走 FLY-1455 账)。超时归入现有 health rc=1/3 降级与 backoff 曲线,不新增状态。
- primitive 自身每次 IPC 新增的 fork(计时器子进程等)**计入 D1e 基线**,PR-1b 的降幅目标以含此开销的新基线起算。
- tmux 调用不全量包裹:只包 watch 主循环热路径入口(`get_tmux_agent_windows` 内 list-windows/list-sessions、`derive_lead_roster` 内 `launchctl print` 与 `tmux has-session`),同样用 primitive。其余 follow-up。

测试(RED 先行):会永久挂起**且派生子进程**的 fake cmux → 超时、rc=124、子进程树被回收、无孤儿;guarded 路径回归:「guard 判定到 cmux spawn 之间无其它命令」(源码序断言 + 行为测试);超时归入 backoff 的状态机测试。

### 1.2 D1b 显式心跳

- `~/.flywheel/state/cmux-watcher-heartbeat`,bash 内建 `printf > "$HB"`(零 fork):watch_loop 每 tick 顶部;maintenance park 轮询内**限频到正常 tick 量级**(每 ~15 次 1s poll 写一次,不做 1s 一次的写盘)。
- 写失败 best-effort,不影响主循环。

### 1.3 D1c 外部守护:rider 只判定,recover 走共享 shell 操作

**判定(TS,只读)** —— 新 GatePoller rider(FLY-1560 rider 链,single-flight,零新 timer),每 tick 评估:

```
job_ok   = launchctl print 成功(仅证 job 可查询,不证进程在跑)
owner    = owner 文件为有界 regular non-symlink、恰 4 字段、mode=watch、pid 活、
           incarnation(ps -o lstart=,TZ=UTC)匹配
parked   = 三个 maintenance marker 任一存在
hb_age   = now - mtime(heartbeat);文件不存在 → 按矩阵分支 4 的 owner 代际分流处理(不是无条件静默)
ev_stale = event 文件存在且非空且 mtime>120s(含 .processing 中间态一并检查)
```

判定矩阵(**全序互斥,按此优先级自上而下取第一命中**;R2 项 3):
1. job absent → 告警(unit 掉出 domain,FLY-1814 收敛面负责拉回,rider 不代劳)。
2. `job_ok && !owner`(loaded-without-process / owner 缺失畸形):启动窗静默(锚点 = rider 首见此状态 + 120s),超窗告警,不 recover(无可安全锚定的杀伤目标)。
3. `parked`:`park_age>1800s` 才告警(evidence 注明 parked),不 recover 不删 marker;否则静默。
4. `job_ok && owner && !parked` 且心跳文件缺失:**按 owner 代际分流**——owner incarnation(进程 lstart)早于本次部署时间戳(rider 配置携带的 rollout anchor)→ 旧版 watcher,静默跳过;晚于 → 新版却无心跳(部署坏 / 心跳写永久失败)→ **告警不杀**(盲态不许无限静默——修 R2 指出的 skip-forever 洞)。
5. `job_ok && owner && !parked && (hb_age>300s || ev_stale)` → **stalled** → 触发 recover(下述)+ 告警。(stalled 分支**要求 job_ok**——job 不可查询时没有 KeepAlive 兜底,杀了没人拉起,不杀。)
6. 其余 → 健康,清对应 episode latch(re-arm)。

**恢复(shell,单一 canonical 路径)** —— 不在 TS 再造 lease parser / 重启协议:把 `scripts/lib/restart-cmux-watcher.sh` 既有的 bootout → conclusive-absence → bootstrap → fresh-owner-verification 序列收敛成**一个可独立调用的操作**(加 `--recover` 入口),补两条硬化:
- 每次发信号(TERM 与 KILL)**之前**重读 owner 文件并重验同一 `pid+incarnation+nonce` tuple——期间进程退出 / KeepAlive 重拉 / PID 复用则中止本次信号;
- `kill -STOP` 冻结场景:TERM 排队无效 → 超时后同一 tuple 重验通过才 SIGKILL。
`restart-services.sh:2758` 与 rider 共用该操作(净收敛:一条恢复路径)。rider 侧 `execFile` 调它,成功判据 = 操作自身的 fresh-owner 验证输出(新 pid 持锁 + 新心跳出现)。**超时预算两层**(R2 项 3):操作内部硬 deadline(默认 120s,超时自报失败退出);rider 的 execFile 外层 timeout 略大(150s)+ 进程树回收——两层都要有,防 recover 自身变成新的挂点。

**告警**:kind=`cmux_watcher_stalled`,per-episode 一次。**每个会告警的分支都有自己的 latch key 与 re-arm 条件**(R3 项 4):
- 分支 1(job absent):key = unit label;re-arm = job 重新可查询。
- 分支 2(loaded-without-owner):key = 首见时间戳 + job 身份;re-arm = owner 出现或 job 消失。
- 分支 3(parked 超 TTL):key = marker inode+mtime;re-arm = marker 消失或被替换。
- 分支 4(新版 owner 无心跳):key = owner tuple(pid+incarnation);re-arm = 心跳出现或 owner 换代。
- 分支 5(stalled):key = owner incarnation;re-arm = 判定不再命中(恢复)。
kind 注册五件套:`ALERT_EVENT_TYPES`、lead-alert.sh allowlist、alert-kind-copy、route/owner、echo-parity 测试。**转移测试**(不只真值表互斥):跨分支状态迁移下每 episode 恰一次发射、真恢复后再发生 → 新 episode 再发一次。

测试:判定矩阵全真值表含**互斥性断言**(任一状态组合恰命中一支);recover 操作的 tuple 重验(fake owner 文件在两次信号间被换 → 中止);recover 内部超时 + rider 外层超时 + 进程树回收;**新版 owner 无心跳 → 告警不杀**;`job_ok=false ∧ owner ∧ stale` → 不 recover;阳性对照 = 隔离 socket 真 watcher `kill -STOP` → 阈值内 recover(阈值 env 缩短);`restart-services` 复用路径回归。

### 1.4 D1d 镜像 SLA(条件式契约)

- 健康态睡眠 event-aware 切片:`reopen_aware_sleep` 健康分支按 3s 切片,每片 `[[ -s $EVENT_FILE ]]`(内建,零 fork 零 IPC),有事件立即返回 drain。
- **SLA 写成条件式可测契约**(R1 项 6):`cmux 健康 ∧ tmux 健康 ∧ hook 已投递` ⇒ 新窗口 → 镜像 ≤ 30s(切片 ≤3s + create 1-4s + verify ≤3s,余量给慢 IPC);兜底路径(hook 丢失 → 60s additive;unhealthy → backoff ≤300s;park → 无上限)明确标 **best-effort,不在 SLA 内**。源码注释写真实上界,不写 "~5s"。此条件式 SLA 需 founder 在 design HTML 上确认(开放问题 §8.2)。
- 测试覆盖:最坏相位(事件在 additive 边界前一刻丢失)、hook 丢失、慢 IPC(fake cmux 延迟 15s)下的实际延迟测量。

### 1.5 W2 代码改动(搭 PR-1)

- `decommission-legacy-companion-daemon.sh:42-45` 绝对路径优先块 → `TMUX_BIN="$(command -v tmux || echo tmux)"`(净删除)。
- **exact-3.7c 测试门(§2.1)是 PR-1 的开发/合入门**(R2 项 6):在 PR-1 开发期就以 3.7c binary seam 跑全套件,发现的任何适配(含 `register_session_hooks`)在 PR-1 内修掉;PR-1 合入后,**用同一测试工件原样重跑**并记录 no-SKIP 结果,作为窗口 R 的 preflight 门。两次跑的是同一套件,先当合入门后当窗口门,不存在"先合再发现"的时序矛盾。

---

## 2. W2 — tmux 3.7c 统一(运维窗口 R,founder-gated)

### 2.1 前置测试门(全绿才排窗口;宿主门禁不得把 real-tmux SKIP 当绿)

用 **exact binary** `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux`(已在盘)经 PATH shim / 显式 binary seam 注入,入口先 assert `tmux -V` 输出 == `tmux 3.7c`,不匹配即 FAIL(不是 SKIP):
- `scripts/test-cmux-sync.sh` 570 例(隔离 socket);
- `scripts/test-cmux-sync-hooks-integration.sh`(3.6 hooks array-options 改制,`register_session_hooks` 幂等 grep 最高风险点);
- TmuxAdapter 79 例 + scaffold rename 竞态用例;
- FLY-1672 window-identity 回归。

### 2.2 窗口 R runbook(停机事务:先停旧、再换链、最后一次重生)

R1 项 1 修正后的顺序——**绝不让新 client 摸旧 server**:

**准备(窗口前,可提前做;R4 项 1:此步产出的只是 preparatory evidence,不是权威冻结清单)**
1. 机器可读 preflight receipt(脚本产出 JSON):**preparatory** socket inventory(per-Lead ×N、default、atlas、QA slot、散装)逐个记 `socket → server PID + ps lstart start-identity + 可执行映像路径 + 架构 + supervisor(launchd label / 无)`(零 runner 的**权威**证明推迟到步骤 3b 闸内做);**3.5a 完整可恢复闭包备份**(R2 项 2):不只拷 keg——`otool -L` 枚举 `/usr/local/Cellar/tmux/3.5a/bin/tmux` 的全部 dylib 依赖(经 `/usr/local/opt/*` 链的 utf8proc/ncurses/libevent 等),把**解引用后的真实 dylib 文件**一并拷入 `~/.flywheel/backup/tmux-3.5a-closure/`,并生成一个用 `DYLD_LIBRARY_PATH` 指向备份闭包的启动 wrapper(升级会动这 6 个依赖,`/usr/local/opt` 链会漂移,裸 keg 拷贝在升级后可能起不来);§2.1 测试门 no-SKIP 记录;**`brew fetch --deps tmux` 预下 bottle 含全部依赖**(Intel + ARM 两侧;R6 项 3:不带 `--deps` 只下 formula 本体,6 个依赖 bottle 会在窗口内现下打爆 300s 预算);receipt 记**依赖 bottle manifest** 并逐一校验存在,缺任一 artifact 拒绝开窗(窗口内的 timeout→回滚只当最后防线,不当缺缓存的正常出路)。
2. 回滚路径**预先实演**(非生产 socket,事务化;R3 项 3):用备份闭包 wrapper 起 server + attach 一次证明可执行,然后 **kill 该实演 server 并以 PID/start tuple 复验消失**。实演**不碰 `/usr/local/bin/tmux` 本体**——在 staging 目录做 symlink 演练(记录真实 `/usr/local/bin/tmux` 的原始链接身份进 receipt,供回滚后复原比对),避免残留 wrapper 链接干扰后续 `brew upgrade` 的 link 阶段。**明确不存在 `brew link` 回 3.5a 的命令**(Homebrew 6 无版本化 formula,`brew link --dry-run /usr/local/Cellar/tmux/3.5a` 实测 rc=1)——Phase A 回滚的**唯一**路径 = `ln -sf ~/.flywheel/backup/tmux-3.5a-closure/wrapper /usr/local/bin/tmux`(命令逐字写进 receipt,staging 实演真跑过)。

**执行(founder 在场,飞清空)**
3. **admission 闸(fail-closed,两态两道门;R2 项 1 + R3 项 2)**:`restart-services.sh` 现有 pause helper 是兼容路径——API 不可达时**返回成功继续跑**(scripts/restart-services.sh:172-198),不能当全舰停机前的闸。用 PR-4 的独立 CLI(前台同步、非零即失败):
   - **在线门(Bridge 活着时)**:`pause-admission` / `inspect-admission` 带认证调 Bridge、保留 JSON 响应、**成功判据 `ok=true ∧ admissionPause.active=true ∧ remainingSeconds ≥ 门槛`**;响应 + **宿主单调时钟 expiry** 写入 receipt;TTL 取支持上限。
   - **预算分层(R4 项 2 + R5 项 2:阈值不自锁,且每个 OP_TIMEOUT 是被强制执行的硬上限)**:预算表是 PR-4 里的**数据 + 强制机制**,不是符号:

     | 离线步骤 | 预算(默认) | 强制方式 |
     |---|---|---|
     | 4 bootout supervisors | 120s | CLI bounded 执行 |
     | 4b 权威 census | 60s | 同上 |
     | 5 旧 client 关旧 server + rescan | 120s | 同上 |
     | 6 brew upgrade + ARM relink | 300s(**准备阶段已 `brew fetch` 预下 bottle**,窗口内只装缓存) | 同上;超时 → 进程树回收 → **直接转闭包 wrapper 回滚**(回滚载体独立于 brew 状态,部分升级态无碍) |
     | 7 升级后实演 | 60s | 同上 |
     | 8 Phase B 链切换 | 30s | 同上 |
     | 9 Bridge bootstrap(=BRIDGE_BOOT_MIN) | 180s | 同上 |
     | 9(续期后)Lead/watcher unit 启动 | 180s | 同上 |
     | 10b 自动化 tuple/映像/attach 验收 | 120s | 同上 |
     | ROLLBACK_BUDGET(完整回滚含 Bridge-first 重生) | 900s | — |

     所有离线步骤经 PR-4 CLI 的 bounded 执行器跑(timeout + 进程树回收 + 超时落 receipt 证据);**不可安全抢占的操作按保守非抢占最坏值入表**。**正常步骤入场判据 = `remaining ≥ 该步预算 + ROLLBACK_BUDGET`**;跌破即不再开启新的正常步骤,转入回滚。**回滚入场判据 = `remaining ≥ BRIDGE_BOOT_MIN`**;Bridge 健康后**立即 `pause-admission` 续期到 TTL 上限**重建满额预算再继续。**TTL 总量校验**:`pause-admission` 在窗口起点断言 `granted TTL ≥ Σ(正常步骤预算) + ROLLBACK_BUDGET`(按上表默认 ≈ 14.5min + 15min = 29.5min),不满足即拒绝开窗;若 Bridge admission pause API 的 TTL 上限不足,PR-4 内把 TTL 参数化(admission pause 机制已有 duration 概念)——这是 PR-4 的实现验证项。测试:每个步骤超预算(尤其 upgrade 与 Bridge bootstrap)→ 后续正常步骤不再开启且回滚入场门仍过;Bridge 吃满 180s 后 post-bootstrap 超时仍带完整储备进回滚;成功路径 resume 在续期 TTL 到期前。
   - **离线门(步骤 4 停 Bridge 后到步骤 9 重启前)**:API 不可查——每个 destructive 步骤前跑 `verify-receipt`:**本地** fail-closed 校验单调 expiry 满足上述对应入场判据。
   - `resume-admission` 的成功判据是 **`active=false`**(与 pause/inspect 相反,两谓词分开定义)。
3b. **权威冻结证明(brake 生效后;R4 项 1 + R5 项 1)**:现有 Bridge 计数面都不够宽——`/health.sessions_count` 走 `getActiveSessions()` 漏 `design_done`(StateStore.ts:6716-6719,而 :6686-6705 的 `getReadoptCandidateSessions()` 明确覆盖 design-parked);`/api/runs/active` 只算 `running + inflight`(runs-route.ts:3762-3774);且 dispatcher 在 durable claim 已建、process-local inflight 未装的间隙(run-dispatcher.ts:770-892)两个计数都能报零。**PR-4 落一个具名 quiescence 面——必须是 Bridge 端点**(dispatcher inflight/barrier 是进程内状态,独立 CLI 只做消费方;R6 项 1):保守并集 = `getReadoptCandidateSessions()` 全部可收养状态(含 `design_done`)∪ dispatcher inflight ∪ durable launch claims(starting/active)∪ **admission-crossing barrier 计数**。barrier 修 R6 抓到的第三个窗口:两个 dispatch 入口都只在顶部查一次 fleet pause(run-dispatcher.ts:771 / :1443),之后跨多个 await(DOA/resume/continuity,:824-843 / :1487-1597)才建 durable claim——pause 在 await 中激活时,已获准的请求对并集不可见。barrier 在 `start()`/`dispatch()` **首个 await 之前同步注册**,请求 durably represented 或终局才清;任一读失败 fail closed;判据 = active pause 下**连续两次轮询稳定为零**(drain 条件);receipt 记**分量计数**非总数。测试:每个 parked 状态逐一;停在 pre-inflight claim 窗口的 dispatch;**两个入口各一例:冻结在首次 admission 检查后、claim 创建前 → 激活 pause → 证明 stable-zero 不可能通过**。
4. bootout / 停住所有会自动重拉 tmux 的 job:全部 per-Lead launchd unit、`com.flywheel.cmux-watcher`、Bridge(其 TS 路径会裸调 tmux)。
4b. **权威冻结 census(R4 项 1)**:supervisor 全部停住后,重新全量扫 socket/server(权威 census),与步骤 1 的 preparatory inventory **取并集**——窗口前到此刻之间新出现/重生的 server 一并纳入。
5. **用旧 client 关旧 server**:`/usr/local/Cellar/tmux/3.5a/bin/tmux -S <sock> kill-server` 对**并集清单**逐 socket 执行(版本匹配,合法动作);随后**再做一次全量 rescan**,要求并集内全部 tuple 以 `PID+start-identity` 复验消失**且无新发现**,才允许进入步骤 6(`restart-services.sh` 只读审计不会替我们关 default/atlas/散装——本步骤逐一显式覆盖)。
6. `HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_AUTO_UPDATE=1 /usr/local/bin/brew upgrade tmux`(Intel → 3.7c);`/opt/homebrew/bin/brew link tmux`(ARM relink)。
7. **升级后、重生前**:在隔离 socket 用备份闭包 wrapper 再起一次 server(R2 项 2——证明回滚载体对**升级后的依赖状态**仍可执行;失败即在重生前回滚,损失最小);**实演完 kill 该 server 并以 PID/start tuple 复验消失**(R3 项 3)。
8. (Phase B,需 founder 加拍)`/usr/local/bin/brew unlink tmux` + `ln -s /opt/homebrew/bin/tmux /usr/local/bin/tmux`(兼容 symlink;回滚 = 删 symlink + relink Intel 3.7c 或备份闭包 wrapper)。
9. **一次重生**:先 `verify-receipt`(离线门:按 §步骤 3 预算分层的对应入场判据)→ **bootstrap Bridge** → Bridge 健康后立即 `inspect-admission` 证明 persisted pause 仍 active,**并同回滚分支一样立刻 `pause-admission` 续期到 TTL 上限**(R6 项 2:主路径成功分支也不许拿 900s 回滚储备去付后续账)→ 各 per-Lead unit / watcher(KeepAlive 以新二进制起 server;**本步入表:预算 180s**);runner base session 由下次 spawn 自建。
10. 逐 socket 验收(R2 项 2 + R3 项 3 口径):每个新 server 记 `PID + start-identity + 可执行映像路径 + 架构(file 该映像)`。映像提取器**唯一且带阳性对照**:PR-4 里定一个 exact extractor(pinned 的 `lsof -p <pid>` 选择规则——取 `txt` 段中与已知 tmux 安装路径前缀匹配的那一行;Rosetta 下 txt 段含 AOT/runtime/dyld 多行,裸取第一行不成立;阳性对照 = 对一个已知路径起的进程提取并逐字比对)。**不以 client `tmux -V` 充当 server 证明**;cmux 全 tab attach 由**自动化验收**覆盖(步骤 10b;founder 视觉确认在步骤 11 resume 之后);Phase B 追加:server 映像 = `/opt/homebrew/Cellar/tmux/3.7c/bin/tmux` 且 arm64、新 pane `sysctl -n sysctl.proc_translated`=0。
10b. **自动化验收入表**(R6 项 2):步骤 10 的逐 socket tuple/映像/attach 自动化验收预算 120s,入场判据同正常步骤(续期后预算充足);**founder 视觉确认放在 `resume-admission` 之后**——人工步骤不持闸,若视觉发现问题走事后处置(闸已开,回滚变成新的 founder-gated 窗口),或 founder 明确要求持闸等待时给显式 operator deadline(到点自动 resume)。
11. `inspect-admission` 复验 pause 仍 active → `resume-admission` → 观测 **`active=false`** 落 receipt(在续期后的 TTL 到期前完成;测试:Bridge 吃满 180s 预算后 post-bootstrap 超时仍能带完整储备进回滚;成功路径 resume 发生在续期 TTL 到期前)。

**回滚**(任一步失败):停新 server(用当前 client)→ 按 receipt 里逐字命令恢复 3.5a——**唯一路径 = 备份闭包 wrapper symlink**(R3 项 3:不存在可执行的 `brew link` 回 3.5a,该兜底从 runbook 删除)→ **Bridge-first 重生,按回滚入场判据**(R4 项 2:`verify-receipt` 只要求 `remaining ≥ BRIDGE_BOOT_MIN` → Bridge → 健康后**立即 `pause-admission` 续期到 TTL 上限**重建预算 → `inspect-admission` 证 active → 其余 unit)→ 逐 socket 验旧版收敛(同步骤 10 口径)→ **同样以 `resume-admission` 证 `active=false` 收尾落 receipt**(回滚分支不许把闸留在合上状态)。

PR-4 测试补(R4 两项):①runner/socket 在 preparatory receipt 与 pause 之间出现 → 并集 census 抓到;②server 在 supervisor bootout 前重生 → 4b 权威 census 抓到;③正常入场判据在两次检查之间跌破 → 转回滚;④恰在边界进入回滚 → BRIDGE_BOOT_MIN 判据放行;⑤Bridge 启动消耗部分余量后续期成功 → 满额预算重建;⑥续期后 resume 收尾 active=false。

### 2.3 验收

`which -a tmux` 全 3.7c;逐 socket 新 tuple + attach 证明(不只看 which);cmux 全 tab 正常;Phase B:proc_translated=0。

---

## 3. W3 — brew 护栏(PR-3)

### 3.1 改动:allowlist 模型(R1 项 7)

`scripts/hooks/flywheel-restart-guard.py` 增加 **P5**:
- 识别:分段/env 剥离/wrapper 剥离(复用现有基建)后,段首 token basename == `brew`(**含绝对路径 brew**)→ 这是一次 brew 调用。
- 解析:跳过全局 flag(`--debug/--verbose/--quiet/-d/-v/-q` 等,按前缀 `-` 跳到第一个非 flag token)取真实子命令。
- 判定(runner,即 hook 进程 env 有 `FLYWHEEL_EXEC_ID`):**默认 deny**。放行走两条显式文法(R2 项 5):
  - **option-only 形**:整条 brew 调用只有一个信息选项(`--version` / `--prefix [formula]` / `--cellar [formula]` / `--caskroom` / `--repository` / `-v` 无子命令形)→ 放行;此文法在通用 global-flag 剥离**之前**单独匹配。
  - **子命令形**:剥全局 flag 后子命令 ∈ `{list, ls, info, abv, deps, outdated, doctor, config, help, search, desc, home, leaves, uses, missing, options, log, tap-info, shellenv}` → 放行;**`analytics` 只放行精确 `analytics state`**(`analytics on|off|regenerate-uuid` 是变更动作,deny);**`gist-logs` 不在名单**(会创建外部 Gist)。
  - 其余(未知 / 外部命令 / 新增子命令 / `bundle` / `services` / 一切 mutation)**fail closed**。
- Lead/founder(无 `FLYWHEEL_EXEC_ID`):放行 + audit 一行。
- deny 文案(中文)给正路:`flywheel-comm ask` 报 Lead,由 Lead/founder 在宿主终端执行。
- bypass:复用现有 `FLYWHEEL_RESTART_GUARD_BYPASS`(audit + strict-delivery alert 双前置),不新增变量。
- 不动 `FLYWHEEL_LEAD_ID` 泄漏(记 follow-up,需先核 flywheel-comm CLI 依赖)。

### 3.2 测试(TDD)

矩阵:mutation 子命令 × wrapper 前缀 × `bash -c` payload × 多段命令 × 管道;**难例必含**:`brew --debug install tmux`(全局 flag 后取真子命令 → deny)、`brew bundle`(未知 → deny)、`/opt/homebrew/bin/brew install x`(绝对路径 → deny)、`env FLYWHEEL_EXEC_ID= brew install x`(命令行赋值不影响 hook 进程 env → 仍 deny)、`brew list && brew install x`(混合段命中)、未知新子命令(fail closed);**analytics 全动词**(`state` 放行;`on`/`off`/`regenerate-uuid` deny;`--debug analytics off` deny)、option-only 形逐个(`--version`/`--prefix`/`--prefix tmux`/`--cellar`/`--repository`)、`gist-logs` deny;read-only 全放行;Lead 态(无 EXEC_ID)放行+audit;bypass 双前置;P1-P4 既有用例全绿。

### 3.3 验收

runner 内 `brew install tmux` 被拦(deny JSON,未执行);Lead 会话放行且 audit 落行;bypass 缺任一前置即 deny。

---

## 4. W4 — Codex TUI 开窗收口(PR-2)

### 4.1 登记与账面(R1 项 4 修正)

`registerCommDbSession()` 不只写 target:还写 `vendor=codex`、`phase_keep_alive=1`,并在 `phaseLifecycle.start()` 前有 `assertPhaseKeepAliveSessionRunning()` 承重——**不能删早期登记**。修正为:
- **早期自登记保留**,但 target 写 `${session}:pending`(不是假窗名),vendor/phase metadata 与 assertion 照旧成立。
- `persistSessionState()` 拆两步:onThreadReady 立即写 threadId/daemonPid/cwd(Bridge crash 恢复与孤儿回收的承重证据,不能延后);`tmuxWindow` 字段仅在拿到 immutable `@id` 后写。
- adapter 局部 `tmuxWindow` 不再从名字型初始化;`AdapterExecutionResult.tmuxWindow` **只有真实 `@id` 才返回,否则 undefined**。
- `wireCreated()` 中 `resolveWindowId()` 失败 → 不置 `tuiOpened=true`,归入可重试失败(优先:ensure/create 层直接返回创建所得 window ID,消掉二次解析)。
- CommDB 的 `@id` 写入走现有 pin 路径(:1565-1578),成为首次非 pending 写入。

### 4.2 重试与终局(R1 项 5 修正)

- 梯子换成**绝对 wall-clock deadline + 有界 attempt 数**:首次失败起 30min 硬 deadline,attempt 间退避 5s/15s/60s/300s(其后恒 300s)。**deadline 是抢占式的**(R2 项 4):外层挂 AbortController/定时器,每个 attempt 的内层 ensure 预算取 `min(210s, 剩余 wall-clock)`,到期 abort 在飞 attempt 并 await 其退出——不是只在 attempt 之间看表。
- **失败分型(typed classifier;R2 项 4 + R3 项 5)**:现 `create-failed` 把锁竞争 / stale-window 证明失败 / new-window 失败 / abort / 异常混在一个 reason 里,不能整类当 transient。ensure 层上抛 typed evidence,分四类:①retryable-hold(hold_lock_unavailable 证据)→ 入梯;②retryable-transient-IPC(超时/瞬时 tmux 错误)→ 入梯;③permanent(`tmux-absent`、配置类)→ **立即**发终局 receipt/alert(不入梯);④cancellation → 按 **typed abort cause** 细分:`run-ended` / caller-cancel → run-end 终局路径;**`deadline`(外层 30min 闸自己 abort 的在飞 attempt)→ 立即发 deadline-exhausted 终局**,不落入 run-end 路径等 run 结束。abort cause 随 AbortController 的 reason 全程携带进 attempt outcome。
- **终局 receipt/alert 三个触发点,同 episode 去重**:①梯子 deadline 耗尽;②permanent 分型即时;③run 结束时窗口仍 pending(run 先完则梯子取消,终局照发)。三处共用 executionId 键的 dedup,不双发。
- `RunnerTuiWindowOutcome` 扩为有界、可脱敏的 typed evidence(reason + 最后一次 hold 的 owner pid/verb/heldSec + attempt 计数)。
- **依赖方向**:claude-runner 不 import teamlead。runner 包声明 `onTuiWindowLost(evidence)` 结构接口,由 `packages/teamlead/src/bridge/run-infra.ts` 构造 adapter 时注入实现(接现有 `tui_window_lost` kind + episode latch;episode 以 executionId+故障起始时间持久化,窗口恢复即清)。
- 删除"竞争必然在窗口内解开"的断言:成立条件(单一健康 holder 60s 内释放且无连续新 holder)写进文档;梯子 + 终局告警共同覆盖不成立的情形。

### 4.3 测试(TDD)

- fake timers:退避序列、30min 硬闸**在 attempt 飞行中到期 → abort(cause=deadline)+ await 退出 + 恰一次 deadline 终局即时发射**(不落 run-end 路径)、runEnded→梯子取消**且**终局照发、permanent 即时终局、四分型逐类含 abort cause 三值、三触发点 dedup 不双发。
- 账面:创建前 CommDB 恰一次 `:pending` 写入(vendor/phase metadata 齐)、`@id` 后恰一次非 pending 写入;session.json 两步写;result/session.json/CommDB 三处**无假名字**;phase keep-alive 断言在 pending 期间成立;Bridge crash resume(早写的 threadId/daemonPid 可恢复)。
- pending 期间消费方保守行为:wake、reaper、close/terminate 路径逐个(不只 started-evidence)。
- 阳性对照:mock rescue status=5 复现故障链 → 锁释放后梯子开窗成功;真机(QA 节点):并发双 codex runner 锁竞争 → 双窗最终出现 + 账面核对。

### 4.4 验收(comment ①)

①失败后有后台补开(梯子);②失败留可见标记(`:pending` 不被假窗名覆盖)+ 上浮告警(三个终局触发点,per-episode dedup);③预算匹配 = 30min 外层硬闸 ≫ 60s 持有预算,且不成立情形有终局告警兜底。

---

## 5. W5 — playwright cutover(运维动作 + FLY-1867 硬门继承)

### 5.1 动作

1. preflight:`FLYWHEEL_RUNNER_SLIM_MCP` 未设或 ≠0;receipt 不存在(首次 apply)。
2. **继承 FLY-1867 自己规定的上线硬门**(R1 项 9):headless WebGL/截图行为验证按其 plan.md:555/:567-582 的两阶段预注册流程产出阈值;若 founder 明确 supersede(接受"headless 截图退化风险,先止血可见窗口"),在 issue comment 记录后方可跳过。二者取一,不静默绕过。
3. `bash scripts/setup-mcp-on-demand.sh apply ~/.claude/settings.json`;`check` 验 drift;回滚 = `rollback`。
4. 生效边界:对新起 Claude 会话生效;存量空挂 server 随会话回收(P0 已 ship);不需重启 Bridge/Lead。

### 5.2 验收(529 房,按 FLY-1867 判据口径)

- fresh ordinary runner / ordinary Lead / founder Terminal:playwright MCP server 进程 = 0(PID+lstart fresh census,**不用命令行子串**);
- QA / `playwright` label opt-in:server 起且 launcher/config-root 精确匹配;首调后 Chrome **可见窗口判据 = 目标 Chrome PID 的 CoreGraphics on-screen window count = 0,founder 自己的 Chrome >0 作阳性对照**;UA `HeadlessChrome` 只作佐证;**不用 `ps` 查 `--headless`**(上游明确否决);
- 桌面无新窗口(founder 视觉,对应 comment ①③);
- QA 退出后子进程随体回收(P0 验收路径,PID+lstart census)。

### 5.3 follow-up 登记

`@playwright/mcp@latest` 钉版本;存量 19 个空挂 server 消退观察(census 账本在记);`setup-mcp-on-demand.sh check` 只证 settings 两值,运行时能力以 §5.2 实测为准。

---

## 6. PR-1b — D1e fork/cache 优化(数据门控,独立 PR)

R1 项 8:与安全修复分离,PR-1 合入并稳定后做。
- 先跑一轮 FLY-1929 同法 pid-diff 基线(含 PR-1 新增 primitive 开销),按数据决定收编范围。
- cache 契约:只缓存**明确只读**的 pass consumer;`create_workspace_for_window` 的 `raw_before/raw_after/confirm_raw` 与三 reaper 的安全校验走显式 `fresh` API **永不命中 cache**;集中枚举全部 mutator chokepoint 为失效点并逐个测试;命令失败 / invalid JSON / 不确定 tmux read **不得缓存为空集**(参照同文件 `read_roster_tmux_inventory()` 的 tri-state 先例;`get_tmux_agent_windows` 把读失败折成空列表的既有形态在收编时一并改 tri-state)。
- `_read_mutator_owner` 纯 bash 化、`get_tmux_agent_windows` pass 级缓存、`mutator_lease_owned_by_self` 去重,归此 PR。
- 目标:60s pass fork 数较新基线降 ≥40%,pid-diff 复测为证;`test-cmux-sync` 570 例全绿。
- 诚实边界照抄 FLY-1929:总 churn 上限 ~11%,panic 已被 voucher-guard 兜住。

---

## 7. 风险与诚实边界

1. **W2 全舰单点**:runbook 已改停机事务(先停旧 server 再动链);残余风险 = 散装 server 清点遗漏 → preflight receipt 的 socket inventory + 步骤 5 的逐一复验兜。回滚载体 = **dylib 闭包备份 + wrapper**(brew 6 无 switch、upgrade 默认 cleanup、keg 非自包含——裸 keg 拷贝不构成回滚保证);升级后重生前的第二次实演证明其对新依赖状态可执行。
2. **3.6/3.7 hooks 改制**是最大兼容未知数;§2.1 exact-binary 测试门(禁 SKIP 充绿)是唯一可信判据。
3. **rider 恢复路径**:所有 destructive 动作收敛到单一 shell 操作,每次信号前同 tuple 重验;残余 = owner 文件损坏 + 进程活 → 只告警不杀。
4. **W3 覆盖边界**:只覆盖 Claude 会话;agy/kimi runner 无 hook;Codex runner 靠自身沙箱;hook 是事故护栏非安全边界(原理性绕过由 prompt 契约 + audit 兜)。allowlist 模型下新增合法 read-only 子命令会被误拦——代价可接受,放行走 Lead。
5. **W4 残余**:`:pending` 长期滞留(梯子 30min 内未解)由终局告警上浮;下游消费方对长 pending 的行为以 §4.3 测试逐个钉死。
6. **SLA 是条件式契约**:健康+hook 投递前提下 ≤30s;兜底 best-effort 明示,需 founder 确认(§8.2)。
7. **fork 优化收益上限 ~11%**;Rosetta(Phase B)才是大杠杆,需 founder 加拍。

## 8. 开放问题(带给 founder / design review)

1. W2 Phase B(ARM repoint,消 Rosetta)是否与 Phase A 同窗口执行?(推荐同窗口,一次停机)
2. D1d 条件式 SLA(健康前提 ≤30s,兜底 best-effort)是否接受?
3. W5 的 FLY-1867 headless WebGL 硬门:走两阶段预注册流程,还是 founder supersede 先止血?
4. rider 阈值:心跳 300s / park TTL 1800s / 事件积压 120s——默认值是否接受?

## 9. 验收总表

| 验收 | 机制 | 验证方式 |
|---|---|---|
| kill -STOP 阈值内自愈 | D1c rider + 共享 recover 操作 | 隔离 socket 阳性对照 |
| 新窗口 <1min 出镜像 | D1d 条件式 SLA(健康路径 ≤30s) | 真机计时 + 最坏相位测试 |
| which -a tmux 全 3.7c | 窗口 R | 命令 + 逐 socket 新 tuple 证明 |
| cmux 全 tab attach 正常 | 窗口 R 步骤 10b 自动化验收 | 自动化 attach 证明 + 步骤 11 后 founder 视觉确认 |
| runner brew install 被拦 | W3 P5 allowlist 模型 | runner pane 实测 |
| ensure 失败后台补开 | D4a 30min 硬闸梯子 | vitest + 真机并发复现 |
| 开窗失败可见标记+告警 | D4b `:pending` + 三终局触发(耗尽/permanent 即时/run-end) | 账面核对 + alert 落 |
| runner 启动零可见浏览器 | W5 cutover | 529 房按 FLY-1867 CG 判据 |
