# FLY-1501 耳朵与守护 — v2 终稿映射
Issue: FLY-1501
日期: 2026-07-27
基于: `/tmp/v2arch/v2-final-design.html`、`plan.md`

## 0. 权威、边界与终态

本映射以 founder 已批准的 v2 完整终稿为方向权威，并采用
`[lead-instruction 3348b096-1140-415b-b782-cdf741ce7149]` 明确落下的默认项：

1. actions 黑匣子保留；
2. heartbeat 列保留，由 FLY-1499 建列，调度侧只读；
3. generation 保险丝保留；
4. ship 门采用「节点完成事务内查询 DAG + founder 批准落 `gates` 绑 head」。

FLY-1501 收敛后的专属范围是**耳朵与守护**：

- 两个 vendor 注入垫片：Claude 原生 mailbox 文件、Codex daemon 短连接；
- 有 pending 信时的 heartbeat 停滞自动重启；
- kernel 外 restart ledger、AIMD 重启节奏、fcntl fail-closed 总闸；
- 长观测 QA 的提交凭据预约窗口；
- `codex-review-result` 查询形写入 footgun；
- v2 调度侧 48G 主机内存水位的真实传感器默认值重校。

以下方向整块作废且不留兼容后门：W1 obligations payload 迁移、W2
聚合告警病历卡族、父压子、三 tier 通知、restart spool → obligation 投影，以及
C4 `ownerLeadId`。本单不创建、不查询、不消费 obligation，也不新增 dispatcher
执行者、认领、路由或消息内容处理。

## 1. 终稿 → FLY-1501 映射

| 终稿裁定 | 当前分支实现 | 处置 | 收敛后的唯一口径 |
|---|---|---|---|
| 病历卡族作废，不留后门 | W1 `0005-obligations-payload`；W2 mailbox-age/suppression/tiers；restart spool 投影 | **整块删除** | 无聚合卡、episode、父压子、notification debt、tier、自动销卡或 restart obligation |
| C4 `ownerLeadId` 随病历卡作废 | `AgentIdentity` additive owner 字段、解析/比较及测试 | **整块删除** | v2 identity 不新增 owner；消息改投/管理链属于 mailbox/consumer 终态，不由本单另建归属字段 |
| agent 只有各家耳朵不同 | W4 尚未落码；C5 已在 FLY-1499 冻结 | **新增两实现，不改接口** | Claude 写原生轮询 mailbox；Codex 每次临时连 active daemon 调 `turn/start`；新 vendor 只实现 `InjectionShim` |
| 拉为主；hint 可丢 | 旧设计把 hint 当低延迟门铃 | **保留 C5 兼容面，允许 no-op** | durable 进度只靠 mailbox + consumer 喝干循环；hint 不能成为活性或正确性前置 |
| 有信且 heartbeat 停才重启 | 当前分支未实现 | **新增 fail-closed scheduler-once 读路径** | 仅覆盖 launchd 托管 Lead；必须 pending + 独立 heartbeat 停 + exact generation；同一 DB 事务取得 lease、把旧 running attempt 终态化为 `crashed` 并释放占位后，才可在事务外 kickstart |
| 反复失败才告警 Lead | 旧 W3 第 6 次 wrapper 启动 hold + 直发 `restart_storm_hold` | **保留总闸，删除病历卡投影** | kickstart 后确认 heartbeat；未生效则有界重试，每次真实 attempt 恰计一次；只有 brake 触顶才经 kernel-independent `lead-alert.sh` 告警 Lead，零卡片零档位 |
| 调度只做「看库 → 拉进程」 | 现有 W3 只在 5 个 launchd wrapper 守门；无 heartbeat reader | **补短命 scheduler-once，不扩权** | 单一 OS timer backend 周期调用有硬超时的短命进程；每轮 level-trigger 重查 pending/heartbeat/config 并请求 kickstart；不读 payload、不路由、不执行业务 action |
| restart brake 使用 kernel 外权威账 | `restart-storm-gate.py` append-only ledger + state + fcntl + wrapper wiring 已落 | **保留骨架并收敛** | ledger/lock 在 flywheel-v2.db 外；所有 gate/resume/heartbeat restart 写者共用 child lock；锁失败不 launch |
| 重启节奏读内存水位并默认收紧 | 当前 gate 为固定 10min/5 次；旧 v1 水位 monitor 的 swapout noise floor=0 | **新增 v2 水位 seam + AIMD，v1 不改** | 默认并发容量=1；压力触发容量减一、健康安静窗加一；48G swapout floor 按 RAM/page size 推导；env 只能在健康有余量时放宽 |
| QA 长观测要先预约软窗 | W5 `submissionWindowMinutes`、QA=180min、absolute deadline=24h 已落 | **保留并补回归** | dispatch/repair/replay 开跑时按节点类型铸造/轮换凭据；`expiresAt=min(now+预约窗, absoluteDeadlineAt)`；absolute deadline 不刷新 |
| 查询与写入分动词 | `codex-review-result` 已要求 explicit exec/head | **保留** | 无参/缺参/非法 SHA 只打印 usage、非零退出、零网络写；写入必须显式 `--exec-id` + 40 hex `--pr-head` |
| 48G 机不再被旧 16G 噪声线白挂 | 当前 W6 只 tombstone 了零读取方的旧旋钮；v2 scheduler 尚无水位 sampler | **补 v2 规格推导与边界测试** | 启动读 `hw.memsize`/page size；swapout floor=`max(2048,RAM/1024/pageSize)`；free trigger=`max(8%,2GiB)`、clear=`max(15%,4GiB)`；不改批次4将删除的 v1 monitor |

