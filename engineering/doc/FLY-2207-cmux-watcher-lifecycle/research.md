# FLY-2207 cmux-watcher 进程生命周期三病 — 调研

Issue: FLY-2207 (https://linear.app/geoforge3d/issue/FLY-2207/可见性watcher-cmux-watcher-进程生命周期三病查询超时累积死死了无人发现复活被-fly-913-误伤8-31)
日期: 2026-08-31
基于: exploration.md

## 1. 现场证据索引(全部可复查)

| 证据 | 位置 |
|---|---|
| watcher 死亡窗口日志(09:13:28 起连续 timeout,09:15:08 无声中断) | `/tmp/flywheel-cmux-watcher.log` 行 601216–601254 |
| patrol stalled 判决 + recovery 失败详情(heartbeat_age_ms=314838;`watcher survived shutdown verification pids=93566; bootstrap skipped`) | `~/.flywheel/comm/flywheel/comm.db` mailbox seq 127662 |
| patrol job_absent 判决(`recovery=not attempted (safety matrix)`) | 同上 seq 127664 |
| 两封信 30 秒内被 claw ACK | 同上 state=ACKED, acked_at 16:15:56Z / 16:16:53Z |
| 同日早间同型事故(05:16 stalled → 05:17 job_absent,搁浅至 08:19) | 同上 seq 127369 / 127371 |
| patrol 风暴基线:8-29 一天 99 封 stalled + 79 封 event_backlog | 同上 type='cmux_watcher_stalled' 按日聚合 |
| Lead 手工 bootstrap 被 P1 拦(11:08:39) | `~/.flywheel/logs/restart-guard.log` 末行(session cwd=lead-workspace/flywheel-eng-lead) |
| autostart 路径 11:08:59 成功复活 + 新 watcher 自动 rebuild stale lease | watcher log 行 601252–601254 |
| Discord/founder 面零告警(alert_threads、lead_events、teamlead 各 outbox 均无 cmux_watcher 行) | `~/.flywheel/teamlead.db` |

## 2. 关键机理确认(逐条钉死)

### 2.1 heartbeat 的双语义冲突(病 1 上游)

- 写点唯一:`watch_loop` 每 tick 开始 `watcher_write_heartbeat "$tick" scan`
  (flywheel-cmux-sync.sh:11505),注释原文:*"Heartbeat means a scan tick actually
  began"* —— 语义是「scan 开始了」。
- 另有 backoff 睡眠期每 15s 一跳(:11483-11485)、maintenance park 跳(:12543-12547)——
  **睡眠时心跳密,干活时心跳停**。
- patrol 把同一文件当「进程健康」读(mtime 年龄 > `heartbeatStaleMs=300s` 即 stalled,
  cmux-watcher-patrol.ts:173)。一个 scan pass 串行执行几十个 cmux 调用,每个
  `CMUX_CALL_TIMEOUT_SECONDS=20s`(sync.sh:292);cmux 慢时 pass 轻松 >300s。
- 事故数值自洽:heartbeat_age=314.8s,timeout 群从 09:13:28 开始,反推最后心跳
  09:10:12 ≈ pass 开始点。
- **heartbeat 文件全部消费者**(改动安全面):
  1. sync.sh 自身(writer);
  2. restart-cmux-watcher.sh `_crw_read_heartbeat_pid`(:110-120)——只取第 1 字段 pid;
  3. cmux-watcher-patrol.ts(:448-457)——取第 1 字段 pid + 文件 mtime。
  三者都不解析第 2/3 字段语义 → **在 bounded 调用出口加写心跳(刷新 mtime、pid 不变)
  对全部消费者向后兼容**。`watcher_write_heartbeat` 用 `$$`,bash 在 command-substitution
  子 shell 里 `$$` 仍是主进程 pid → 子 shell 语境下写也安全。

### 2.2 pid 93566 的身份:`set -m` 造出的独立进程组残影(病 1 中游)

`_cmux_bounded_spawn`(sync.sh:306-338)为了能按进程组杀 cmux,先 `set -m`(job control)。
副作用:**看门狗子 shell `( sleep timeout; kill ... ) &` 也拿到独立进程组**,
且 bash 子 shell 的 argv 与父进程完全相同(`/bin/bash .../flywheel-cmux-sync --watch`)。

- `launchctl bootout` 只杀 launchd job 的进程组 → 看门狗残影存活;
- census `pgrep -f 'flywheel-cmux-sync(\.sh)? +--watch'`(cmux-mutator-process-census.sh:215)
  按 argv 匹配 → 残影被当成「另一个 watcher」;
- 残影寿命 ≤ `sleep 20s` 自然结束,但 restart 脚本的 remaining-census 检查
  (restart-cmux-watcher.sh:191-199)恰好落在这个窗口内 → **拒绝 bootstrap,永久搁浅**。
- 结论:**bootout 后 census 撞到同 argv 残影是结构性必然**(慢 pass 时几乎总有在飞的
  bounded 调用),不是异常;把它当 fail-closed 理由是把 20 秒寿命的进程升级成了永久盲窗。

### 2.3 单向门(病 1 下游 + 病 3 机器面)

- classifier 安全矩阵(cmux-watcher-patrol.ts:89-95):只有 `stalled` 有 `recover=true`;
  `job_absent` 只告警。设计初衷是「job 缺失时不盲杀」——但 bootout 恰恰由 stalled 分支
  自己造成 job 缺失,缺失后无任何重建路径。**拆得掉、建不回。**
- 恢复脚本各失败分支(missing_plist / bootstrap_failed / probe_failed / unverifiable)
  一律 `return 0` 结束,不重试、不回滚 bootout。
- 正规重建通道只剩:updater 班车 restart-services.sh:2823(00:00/12:00)、
  交互 shell .zshrc → autostart(靠 founder/Lead 碰巧开终端)。与观测一致
  (05:17 搁浅→08:19 shell 救活;09:16 搁浅→11:08 Lead 救活)。

### 2.4 互斥权威是 lease,不是 census(B1 的安全根据)

- FLY-129 mutator lease(`/tmp/flywheel-cmux-watcher.lock/owner`,pid|incarnation|watch|nonce)
  才是唯一 mutator 的裁决点;新 watcher 起动即校验/重建
  (11:08:59 日志:`[audit] rebuilt stale/unverifiable mutator lease reason=stale-owner-no-live-mutator`)。
- 即使 census 残影尚存就 bootstrap,新 watcher 也会经 lease 走「等待/重建」而非双写。
  census 的正确角色是**候选发现**(其文件头注释自认:"pgrep is candidate discovery only"),
  不是 bootstrap 的一票否决。

### 2.5 告警链路解剖(病 2)

- 链路:patrol → plugin.ts:8635 alert 闭包 → routedAlertSink →
  infra-event-router `TICKET_KINDS`(cmux_watcher_stalled ∈ ticket 族,
  kind-contract: owner=claude, arc=human_by_design)→
  `enqueueInfraAlert("claude-infra-bot-lead", …)` → per-project CommDB mailbox。
- **ticket 族契约即「ordinary-route=claw-mailbox」**(plugin.ts FLY-368 启动日志原文),
  不产生 Discord 消息。唯一例外:`workflow_engine_escalation` 走 rawSink
  (AlertChannelHub → unified 告警频道 + @founder mention,infra-event-router.ts:141-158)。
- founder 可见的 escalation face **已存在**且只认 eventType —— 扩展点就是
  createInfraAlertSink 的这个特例分支 + AlertEventType 联合类型(FLY-1082 有同型先例)。
- patrol 侧已有 per-episode 去重(emittedEpisodes),escalation 复用同一 episode 键即可
  一集一响。

### 2.6 FLY-913 管辖边界(病 3)

- 该护栏是 **Claude 会话 Bash 工具的 PreToolUse hook**,只扫描 Bash 命令字符串
  (flywheel-restart-guard.py:1124-1141)。Bridge 进程 spawn 的
  restart-cmux-watcher.sh(内含 `launchctl bootstrap`,:216)从不经过 hook ——
  patrol 自动恢复与 updater restart-services.sh 同属「hook 视野之外的自动化平面」,
  **B1/B2 无需改护栏**。
- 人肉面:`launchctl bootstrap …com.flywheel.…` 命中 P1;
  `bash ~/.flywheel/bin/flywheel-cmux-autostart` 不含 launchctl 字样 → 放行
  (11:08:59 实测)。目前是「碰巧没匹配」,需用回归测试把它钉成契约
  (测试文件:scripts/hooks/test-flywheel-restart-guard.py,已有完整矩阵可挂)。
- P1 deny 文案是静态常量 `DENY_REASON`(:185-197),对 cmux-watcher 目标追加指路行
  需要小改 deny 分支(按命中 label 是否含 `com.flywheel.cmux-watcher` 选择文案)。
  guard 部署 = `cp` 到 `~/.flywheel/bin`(Tier-1,零重启,install-restart-guard.sh 收敛)。

### 2.7 restart-storm-gate 分层(B2 的刹车兜底)

- gate 在 autostart **supervised 入口**处执行(autostart.sh:34-60):
  `gate cmux-watcher` rc=3(held)→ exit 0,KeepAlive 按 ThrottleInterval=30s 重试,
  **label 始终受管**。窗口 `FLYWHEEL_RESTART_STORM_WINDOW_SEC=600`。
- 分层结论:patrol rebuild 只负责「label 存在性」(bootstrap);
  「job 内起动预算」仍归 storm gate。brake held 时 patrol 看到的是
  job.ok=true + ownerless → `owner_missing`(120s grace 后 alert-only)——
  不会与 rebuild 形成回环。rebuild 本身 per-episode 一次,不追加风暴压力。
- 与 updater 班车并发:双方都可能 bootstrap;后到者收到 "already bootstrapped" 错误。
  rebuild 路径将「bootstrap 失败但事后 `launchctl print` 可查询」判为收敛成功即可消解。

### 2.8 QA / 验收路径

- 既有隔离 QA 旋钮齐全(feature-flags/truth.ts 已登记):
  `FLYWHEEL_CMUX_WATCHER_HEARTBEAT` / `_LOCK_DIR` / `_STALE_SECONDS` 等路径与阈值
  全部可 env 覆盖 → 单测/集测可在隔离目录跑完整状态机,不碰生产。
- `kill -9 <纯数字 pid>` 不含 P2 进程标识词 → QA 会话可直接演练「进程死、label 在」
  (KeepAlive ≤30s 拉回)。
- 「label 消失」演练:bootout 在 QA 会话命中 P1 → 演练脚本封装(命令串不含 launchctl,
  与既有 guard 测试同型逃逸,hook 只看 Bash 命令字符串)+ 全程 env 指向隔离 lock/heartbeat。
- 验收「≤10min 回来」预算:patrol tick 60s × (stalled 检出 + bootout + rebuild)
  最坏 ~3 tick ≈ 3min,余量充足;「补窗」由 watcher 起动 reconcile
  (reopen-sweep,11:08:59 起动后逐 runner re-register 可证)承担,QA 断言即可。

## 3. 探索问题逐条答复

| # | 问题 | 结论 |
|---|---|---|
| 1 | bounded 调用出口写心跳是否影响既有消费者 | 安全(§2.1):三个消费者只读 pid + mtime;`$$` 在子 shell 语境不变 |
| 2 | job_absent 重建的安全前置 | plist 存在 + census 残影按 §2.2 处置;storm gate/updater 并发按 §2.7 消解 |
| 3 | straggler 判据 | census pid ∉ {lease owner pid(incarnation 匹配), heartbeat pid};信号前按既有模式重验 argv,防 pid 复用 |
| 4 | C1 升级通道接线 | 扩展 createInfraAlertSink 的 escalation eventType 特例 + AlertEventType 新 kind(FLY-1082 先例),patrol 侧 per-episode 一次 |
| 5 | FLY-913 测试落点 | test-flywheel-restart-guard.py 加两类断言:autostart 放行契约 + cmux-watcher deny 文案指路 |
| 6 | kill -9 验收 | 纯数字 pid kill 不被拦;label 演练走隔离 env 的封装脚本;预算 §2.8 |

## 4. 显式假设(plan 之前立此存照)

1. cmux app 的慢(list-workspaces timeout)是环境公理,本 issue 不治 cmux 本体
   (FLY-2063 族);设计目标是 watcher 生命周期对「cmux 慢」免疫。
2. pid 93566 的身份是按 `set -m` + census argv 匹配机理推定(与 20s 窗口、
   census 模式完全自洽),没有该 pid 的 ps 现场留存;设计按「残影必然出现」防御,
   不依赖该推定的唯一性。
3. `human_by_design` 的 kind 契约保持:自动恢复只作用于 watcher 自身 launchd job,
   不扩权到其他 com.flywheel.* 服务。
4. founder 无感 = 恢复在阈值内收敛时零消息;escalation 只在不收敛时一集一响。
