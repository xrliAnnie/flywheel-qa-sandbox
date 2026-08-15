# FLY-1774 Codex 停驻唤醒自动腿 — 调研

Issue: FLY-1774 (https://linear.app/geoforge3d/issue/FLY-1774/机制-codex-停驻唤醒自动腿notify-回灌-租约兜底消灭人肉-goal-戳1569-7-既定设计的落地)
日期: 2026-08-14
基于: exploration.md

> 本文是两轮只读代码审计的定稿(runner spawn 侧 + mailbox 投递侧),所有结论带 `file:line` 证据。
> **核心发现:唤醒链路大部分已存在,病根是链上两处断裂 + 一处覆盖缺口;notify 腿的角色从「主腿」修正为「turn 边界兜底扫」。**

## 1. 现有唤醒链路全图(逐环带证据)

Lead `flywheel-comm send` 到停驻 Codex runner 醒来,现有代码里本应走通的链:

```
[1] send → CommDB mailbox 行 QUEUED
    flywheel-comm/src/commands/send.ts:17-36(只写库;⚠️ :32 会 clearDeclaredState(toAgent) 清掉 park marker)
[2] Bridge RunnerMailboxLane tick(活跃 1s / 空闲 30s;有 runner 待投信时钉在 1s 档)
    teamlead/src/bridge/lead-inbox-runtime.ts:208-268(每 project 第 0 个 Lead 的 loop 驱动)
    teamlead/src/bridge/lead-inbox-loop.ts:25-26, 189-210
[3] claimRunnerBatch → 组批 envelope(flywheelId = mailbox-batch:<uuid>#r<n>,metadata 含 memberIds/execId)
    teamlead/src/bridge/runner-mailbox-lane.ts:155-193, 266-316
[4] deliver → wakeRunnerMailbox → 按 session.vendor 路由到 codex transport
    runner-mailbox-lane.ts:53-77;flywheel-comm/src/wake.ts:76-155
[5] CodexAdapter.write → ~/.flywheel/codex-teams/<lead>/inboxes/<agent>.json(O_EXCL lock + 原子写;
    幂等去重按 metadata.flywheelId)
    agent-team-transport/src/codex/CodexAdapter.ts:121-173, 140-154
[6] CodexMailboxWatcher(fs.watch + 1s 轮询)scan → onDelivered
    CodexAdapter.ts:381-485;⚠️ 只在 phase hold 确认后才 start(codex-phase-lifecycle.ts:372-400)
    ⚠️ 且只有 phaseKeepAlive runner 才会创建(CodexTmuxAdapter.ts:515-541)
[7] onDelivered → db.enqueueRunnerPhaseWake(execId, message) → runner_phase_wakes 表
    flywheel-comm/src/db.ts:2635-2731
[8] daemon hold 循环 observe pending wakes → reactivateWake:
    startTurn(threadId, "[phase-wake <id>] <content>") + setGoalStatus("active")
    claude-runner/src/codex-daemon-client.ts:1223-1232, 872-931
```

**结论:issue 里想象的「投递腿注入」不用新建 —— 它就是 [4]→[8],但断在三处(§2)。**

## 2. 三处断裂/缺口(病根定位)

### 断裂 ①:投递闸把停驻 runner 误判 terminal → 信直接 DEAD(最上游,一票否决)

- mailbox lane 的收件人活性用 `resolveRunnerRecipientState`(`StateStore.ts:5524-5534`),其 terminal 集 = `OUTCOME_STATUSES` **+ `awaiting_review`** − `approved_to_ship`(`StateStore.ts:371-390`)。
- 后果:implement runner 跑完 `complete --route needs_review` 停驻(status=`awaiting_review`)后,Lead 发的信在下一 tick 被 `reconcileExpiredLeases` 判 `DEAD recipient_terminal`(`mailbox-queue.ts:1415-1432`),**根本走不到最后一公里**。
- 生产实录:FLY-1731 exploration §2.4(PM Lead 发给 runner 的 3 条消息全部 DEAD,发信方拿到成功)。
- 对照:Bridge wake 路径用的是**更窄的** `WAKE_TERMINAL_STATUSES`(`operational-terminal-status.ts:21-29`,**不含 awaiting_review**),对 awaiting_review runner 放行(`runner-wake.ts:122-142`)。**两套 terminal 口径不一致**。
- 各停驻态在 mailbox 视角的现状:`running`/`design_done`/`ship_parked`/`approved_to_ship` = alive ✅;`awaiting_review` = terminal ⚠️。
- 关联在途工作:FLY-1731(PR #819/#822 pending)正在收口「活 runner 被误判终态」的邻近 seam(question 准入 FSM reachability)。本单 implement 时须 JIT 对账,避免双改一处。

### 断裂 ②:batch 模式下唤醒入队崩溃 → watcher 送到了也注入不了(高置信,待实跑复现)

- batch 模式默认开(`FLYWHEEL_MAILBOX_QUEUE !== "0"`,`config/src/feature-flags/mailbox-queue.ts:2-6`)。
- 组批 envelope 的 `metadata.flywheelId = "mailbox-batch:<uuid>#r<n>"`(`runner-mailbox-lane.ts:173,186`)。
- watcher `onDelivered` 把它当 `sourceInstructionId` 去 `mailbox_message_projection` 查行,查不到 → **`throw "bound instruction ... not found"`**(`db.ts:2651-2655, 2678-2694`)。
- 异常被 `CodexAdapter.ts:462-468` catch + 打日志,消息不 ack、不进 delivered 集合 → 每次 scan 重试再抛 → **phase wake 永远不产生**。
- envelope 的 `metadata.memberIds`(真实成员 instruction id 列表,`runner-mailbox-lane.ts:188`)目前无人消费(全仓 grep 仅 `:64` 用 durableBatchId 置 verified)。修复的天然材料就在信封里。

### 边界 ③(复核后从"缺口"降级为"诚实边界"):停驻形态 B 只存在于 phaseKeepAlive runner

- watcher **和** phase lifecycle 都只在 `ctx.phaseKeepAlive`(= `isCodexRunner && shareParentBranch === true`,`Blueprint.ts:1642-1651`)下创建(`CodexTmuxAdapter.ts:515-541`,phaseLifecycle 同块 `:529-540`)。
- 非 phaseKeepAlive 的 codex runner **没有 hold 可进**:goal terminal → `settleTerminal` → break → teardown = 形态 A,信按死信闸兜底。**不存在「停驻但唤不醒」的第三态**,本单不放宽 lifecycle 语义(1751/1764 两例都是 shared-branch DAG runner,在形态 B 内)。
- watcher 在 `confirmHoldPaused()` 才 start、`leaveHold()` 即 stop(`codex-phase-lifecycle.ts:372-400, 423-426`)—— goal 进行中信落 JSON 没人读,**但 hold 进入时的首次 scan 会补读存量消息**,天然覆盖「停驻时信已在箱」。

## 3. 停驻形态学(哪些能救、哪些不归本单)

| 形态 | daemon | 现状 | 本单处置 |
|---|---|---|---|
| B. phase hold(declare `park` → `enterPhaseHold`,goal paused,观察窗在;仅 phaseKeepAlive runner 存在) | 活 | 1751/1764 人肉戳的场景 | ✅ 主靶:修断裂①② |
| B′. 非 phaseKeepAlive runner 的"停驻" | — | **无此形态**:无 phase lifecycle → park 即走 goal terminal → 形态 A | ❌ 按形态 A 处置,不放宽 lifecycle |
| A. goal terminal → `runGoal` 返回 → teardown(killWindow + runtime.stop) | 已拆 | 信按「terminal → DEAD → 死信给 Lead」既有规则 | ❌ 不归本单(重派/复活是 Lead 决策) |
| A′. teardown 未跑到的僵尸 | 不定 | pane-loss / reconciler 领域(FLY-1628) | ❌ 不归本单 |

停驻判定的三套概念(勿混):CommDB `runner_declared_states`(`park`/`busy`/`unpark`,对投递零影响)、Codex phase hold(`session.json.phaseHold`,由 declared park 触发,`codex-daemon-client.ts:1233-1236`)、StateStore `session.status`(唯一影响投递生死,断裂①)。

## 4. notify 通道现状(FLY-1571)与本单的增量

- 每个 runner 的 config.toml 已写 `notify = ["~/.flywheel/hooks/runner-stop-notify.sh", "--codex"]`(`codex-home.ts:637-658`;`CodexTmuxAdapter.ts:407-412` 硬编码路径)。渲染器强约束**恰好一个** root notify,断言 argv 恰为 `[path, "--codex"]`(`codex-home.ts:680-690`)。
- 现钩子 = notify-only reporter:过滤 `type=="agent-turn-complete" && client=="codex-tui"` → 前台只写 turn-boundary ledger(flock)→ detach + 12s watchdog 调 `flywheel-comm runner-stopped` → 给 Lead 插 `RUNNER-STOPPED` report(`scripts/hooks/runner-stop-notify.sh:26-33, 69-171`;`runner-stopped.ts:433-591`)。**无任何回灌**。头注释已预留「blocking Stop hook 归 FLY-1569 batch G」的前向合同。
- **实测硬约束**(FLY-1571 plan.md:224-226 真机 spike):codex 主回合**会等 notify 程序退出才接受下一 turn** → 回灌必须走 detach 段;子 agent turn 也触发 notify(`client=null`)→ 必须保留 client 过滤;daemon env 原样传给 notify 子进程(`FLYWHEEL_EXEC_ID`/`FLYWHEEL_COMM_DB`/`FLYWHEEL_COMM_CLI` 等全可用,`CodexTmuxAdapter.ts:1435-1457`)。
- 部署缺口:`runner-stop-notify.sh` 不在 Bridge 自动部署列表(`sync-flywheel-hooks.ts:51` 只有 `inbox-check.sh`),靠手动 `/setup-flywheel-hooks`。**本单要收口** —— 且因为本单只改 hook 脚本、不改 config.toml 渲染值,存量 live CODEX_HOME 无需重写即获得新行为。
- 未决实测项:无观察窗(pane 拆除 fail-open)时 payload 的 `client` 取值未被任何 spike 覆盖 → 进 QA 清单。

## 5. 租约重投兜底(FLY-1573)—— 基本免费,两处要留神

- `reconcileExpiredLeases`(`mailbox-queue.ts:1317-1568`)在 runner lane tick 开头跑(`runner-mailbox-lane.ts:235-243`);正常重投分支**原地回 QUEUED、lease_retry_count+1、不 INSERT**(`:1539-1549`),同一 tick 内紧接着被重新 claim → **重新走一遍 [3]→[8] 全链** → 注入天然重试 ✅。
- 重投能穿透 transport 幂等:重 claim 生成全新 `mailbox-batch:<uuid>` 且 `#r<n+1>`,flywheelId 必不同(`mailbox-queue.ts:1202` × `CodexAdapter.ts:140-154`)✅。
- 留神 1 —— **frozen resend 会被幂等吞**:整批 `delivered_at` 全 NULL 的到期批走 frozen 分支(`:1511-1520`,batch_id/retry 计数都不变)→ flywheelId 相同 → 若上次 write 已落盘且已被 watcher ack,重投命中 dup 静默返回,不触发新 watcher 事件。良性面:那种情况说明 wake 已入队过;但设计上须标注这个洞,不许在它之上再叠不变量。
- 留神 2 —— lane 只消费 `reconcileExpiredLeases().dead`,`requeued`/`frozenResend` 被丢弃(`runner-mailbox-lane.ts:244`;返回值形状 `mailbox-queue.ts:46-53`)—— 如需「重投瞬间」单独动作,这里是现成信号点;但本设计选择统一挂 `deliver`(重投复用同一投递动作),不消费该返回值。

## 6. 注入原语与 ack 纪律

- 注入 = `reactivateWake()` 现成模板:`startTurn(threadId, "[phase-wake <id>] <content>")` + `setGoalStatus("active")`(`codex-daemon-client.ts:872-931`)。协议级,不碰 tmux。
- 外部进程可凭 execId 独立连 daemon(socket = execId 纯函数 `resolveDaemonSocketPath`,`codex-daemon-runtime.ts:65-74`;threadId 落盘 `codexSessionStateDir(execId)/session.json`)—— 但本设计**不需要**外部直连:notify 腿只入队 `runner_phase_wakes`,注入统一由 daemon hold 循环执行(单一注入者,避免双客户端竞态)。
- **ack 纪律(FLY-1569 铁律 1)**:`flywheel-comm inbox` 会逐条 ack(`inbox.ts:17-37` → `MailboxQueue.ack`)。**任何自动腿都不得替 agent 跑 inbox/ack** —— 唤醒腿只能「读未读计数 + 入队 wake」,ack 必须由醒来的 agent 自己跑 inbox 完成。
- `runner_phase_wakes` 入队按 `sourceInstructionId` 绑定真实 mailbox 行(`db.ts:2678-2694`),幂等语义按 wake 行状态机(pending/started/finished,`codex-phase-lifecycle.ts:281-310`)。

## 7. 已知风险与开放项(带去 plan)

1. ~~`send.ts:32` 清 park marker 与 hold 生命周期的竞态~~ **已复核推翻**:hold 循环的 `held` 分支只 observe wake + `waitForPhaseActivity`,**不重读 declared marker**(`codex-daemon-client.ts:1224-1231`;`observeBoundary` 仅在非 held 时用于进 hold `:1233-1236`)—— hold 是黏性的,退出只经 `reactivateWake`/transport close。send 清 marker 不拆唤醒路径。另复核:`waitForPhaseActivity` 有界 15s(`codex-daemon-client.ts:795, 811-817`),**外部进程入队的 wake 最迟 15s 被 hold 循环消费**(即使无 signalActivity)。
2. **FLY-1731 在途重叠**(断裂① seam):PR #819/#822 pending。implement 节点 JIT rebase 后对账,避免同一 seam 双改。
3. **断裂② 是静态推理**(高置信,标注「未实跑验证」):QA 必须先复现(停驻 phase-hold codex runner + batch send → 观察 `bound instruction not found` 日志)再验修复。
4. **`client=="codex-tui"` 在无 pane 场景的取值**未验:若 machine-client-only 时 client 取其他值,notify 腿在无窗 runner 上静默失效 → QA 实测项。
5. **修断裂① 的爆炸半径跨 vendor**:mailbox recipientState 对齐 wake 口径后,Claude runner 的 awaiting_review 信也从「立即 DEAD」变为「正常投递」——这是修复 FLY-1731 实录事故的正向效果,但须在 plan 里显式声明并在 QA 加 Claude 对照组。