## 2. 已写代码 disposition

### 2.1 整块删除

以下均为当前 FLY-1501 分支新增或修改，终稿已判定与方向相悖：

- W1：
  - `packages/v2-kernel/src/migrations/0005-obligations-payload.ts`；
  - `packages/v2-kernel/src/migrations/index.ts` 中 0005 注册；
  - `obligations-migration.test.ts`、`backup.test.ts` 中仅服务 0005 的增量断言。
- W2：
  - `packages/v2-kernel/src/alerts/mailbox-age.ts`；
  - `packages/v2-kernel/src/alerts/suppression.ts`；
  - `packages/v2-kernel/src/alerts/tiers.ts`；
  - `mailbox-age-alerts.test.ts`、`alert-suppression.test.ts`、
    `alert-tiers.test.ts`；
  - `packages/v2-kernel/src/index.ts` 中上述所有导出及相应 public API 断言。
- restart → 病历卡投影：
  - `packages/v2-kernel/src/alerts/restart-storm-reconcile.ts`；
  - `restart-storm-reconcile.test.ts`；
  - kernel public export；
  - `restart-storm-gate.py` 中只为投影服务的 spool/applied/quarantine、
    `validate`、`mark-applied` 子命令与测试。
- C4：
  - `packages/v2-kernel/src/fence.ts` 的 runner `ownerLeadId`；
  - `fence-registry.test.ts` 中 owner 双形/精确比较断言；
  - 任何计划中的新 owner consumer。

`origin/main` 已有的 obligations 基础 schema 不是本分支新增，不能由本单越界改写
历史迁移；本单将其标记为 schema owner 待清算，当前分支做到**零新增 consumer、
零新增列、零新增导出**。

### 2.2 保留并收敛

