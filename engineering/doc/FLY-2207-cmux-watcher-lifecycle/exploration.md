# FLY-2207 cmux-watcher 进程生命周期三病 — 探索

Issue: FLY-2207 (https://linear.app/geoforge3d/issue/FLY-2207/可见性watcher-cmux-watcher-进程生命周期三病查询超时累积死死了无人发现复活被-fly-913-误伤8-31)
日期: 2026-08-31
基于: 无

## 0. 一句话结论(现场审计后对 issue 叙事的修正)

8-31 09:15 的 watcher 之死**不是「timeout 累积后自己退出」**——watcher 一直活着、只是慢;
是 Bridge 的 cmux-watcher-patrol(FLY-1944)把「慢」判成「stalled」后 `launchctl bootout` 杀掉了它,
随后恢复脚本的 fail-closed 校验撞上一个同 argv 的 bash 子进程残影(pid 93566),**拒绝 bootstrap**,
label 从此无人恢复 —— 这就是「label 整个消失」的全部机理。告警其实发了(两封 severe 进了
claude-infra-bot 的 durable mailbox,30 秒内被 ACK),但 ticket 类告警**没有任何 founder 可见面**,
且 infra bot 自己也被 FLY-913 拦住不能 bootstrap,于是 2 小时盲窗。

## 1. 8-31 事故链(全部有账可查)

| 时刻 (LA) | 事件 | 证据 |
|---|---|---|
| 09:10:12 | watcher 写下最后一次 heartbeat(scan tick 开始) | 09:15:26 patrol 信里 heartbeat_age_ms=314838 反推 |
| 09:13:28–09:15:08 | scan pass 内连续 5+ 次 `cmux --json list-workspaces` timeout(每次 ≤20s),pass 拖长,期间**不写 heartbeat** | /tmp/flywheel-cmux-watcher.log 601216–601254 行 |
| 09:15:26 | patrol 判 `stalled`(heartbeat_age 314s > 300s 阈值),执行 tuple-bound recovery:`launchctl bootout` 成功 → **watcher(pid 58443)被杀、label 卸载**;shutdown 校验发现 census 里还有 pid 93566 →「watcher survived shutdown verification」→ **bootstrap skipped**,state=unverifiable | comm/flywheel/comm.db mailbox seq 127662 |
| 09:16:23 | patrol 下一 tick 判 `job_absent`,按安全矩阵**只告警不恢复** → label 永久搁浅 | mailbox seq 127664 |
| 09:15:56 / 09:16:53 | 两封 severe 信被 claude-infra-bot 消费循环 ACK —— 但 ticket 类告警只进 Claw mailbox,**Discord 上没有任何 founder 可见的消息** | mailbox state=ACKED, acked_at |
| 09:15–11:08 | 盲窗:期间出生的 4 个 runner 无 cmux tab;founder 搜 FLY-2190 落空质问 | issue 记述 |
| 11:08:39 | Tadashi 手工 `launchctl bootstrap ... cmux-watcher.plist` 被 FLY-913 P1 硬拦(deny) | ~/.flywheel/logs/restart-guard.log 末行,cwd=lead-workspace/flywheel-eng-lead |
| 11:08:59 | Tadashi 改跑 `flywheel-cmux-autostart`(job-guard 路径,命令串不含 launchctl,不触发 P1)→ bootstrap 成功,新 watcher 起,自动 rebuild 了 stale lease | watcher log 601252-601254 行 |

**同日早间已发生过一次同型事故**:05:16:51 stalled recovery → 05:17:51 job_absent(mailbox seq
127369/127371),label 搁浅约 3 小时,08:19:33 被某个交互 shell 的 .zshrc autostart 顺手救活。
**单向门一天开了两次。**

## 2. 三病的真实机理

### 病 1 死因:三层叠加,不是单一 bug

1. **watcher 侧**:`watch_loop` 每个 tick 只在 scan **开始**时写一次 heartbeat
   (flywheel-cmux-sync.sh:11505,注释明说语义是「a scan tick actually began」)。
   一个 pass 里几十个串行 cmux 调用,每个最多 `CMUX_CALL_TIMEOUT_SECONDS=20s`;
   cmux app 慢时(list-workspaces 反复 timeout)一个 pass 轻松超过 300s。
2. **patrol 侧**:把这个「scan 开始了」语义的 heartbeat 当「进程健康」用,
   `heartbeatStaleMs=300s` 一过就判 `stalled` 并 bootout(cmux-watcher-patrol.ts:173-189)。
   **同一个文件、两个消费者、两种语义** —— 8-29 一天 99 封 stalled 信,说明「杀慢 watcher」
   是长期风暴,不是 8-31 偶发。
3. **恢复脚本侧**:bootout 后 census(`pgrep -f 'flywheel-cmux-sync(\.sh)? +--watch'`)
   把**与 watcher 同 argv 的 bash 子 shell**(`_cmux_bounded_spawn` 的后台看门狗/子进程,
   fork 出来 argv 完全一样)也算成 watcher;残影存活 → fail-closed 拒绝 bootstrap
   (restart-cmux-watcher.sh:192-199)→ **label 卸载后无人恢复**。
   而 `job_absent` 分支设计上「can never kill」也「never recover」——
   **恢复流程能拆 job,却没有任何路径重建 job:单向门。**

### 病 2 无自检:告警发了,但发进了黑箱

- patrol 的告警链路是通的:severe 信 → infra-event-router(TICKET_KINDS)→
  claude-infra-bot durable mailbox → 30 秒内 ACK。
- 但 ticket 类告警的路由契约是「ordinary-route=claw-mailbox」——
  **不产生任何 Discord 消息**;founder 可见面为零。
- claw 收了信也修不了:它是 Claude 会话,`launchctl bootstrap` 被 FLY-913 P1 拦。
- 结论:病 2 不是「没发告警」,是「告警的终点是一个既看不见也没有行动力的收件人」。

### 病 3 复活通道:被拦的只是人肉正门,机器后门一直是开的

- FLY-913 是 **Claude 会话 Bash 边界上的 PreToolUse hook**;Bridge 进程 spawn 的
  `restart-cmux-watcher.sh` 里的 `launchctl bootstrap`(:216)从来不经过这个 hook ——
  patrol 的自动恢复在架构上就不受 FLY-913 管辖(与 updater 的 restart-services.sh 同理)。
- 被误伤的是**人**:Lead 手工 bootstrap 命中 P1(launchctl + com.flywheel.)。
  而 `bash ~/.flywheel/bin/flywheel-cmux-autostart`(job-guard 路径:已 loaded 则 no-op,
  否则 bootstrap)不含 launchctl 字样,今天 11:08:59 实测可用 —— 但这是**碰巧没被
  pattern 匹配**,不是被设计承认的正门。
- 「正门只剩 00:00 班车」:updater 的 restart-services.sh:2823 每天班车会
  `restart_cmux_watcher` —— 这解释了为什么搁浅的 label 常在午夜自愈。

## 3. 设计方向(发散 → 收敛)

### 方向 A:让 patrol 不再杀慢 watcher(治病 1 上游)
- A1(选定思路):heartbeat 在**每次 bounded cmux 调用完成/超时后**也写
  (状态 `degraded`),让「活着但慢」与「真挂死」在 heartbeat 上可区分。
  改动集中在 `_cmux_bounded_spawn` 出口 + `watcher_write_heartbeat`,一处收口。
- A2(备选,否):调大 heartbeatStaleMs 到 900s —— 治标,慢 pass 更长时照样误杀,
  且真挂死的发现延迟×3。
- A3(备选,否):patrol 判 stalled 前再加 ps/CPU 活性探测 —— 引入第二套「活性」
  判据,与 heartbeat 语义冲突,违背单一事实源。

### 方向 B:恢复操作必须是「label 保全」的(治病 1 下游 + 病 3 机器面)
- B1(选定思路):重写 restart-cmux-watcher.sh 的不变量:
  **凡成功 bootout,必须以 label 重新 bootstrap 结束**(或明确升级,绝不静默搁浅)。
  census 残影改为:tuple 验证(非 lease owner、非 heartbeat writer)→ TERM/KILL;
  即使残影杀不掉也照样 bootstrap —— 互斥的真正权威是 FLY-129 mutator lease
  (11:08:59 新 watcher 自动 rebuild stale lease 已实证),census 只是候选发现。
- B2:patrol 的 `job_absent` 分支从「只告警」升级为「plist 存在 + census 收敛 →
  重建 bootstrap」;带 per-episode 单次尝试 + 既有 restart-storm-gate 刹车兜底。
  这补上单向门的另一半:即使 B1 之外的任何原因导致 label 消失
  (含人为 bootout、崩溃窗口),≤2 个 patrol tick(≈2min)自动重建。
- B3(备选,否):新建独立的 watcher-watcher 守护进程 —— 禁新增告警层同理,
  不新增守护层;patrol 已在 60s cadence 上,复用它。

### 方向 C:自检可见性(治病 2,遵守「禁新增告警层」)
- C1(选定思路):**恢复成功 = founder 无感**(什么都不发);
  **恢复不收敛**(job_absent/stalled 连续 N 个 tick 未转 healthy,阈值 10min)时,
  把既有 severe 告警从「仅 claw mailbox」升级走**既有** AlertChannelHub
  escalation 面(workflow_engine_escalation 同款通道)—— 复用现有层,不新建。
- C2:把 cmux watcher 纳入 Bridge `/health` liveness components(既有 W-1/W-2/W-3
  旁增加一行只读观测),让既有 liveness probe/sweep 顺带捎上状态 —— 纯观测,零新告警。
- C3(备选,否):给 claw 发修复指令让它代修 —— founder 直令明确否定
  「每次你都帮他修」,且 claw 被 FLY-913 拦是 by-design,不应绕。

### 方向 D:FLY-913 与人肉正门(治病 3 人面)
- D1(选定思路):**不改 FLY-913 的判定逻辑**(部署护栏的红线不动);
  把 `flywheel-cmux-autostart` 确立为被承认的人肉正门:
  (a) 在 P1 deny 文案里对 cmux-watcher 目标追加指路一行;
  (b) 加回归测试钉死「autostart 调用不被 guard 拦」,防止未来 pattern 扩张误伤。
- D2(备选,否):P1 对 com.flywheel.cmux-watcher 开白名单 —— 在护栏里造第一个
  label 级例外,先例危险;且有 D1 + B2 后人肉 bootstrap 本就不该再是常态。

## 4. 与同族 issue 的边界

- **FLY-2169**(socket 可见性,已 ship #992):codex runner 的 socket 直连可见性,
  与本 issue 不同脸;其 8-31 评论是本 issue 的证据来源。
- **FLY-1989**(可见性普查缺口)/ **FLY-1976**(死视图重建原语):同族参考,
  本设计的 B2「重建」只覆盖 watcher 自身 job,不做视图级重建。
- **FLY-2063**(cmux 日志无界):list-workspaces 为什么慢属于 cmux app 侧问题,
  本设计把「cmux 会慢」当环境公理对待,不试图治 cmux。
- **补窗行为**:watcher 启动即全量 reconcile(11:08:59 起动后逐 runner
  re-register hooks 可证),「补齐死窗期出生 runner 的 workspace」由既有
  reopen-sweep 承担,本设计只在 QA 验收里证明它,不新写补窗逻辑。

## 5. 待研究问题(进 research)

1. `_cmux_bounded_spawn` 出口处写 heartbeat 的精确落点与 `state` 字段扩展是否影响
   既有 heartbeat 消费者(restart 脚本 `_crw_read_heartbeat_pid` 只读 pid 字段,初判安全)。
2. patrol `job_absent` → 重建的安全前置:census 收敛定义、restart-storm-gate 交互、
   与 updater 班车 restart_cmux_watcher 的并发互斥。
3. straggler tuple 验证的具体判据(lease owner file + heartbeat pid 双排除)。
4. C1 升级通道的既有接口(AlertChannelHub escalation face)最小接线方式。
5. FLY-913 guard 测试矩阵现状,D1(b) 回归测试放置点。
6. kill -9 验收路径:label 仍 loaded 时 KeepAlive 30s 自愈(已有),QA 如何在
   不打扰生产的前提下验证(FLY-913 对 QA 会话同样生效,需走既有 bypass 记账通道)。