- W3 restart brake：
  - 保留 `scripts/restart-storm-gate.py` 的 child key 校验、append-only
    seq ledger、partial-tail 恢复、原子 state、fcntl lock、gate/resume/status；
  - 保留 bridge/voice-bridge/Lead/quota-monitor/cmux 五个既有 supervised 入口的
    pre-exec gate wiring；短命 `scheduler-once` 不是第六个被守护常驻服务，不新增
    自身 restart child；
  - 保留 `ProjectConfig` 派生 child key 边界校验；
  - 保留稳定 `restart_storm_hold` kind 与 `lead-alert.sh` 直达腿，但它只能由
    brake 触顶产生；`LeadWatchdog.ts` 中仅保留类型/文案兼容，不增加 timer 或检测器；
  - 删除 spool 后，held episode 的本地审计事实只在 restart ledger/state；
    `held_alert_pending` + 每次 gate/`record-failure` 的 `_recover_pending` 承担重试，
    只有 `lead-alert.sh` 返回 sent/queued_transient 才进 `held_alert_attempted`；
    stable signature + sink debounce 只负责去重，不冒充 at-least-once 重试；
  - 新增 `record-failure --expected-seq`：仅当 launchctl/确认窗失败且 wrapper 没有
    推进 ledger 时，锁内 append 一条现有 `{seq,ts}` attempt 并跑同一 brake
    谓词；`expected-seq` 不匹配即 no-op，保证一次 repair 恰计一次且不改 ledger schema。
- W5 QA 预约：
  - 保留 `submissionWindowMinutes` manifest/override 校验；
  - 保留 QA 模板默认 180 分钟；
  - 保留 dispatch、idempotent replay、delivery repair 的同源 expiry 计算；
  - 保留 24 小时 absolute deadline 且不允许轮换越过。
- W6 CLI footgun：
  - 保留 `flywheel-comm` 显式参数检查及“校验前零 fetch”测试；
  - 保留废弃的 `FLYWHEEL_SWAP_PRESSURE_{HIGH,LOW}_PCT` tombstone；不把零读取方
    假旋钮复活成 v2 配置。

### 2.3 新增

1. **ClaudeInjectionShim**
   - 落在 `packages/v2-engine/src/injection/claude-shim.ts`；
   - `flywheel-v2-engine` 单向依赖 `flywheel-agent-team-transport`，后者不得反向
     import engine；本单把 `writeMailboxEntry` 补进 transport root export；
   - 复用 `flywheel-agent-team-transport` 的 `ClaudeMailboxCodec`；
   - `sessionRef` 仅由 adapter 解析，engine 原样透传；
   - `deliver` 写 stock-compatible mailbox，`flywheelId=messageUid`；
   - `hint` 可 no-op，活性来自 Claude 原生 1 秒 poller；
   - shim 自身零持久状态。
2. **CodexInjectionShim**
   - 落在 `packages/v2-engine/src/injection/codex-shim.ts`；
   - `flywheel-v2-engine` 单向依赖 `flywheel-claude-runner` 的公开
     `connectDaemonTransport`/`CodexDaemonClient`，不经过 teamlead，依赖无环；
   - `sessionRef` 仅由 adapter 解析为 active daemon/thread 寻址；
   - 每次 `deliver` 创建临时 `CodexDaemonClient`，以有界 connect/RPC timeout
     完成 initialize 后调 `turn/start`，success/error/timeout 均在 `finally` close；
   - 不写 Codex teams mailbox，不加 paused-hold 第二通道；
   - 重复 deliver 允许产生重复 turn，由同一 `messageUid/attemptUid` 的消费事务
     幂等收敛；不宣称 vendor 恰一。
3. **Heartbeat guard**
   - 新增 `packages/v2-scheduler`，由唯一 OS timer backend 周期调用短命
     `scheduler-once`；进程有硬超时，安装时 fail-loud 并自证 timer 可触发；
   - `scheduler-store.ts`/`scheduler-once.ts` 读 FLY-1499 的 heartbeat 列与
     mailbox pending；
   - heartbeat 由 consumer shell 的独立 fenced timer 刷新，不能只在 mailbox
     SELECT 后刷新；长 tool/LLM turn 期间 timer 仍应运行；
   - DB lease 是唯一正确性边界；每轮在事务内选择
     `pending > 0 AND last_poll_at < now-staleThreshold`、同 generation active 的
     launchd Lead，并在同一事务把该 generation 的 running attempt 终态化为
     `crashed`、释放占位；事务外调用 launchd；
   - kickstart 后进入确认窗，必须观察 exact generation 更替或 `last_poll_at`
     推进才成功；未推进走 backoff 后重试，直到成功或 brake held；
   - `restart-capacity.ts` 在单次短命进程内维护默认 1 的 AIMD 容量；下次 timer
     触发重新从 1 开始，是安全收紧，不需要第三本持久账；
   - `memory-watermark.ts` 只负责 v2 规格推导/采样，不 import v1 watchdog；
   - guard 不直接发普通告警；其失败升级腿是 `record-failure` 进入同一 brake，
     brake 的 held 状态机是唯一 Lead alert owner。
   - 唯一 backend 禁止与 fallback 并跑；native Windows 只作为以后新增 backend，
     不在本单用第二套 timer 兜底；timer failure domain 到安装自证/系统日志为止，
     禁止再造递归 watcher。

## 3. C5 六条冻结合同（零重谈）

1. `deliver` 可以重复，重复注入必须由消费事务幂等兜底。
2. `hint` 允许 no-op；hint 丢失不得影响 durable 进度。
3. `sessionRef` 是 vendor-opaque 字符串，engine 只从
   `activations.session_ref` 取出并逐字节透传。
4. 接口只有 `hint` / `deliver`，没有 ack；mailbox 结算只经 kernel 事务。
5. 每次 vendor `deliver` 自带不长于 engine 等待上限的 connect/RPC timeout，
   success/error/timeout 三出口均 `finally` 关闭临时资源；返回后活跃临时连接数
   必须为零。
6. 重复 deliver 允许产生重复 vendor turn；不承诺恰一 turn。Claude 的
   `flywheelId=messageUid` 只是现成介质去重，Codex 仍按重复 turn 语义验收。

`InjectionShim` 接口定义仍归 FLY-1499；本单只新增两个实现和 contract tests，
不复制或改写接口。

### 3.1 SessionRef 与 Codex busy-turn 语义

engine 对 `sessionRef` 永远只做逐字节透传；vendor adapter 自己严格解析带版本、
exact-key 的 JSON：

- Claude：`{v:1,backend:"claude",inboxPath,sidecarPath,toAgent}`；
- Codex：`{v:1,backend:"codex",socketPath,threadId}`。

adapter 拒绝 backend/version/key/path 不合法的引用，不猜测、不 fallback 到另一通道。
两家都把 `{messageUid,attemptUid,payload}` 编为同一版本化 vendor 文本 envelope；
Claude 同时以 `messageUid` 作 `flywheelId`。

Codex 对 busy thread 的合同：

1. 不用 `turn/steer`，不在 shim 内建队列或持久化；
2. 每次 deliver 仍只尝试一次 `turn/start`；
3. daemon 若接受，deliver resolve 只表示 vendor 接受注入，不是业务 ack；
   这里的“接受”特指 vendor 输入已进入其持久介质/线程记录，绝不等待 vendor
   后续任务执行完成；任务失败或长跑属于下一生命周期，不能回滚已经成立的投递；
4. daemon 若以 active/busy/race RPC error 拒绝，deliver reject 为 retryable，
   engine 仍是唯一 durable 队列并按 C5 重投；
5. daemon 接受并因 goal 自动续跑产生重复 turn，按 C5 第 6 条允许，由
   `messageUid/attemptUid` 的 kernel 结算幂等收敛；
6. 所有出口仍 bounded timeout + `finally close`，busy 不得泄漏连接。

## 4. 心跳自动重启的最小状态机

### 4.1 选择谓词

```text
mailbox 存在 to_agent 的 pending 行
AND consumer.kind = lead
AND consumer 当前 generation/session 仍 active
AND last_poll_at 非空
AND last_poll_at < now - heartbeat_stale_ms
AND identity 可确定映射为当前 project 的 launchd Lead label/child key
AND scheduler-once 在 DB 中取得该 candidate 的 lease
```

heartbeat writer 是 consumer shell 的独立 fenced timer，不与消息处理循环绑在
一起；长 LLM/tool turn 期间仍刷新。若 heartbeat 已停且仍有 pending，旧
`processing_attempts.outcome='running'` 不能否决修复；它正是失活进程留下的
占位，必须作为修复事务的一部分被终态化和释放。

`last_poll_at` 缺失、读库/lease/终态化失败、identity/generation 不一致、非
launchd consumer 或 label 映射失败均 fail-closed 为“本轮不重启”，因为没有完整
事务证据时杀活会话比延迟恢复更危险。

### 4.2 动作与收敛

1. OS timer 启动一次有硬超时的 `scheduler-once`；每轮 level-trigger 重查，不依赖
   上轮内存状态；
2. scheduler-once 在同一 DB 事务取得 candidate lease，重验 pending + exact
   generation/heartbeat，并把该 generation 的 running attempt 标为
   `crashed`、释放其 processing 占位；任一步失败均不 kickstart；
3. 同一事务提交后读取该 child 的 ledger seq；事务外调用唯一 launchd port；
4. wrapper pre-exec 先走同 child 的 restart gate；若它推进 ledger，本次 repair
   已计数，guard 不再追加；
5. guard 在确认窗内观察 exact generation 更替或 `last_poll_at` 推进；任一发生即
   成功并清除 candidate backoff；
6. launchctl 非零、确认窗超时或 label 未 loaded 且 ledger seq 未推进时，调用
   `record-failure --expected-seq <before>`；它在 child fcntl lock 内 append 一条
   现有 `{seq,ts}` attempt 并跑同一 brake，seq 已变化则幂等 no-op；
7. 未 held 时本轮可按 AIMD/backoff 继续；进程到硬超时即退出，下个 OS timer
   tick 重新 level-trigger 形成 candidate，DB lease 阻止重叠/重复动作；
8. held 时 `record-failure`/后续 gate 调 `_recover_pending`，只有其
   `held_alert_pending → held_alert_attempted` 状态机直告 Lead；
9. 无 obligation、无 tier、无“已通知/被抑制”状态。

确定性命名只覆盖 v2 Lead consumer：

```text
identity = {kind:"lead", leadId}, schedulerConfig.projectName, uid
jobLabel = gui/<uid>/com.flywheel.lead.<projectName>-<leadId>
childKey = lead.<projectName>-<leadId>
```

`projectName`/`leadId` 必须通过现有 `ProjectConfig`/`SAFE_ID` 与 child-key
round-trip 校验；unknown/runner/不匹配一律不动作。Runner 是 tmux/cmux session，
没有 launchd label；其离线冷启动/替换由 FLY-1510 承接，本单不把 runner 猜成
某个 OS job。

### 4.3 AIMD 与内存水位

冻结材料：`/tmp/v2arch/pending-edits-for-v2.md` 第 97 行起。只借 Kimi
`subagent-batch.ts` 的队列/AIMD 骨架，不借它的 429 传感器、无上限默认或
“尽量拆 128 agents”的提示词。

v2 scheduler 的唯一水位 sampler 在启动时读取 `hw.memsize` 与 page size：

```text
swapout_min_pages_per_tick = max(2048, RAM_bytes / 1024 / page_size)
free_trigger = max(8% RAM, 2 GiB)
free_clear   = max(15% RAM, 4 GiB)
```

`RAM/1024` 是冻结材料所说“约 0.1%”的精确整数定义。48GiB、16KiB page 的
swapout floor 为 3072 pages/tick（48MiB），不再让
单页 swapout 把 pressure hold 白挂。trigger/clear 使用同一采样与 config，
维持 hysteresis；水位未知按 pressure 处理，不能用未知值扩大容量。

restart candidate 队列的 AIMD 冻结为：

1. 默认并发容量=1，且总有一个有限上限；
2. 每次新 pressure 触发，容量减一，最低 1；2 秒内至多减一次；
3. 被限 candidate 插回队首，仍绑定同一 agent/generation，不换 owner；
4. 连续 3 分钟无 pressure 触发，容量加一；每安静窗口只加一次，不超过配置上限；
5. env 只能声明上限，且只有实时水位健康、有余量时才允许容量高于 1；
6. 若被限 candidate 已是队列最后一个未完成项，不无限重排，直接返回
   `memory_limited` 结束**本轮 repair batch**；pending+stale 是 level-trigger，
   下个 scheduler tick 可在水位恢复后重新形成 candidate；
7. `memory_limited`/pressure decline 不是 restart attempt，**不写 restart
   ledger、不消耗 brake 额度、不发告警**；需要观察时只写 scheduler diagnostic/
   metric，不能改 `{seq,ts}` ledger schema；
8. 每个短命 scheduler-once 进程都从 capacity=1 开始（安全默认）；
   restart ledger/brake 仍是 durable authority，AIMD 不建立第三本持久账。

### 4.4 数值与 env 治理

本单不新增 boolean feature flag。新 scheduler 数值统一进入
`SchedulerConfig`（公共构造参数 + 单一默认对象；批次3生产接线从终稿的 canonical
config 读取），测试显式注入；禁止在模块内散落第二份数字。

- `heartbeatStaleMs`、`heartbeatConfirmMs`、retry/backoff、2 秒减速窗、3 分钟
  安静窗、free trigger/clear 与 swapout floor 都是 `SchedulerConfig` 字段；
- 唯一允许的 env 放宽面是 `FLYWHEEL_V2_RESTART_CONCURRENCY_MAX`，登记
  `NON_FLAG_ALLOWLIST` 为 capacity tuning knob；实时水位不健康/未知时即使 env
  更大也钳回 1；
- 既有 `FLYWHEEL_RESTART_STORM_GATE` 关闭开关与“刹车始终开启”冲突，删除并
  tombstone，不保留 bypass；
- `FLYWHEEL_RESTART_STORM_WINDOW_SEC`、`FLYWHEEL_RESTART_STORM_MAX`、
  `FLYWHEEL_RESTART_STORM_LOCK_DEADLINE_SEC` 登记为 numeric tuning knobs；
- `FLYWHEEL_RESTART_STORM_GATE_BIN`、`FLYWHEEL_META_ALERT_BIN`、
  `FLYWHEEL_LEAD_ALERT_BIN` 登记为 executable-path plumbing；
- `FLYWHEEL_RESTART_STORM_FAULT` 只在 test process 注入，不进入生产启动环境。

`SchedulerConfig` 的解析/校验只属于短命 scheduler failure domain：配置缺失或矛盾
时该轮 scheduler fail-loud/不执行 restart，但不得阻断、停掉或降级 agent 自己的
mailbox poll/consume loop。

### 4.5 Scheduler 启动与 failure-domain 终点

`packages/v2-scheduler` 只提供有界的 `scheduler-once`。生产安装选择恰一个 OS
timer backend 周期执行它；不是 KeepAlive daemon，也不新增 `v2-scheduler`
restart child。合同冻结为：

1. DB lease 是跨 tick、重叠进程与手工触发的唯一正确性边界；
2. 每轮 level-trigger 重查，进程有硬超时，超时退出后下轮从 DB 事实重建；
3. 同一安装只能启用一个 backend，禁止 fallback 与主 backend 并跑；
4. 安装必须 fail-loud，并自证 timer 已注册且能真实触发一次 bounded command；
5. command 写 durable run receipt（started/finished/result/host/backend），只有
   完整 sweep 成功才推进 `last_scheduler_success_at`；本单不基于它新增 Lead 告警；
6. “谁看着 timer”的 failure domain 到 OS timer 状态/系统日志及既有外部 infra
   probe 为止，禁止递归
   watcher；timer 自身失效不产生另一张卡或另一条告警腿；
7. native Windows 视为以后新增的 backend，不在本单用常驻 Node 进程模拟。

## 5. TDD 公共 seam 与验收矩阵

测试只走以下公共 seam，不测私有函数或内部调用顺序：

| Seam | 先红行为 |
|---|---|
| `InjectionShim` 两实现 | surface 恰 hint/deliver；opaque sessionRef 原样；无 ack；重建后继续 |
| Claude mailbox codec | deliver 后 stock poller 可见；同 messageUid 重投无害 |
| Codex daemon adapter | idle/busy accepted/busy rejected/error/timeout；retryable reject；所有出口 close 恰一次且活跃连接归零；同 handle 重投允许多 turn |
| heartbeat guard tick | 无 pending/heartbeat 新鲜/未知/runner/映射失败不 kickstart；Lead pending+stale 恰触发；running attempt 同事务转 `crashed` 并释放占位；generation 漂移不杀 |
| launchd mapping | lead identity + project + uid 精确得到 jobLabel/childKey；unknown/runner/非法 id fail-closed |
| kickstart confirmation | heartbeat/generation 推进成功；未推进有界 backoff 重试；launchctl error/held/PID-lock 不静默；每真实 attempt ledger seq 恰增一 |
| restart gate CLI + scheduler capacity | fcntl 竞争 fail-closed；`record-failure --expected-seq` CAS；ledger crash replay；2s 减速、3min 增容、默认/最低 1、最后项本轮失败；触顶后不 exec 且只发稳定 Lead alert |
| memory decline | `memory_limited` 不写 `{seq,ts}` ledger、不消耗 brake；下个 level-trigger tick 可重试 |
| QA credential public dispatch | QA 180min、非 QA 默认窗、repair/replay 同源、absolute deadline 不刷新 |
| `flywheel-comm` CLI | 无参/缺参/非法 SHA 非零 usage 且零 Bridge write；显式合法参数才写 |
| v2 memory watermark | 48G/16KiB→3072 pages；2/4GiB absolute floors；swapout noise 不白挂；未知不扩容；v1 monitor 零修改 |
| config truth | 新 cap 与 W3 numeric/path knobs 全登记；关闭 gate flag tombstone；test fault seam 不进生产 env |
| scheduler-once 安装合同 | 单一 OS timer、DB lease、level-trigger、硬超时、安装 fail-loud 自证、无并行 fallback/递归 watcher；Windows 仅为新 backend |
| 删除守卫 | kernel public API/迁移表无 FLY-1501 W1/W2/C4；全仓无 mailbox-age/suppression/tier consumer |

TDD 采用纵切：每个 seam 一条失败行为 → 最小实现 → 下一条；不先写整批测试，
不 mock 自有模块，只在 filesystem、daemon、launchctl、时钟等系统边界注入 port。

## 6. 反 over-reaction 检查

| 机制 | 已枚举场景 | 为什么基础根治仍不够 |
|---|---|---|
| Claude/Codex 两垫片 | 同一 mailbox 消息要进入两种耳朵完全不同的活跃会话 | SQLite 防丢和消费循环只证明“有信”，不能把信送进 vendor 会话 |
| heartbeat 自动重启 | launchd Lead 有 pending、独立 heartbeat 停，旧 running attempt 仍占位 | durable mailbox 保证不丢信，但不能恢复真正停止轮询的进程；修复事务必须同时清掉孤儿 attempt 才不会把新一代卡死 |
| restart ledger + brake | launchd/heartbeat repair 遇到未知持续 crash 会无限重试 | 修掉某次已知 crash 原因不能覆盖下一种 crash，也不能限制 OS supervisor |
| fcntl fail-closed | launchd、手工 resume、heartbeat kickstart 并发改同一 child | append-only 文件本身不提供跨进程互斥，竞争会双计数或损坏 state |
| AIMD | 内存压力时同时复活多个服务会放大 OOM/换页 | 固定次数上限只决定何时停，不能在到顶前降低复活速率 |
| QA 预约窗 | 50min–2h 真机长观测跨过默认 30–60min 软窗 | absolute deadline 限制最长寿命，却不保证这次已知长跑在软窗内可提交 |
| CLI 显式写参数 | 无参“查询”曾真实写入 APPROVED | 文档提醒不能把读写动作分开，CLI 必须在网络调用前结构性拒绝 |

### 6.1 单列供 founder 砍的保护层

- restart ledger 每事件 fsync、state 原子 rename + 目录 fsync；
- fcntl lock 竞争 fail-closed；
- AIMD 内存压力退避；
- restart brake 触顶后的 kernel-independent Lead alert；
- Codex 临时连接 bounded timeout + `finally` close；
- heartbeat exact generation + DB lease + running-attempt 原子终态化；
- kickstart 效果确认 + 有界 backoff + expected-ledger-seq 去重。

这些保护层不获得消息路由、业务执行或告警分级权。若裁剪，只能降低 crash/并发
保护强度，不能复活 obligation、tier、watchdog 或 dispatcher 中枢。

### 6.2 病历卡删除后的覆盖归属与历史材料

founder 明裁病历卡/watchdog 后，系统**有意不再对“heartbeat 新鲜但 backlog 年龄
增长”发一张状态卡**。该场景不是无人负责：

- heartbeat 停且仍有 pending：`processing_attempts.outcome='running'` 不构成
  veto；scheduler-once 在取得 DB lease 的同一事务把它标为 `crashed`
  并释放占位，然后才允许事务外修复进程；
- retry/dead/毒消息：`retry_count`、`next_retry_at`、第 N 次 dead + 原业务信改投
  Lead 归 FLY-1499 consume-loop/disposal；Lead route 必须由 host 显式输入，不得把
  C4 `ownerLeadId` 换皮复活；
- consumer 离线且非 launchd Runner：冷启动/替换归 FLY-1510；
- heartbeat 新鲜且状态机本身还能推进时，不另建 detector；若 FLY-1499 的
  retry/dead 事务机制本身失效，这是其事务/活性验收失败，不由 1501 再套
  watchdog。

这是一项 founder 已批准的噪音/复杂度取舍，不是隐藏的第三条接口依赖。

`founder-design-FLY-1501.html` 与 `design-correction.md` 中关于“30min 病历卡、
99 条聚合、2h/8h 档位、管理链通知”的说明已被本轮终稿推翻，标记为历史材料，
不得再作为实现或验收依据；当前 founder 权威是
`/tmp/v2arch/v2-final-design.html`，本映射是 FLY-1501 的新范围说明。founder 已
批准该终稿，当前未要求再发布一份旧式单卡 HTML。

## 7. 跨单依赖（只保留两条）

1. C5 `InjectionShim` 接口由 FLY-1499 冻结，本单原样实现，零重谈；当前分支已
   接入 FLY-1499 的最终 serial-polling engine，再叠加 Claude/Codex 两个实现。
2. heartbeat 列与 consumer 独立 fenced timer 由 FLY-1499 建，本单调度只读；
   当前分支已接入 FLY-1499 的 `0005-agents-config-mailbox-rebuild`，scheduler
   fixtures 直接使用正式迁移创建的 `agents`，不再自建影子表，也未把 heartbeat
   刷新退化为 mailbox SELECT 后的顺带动作。

除此之外无跨单接口。C4 `ownerLeadId` 已作废；FLY-1498/1500 不需要提供
obligation、dispatcher executor、claim 或 notification contract。
