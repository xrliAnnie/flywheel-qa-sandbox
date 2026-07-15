# FLY-1048 Watchdog detection 剩余实现 — 调研

Issue: FLY-1048 (https://linear.app/geoforge3d/issue/FLY-1048/build-fly-942-watchdog-detection-剩余实现prd-fly-942排除已-ship-的-watchdog)
日期: 2026-07-09
基于: exploration.md(同文件夹,缺口清单 + brainstorm gate 拍定)

> Gate 拍定回顾(Tadashi):4 个 BI 全归 1048、3-PR 切法(A 机械 / B LLM / C 升级流+BI-4)、整体 done 才算 done;FLY-976 作 PR-B 吸收后关闭;统一 ~30min 流只管新检测类、FLY-637 阶梯原样保留;FN4 独立小块;**(a) 不自建 tmux 探活(真探活归 FLY-820/823,只消费信号)、(b)「投递了但 N 分钟未消费」纳入检测目标、(c) 三种失败模式的阈值/给谁由 HL 更新 942 PRD,eng 按 PRD 对接不自定产品行为**。

---

## 1. 现状信号链(实现要挂的钩子,全 code-grounded)

### 1.1 Lead 侧 pane 链(LeadWatchdog.ts)
`tickLead` → `ownStateRegion`(剥 `←` echo + 告警 echo,:795-803)→ `liveRegion`(锚输入框顶 `INPUT_BOX_TOP` :710,fallback 末 12 行,:723-738)→ `classify`(BLOCKED_KEYWORDS 四类,:138-154)→ `isTransientThrottlePane`(529 短路,:909-950)→ `isIdleHealthyPane`(单帧白名单抑制,:826-841)→ 3-cycle `pane_hash_stuck`。状态 `leadStates: Map`(:162)纯内存;`liveHash` 只哈希去 echo 区(:315),`eventId` 刻意全屏哈希与 lead-alert.sh claims.db 对齐(:446)。捕获 = `defaultLeadPaneCapture`(lead-alert-helpers.ts:259-273,200 行,timeout 5s)。

### 1.2 Runner 侧链(RunnerIdleWatchdog + stuck-candidate + stuck-runner-detector)
~1h poll(`DEFAULT_IDLE_POLL_MS` = 3_600_000,stuck-escalation.ts:88;FLY-628 band-aid)每 session **一次** capture(session-capture.ts:69-137)喂三消费者(idle 状态机 / stuck detector / quota scan;runner-status.ts:206 明确 one-capture-per-poll 契约)。`evaluateStuckCandidate`(stuck-candidate.ts:239-331):全文 sha256 指纹相等去抖 + 10min `STUCK_THRESHOLD_MS`;硬门 = pending gate / 近 30min comm / 自声明 parked(**抑制方向**)。Episode `Map`(stuck-runner-detector.ts:247)纯内存;处置耐久在 `stuck_dispositions`(StateStore.ts:1342-1352)。升级:`runner_stuck_escalation`(lead_event,guardrail 重投)→ 5min grace 无 disposition → Q7 `runner_stuck_unhandled`(ticket 或 founder page 进 issue thread)。

### 1.3 分钟级插入点(GatePoller piggyback 范式)
tick = 3s `setInterval`(gate-poller.ts:329-336);子任务以 `tickCount % everyN` gating 挂载、独立 try/catch、零新 timer:codex 健康探针 20 tick(:381-392)、display reconcile 60 tick(:397-412)、misroute patrol 20 tick(:414-416)。新增 N 分钟子任务的加法 = `GatePollerConfig` 加 `onXxxTick` 回调 + cadence helper(仿 :746-751)+ plugin.ts 接线(仿 :4019-4048)。tick 内可迭代 `projects × leads`(:432-433)+ `config.store`(StateStore)取 sessions。

### 1.4 通知积木(PR-C 直接复用,零新 transport)
- **lead_event**:`appendLeadEvent` + `runtime.deliver`(mailbox `writeVerified` 或 CommDB instruction);`GUARDRAIL_EVENT_TYPES`(lead-runtime.ts:18-28)决定失败重投。
- **issue-thread 帖**:`emitIssueThreadInfraNotification`(founder-thread-notifier.ts:600-696)——已支持任意单 `mentionUserId` 或无 mention(:644-647),现有 caller 全传 founder id;**@Lead 只差传参**。强制 `onUndeliverable` fail-safe。
- **runner mailbox wake**:`wakeRunnerMailbox`(wake.ts:57-116)。
- **founder page**:`emitFounderStuckNotification` / `emitFounderThreadNotification`(founder-only,校验 snowflake)。

## 2. LLM judge 的实现基底(PR-B)

**仓库无现成「Codex 一次性 judge」抽象;两条可拼的先例:**

1. **一次性 `codex exec` 零插值模式**(flywheel-comm/src/commands/codex-resume.ts):`buildCodexCycleArgv`(:165-211)= `["exec","--json","-o",<out>,"-C",<cwd>,"-s",<sandbox>,("-m",<model>),"-"]`,prompt 走 **stdin**(argv 末尾 `"-"`),二进制 `FLYWHEEL_CODEX_BIN?.trim() || "codex-with-fallback"`(:237),子进程 env 剥 `GH_TOKEN/GITHUB_TOKEN/…`(:251-259)。注意 `codex exec` 非 git cwd 硬拒(CodexTmuxAdapter.ts:161)→ judge 的 cwd 用仓库根或专用只读目录。
2. **订阅一次性分类器的 fail-closed 合同**(bridge/approval-signal/subscription-claude-classifier-runner.ts):`execFile`(无 shell)一次性 CLI 调用、`DEFAULT_TIMEOUT_MS = 20_000`、maxBuffer 1MB、**全 fail-closed**(exec 错/超时/限流/解析失败 → `{ok:false}`,永不 throw、永不假装成功)(:11-14,:80-113);上层 `detection-classifier.ts` 的三层阶梯(正则快路 → 异常才调 AI → 兜底 suspicious,:134-185)就是 PRD「机械快路 + 可疑才升级」的现成形状。
3. FLY-513 健康探针(codex-global-health.ts:225-283)**不 spawn codex**(纯 PATH/realpath 检查)——不是调用先例,但其「刻意不拉起进程」的注释(:19-23)提示 judge 需控制并发/频次(ad-hoc + 去抖,绝不常驻)。

→ PR-B = 新 `watchdog-judge.ts`:argv 模式抄 codex-resume(`exec --json -m <cheap> -s read-only`,prompt stdin),调用合同抄 subscription-runner(execFile、timeout、fail-closed → null),接线形状抄 detection-classifier(机械快路可疑才升级;AI 失败 ≠ 压掉,落 fail-suspicious)。

## 3. consumed-ack 证据面(PR-C 检测输入,现状与缺口)

| 证据 | 语义 | 位置 | 可判「投递未消费 ≥N min」? |
|---|---|---|---|
| CommDB `messages.delivered_at` | transport 写入 ok(裸写) | send.ts:65-74 → db.ts:498-504 | 配合 read_at 可判(仅推送路径) |
| CommDB `messages.read_at` | CLI `inbox` pull(inbox.ts:20-22)或 FLY-109 `flywheel_inbox_ack`(inbox-mcp/delivery.ts:72-98)时置位;**mailbox 路径故意不设**(send.ts:70-72) | db.ts:462-466, 507-517 | 部分:runner 推送路径可;Lead mailbox 路径 read_at 恒 NULL |
| StateStore `lead_events.delivered_at` | 已写入 Lead inbox(writeVerified),**≠ 已消费**;无 consumed 列 | StateStore.ts:1244-1256 | 否(只能判「没写进去」) |
| mailbox 文件 `read: boolean` | ack 时置 true 并 prune;**无时间戳** | ClaudeMailboxCodec.ts:47-51, 213-242 | 否(布尔,且被 prune) |
| founder-reply cursor | Bridge 已处理 founder 消息,≠ 下游消费 | founder-reply-deliverer.ts:147,254 | 否 |

→ 结论:**「投递给 Lead 但 N 分钟未消费」今天没有统一可靠的消费时间戳**。PR-C 的 consumed-ack 检测块按「能查的先查」实现:① runner 推送路径用 `delivered_at IS NOT NULL AND read_at IS NULL AND age≥N`;② Lead 侧最小补法 = 在 mailbox ack 路径顺带 `ackInstructionRead` 同款时间戳落 CommDB(或 lead_events 加 `consumed_at` 幂等列)——**具体补哪条、阈值 N、给 Lead 还是 founder,以 HL 更新后的 942 PRD 三失败模式条目为准**(gate 契约 (c));plan 里作为「PRD-绑定任务」标注,PRD 未更新则 ask Lead。

## 4. 多帧观察窗的落点

- **帧存储**:进程内存 per-target ring buffer(K=3 帧上限,{text, capturedAtMs}),与现有 `leadStates`/`episodes` Map 同生命周期 —— 重启丢窗口可接受(几分钟内重新热身);**耐久层只放通知去重标记**(session_events `event_id` UNIQUE 惯例,StateStore.ts:859-871),不落原始 pane 帧(隐私 + 体积)。
- **跨帧 delta 三件套**(纯函数,喂机械层与 judge):静默 delta(live-region hash 不变 + 空 `❯` + 无 inbound)、重复错误签名 delta(错误行归一化签名跨帧重现,即使全文指纹在变)、token-flow delta(产出增长/спinner 行变化)。
- **窄化取帧**:不动 ~1h 全舰扫(FLY-628 token 红线);可疑对象(gap 扫描或 1h 扫标记)才进「focused frame」队列,按 GatePoller tick 间隔 M 分钟补第 2/3 帧(session-capture.ts 复用,每 tick 上限 1-2 个 capture 防抖)。
- **echo 免疫约束**:新告警 kind 必须加进 `AlertEventType` union → `ALERT_ECHO_START` 交替组自动同源派生(FLY-927 判例);fail-suspicious 附带的 pane tail 只进 Lead 面(lead_event / thread),沿用 runner 侧 evidence.tail 15 行边界,founder 面绝不带 raw pane(隐私,LeadWatchdog.ts:1045-1052 判例)。

## 5. 边界红线(gate 契约固化)

1. **不自建 tmux 真探活**:pane-dead/ghost 的 ground-truth 探活归 FLY-820/823;1048 只消费现有 liveness 信号(HeartbeatService orphan/reap、`FLYWHEEL_LIVENESS_PANE_DEAD`、session FSM)。
2. **FLY-637 阻塞-gate 阶梯、FLY-927 checkpoint-park 巡逻、FLY-915 频道/工单管线全部不动**;统一 ~30min 流只覆盖新检测类(case-c 确认 / 漏① / 漏②-非阻塞 ask / consumed-ack 超时 / FN4 对账)。
3. **产品行为(三失败模式的阈值、报 Lead 还是 founder)以 942 PRD 为准**,PRD 未列的不自定。
4. 全部 env-gated 默认关;未设 = 字节兼容现状(每 PR reverse-compat sentinel)。
5. token 红线(FLY-628):高频层零 token(纯 SQL/文字 diff);pane capture 窄化;LLM 只对可疑对象 ad-hoc,跑 Codex 不占 Claude 额度。

## 6. 风险清单(喂 plan)

| 风险 | 缓解 |
|---|---|
| 两漏检测语义反转(parked/pending-ask 从抑制变触发)造成 Lead spam | 触发判据收紧:「需要人」= park reason/awaiting_review/question 且**无 Lead 通信证据**;去重 + episode latch;阈值可配;默认 OFF 灰度 |
| 新错误串/新 kind 回声重燃 FLY-220 风暴 | kind 进 `AlertEventType` union(echo 交替组同源派生);新告警文案不含原始匹配串;每 kind 双向 fixture |
| judge 误判 a/b(压掉真卡)违反 C-绝不漏 | judge 只能把「机械已可疑」降级为 a/b 时**留 audit**(session_events);不确定→fail-suspicious;fail-closed(错/超时=不压掉) |
| codex exec 并发/频次失控(fleet 大时) | judge 队列化 + 每 tick 上限 + 去抖(同 target 冷却);FLY-513 注释判例 |
| isIdleHealthyPane 改动破坏 FLY-193/218 已治好的静音 | 现有 idle/throttle fixture 全保(927 Task 3.5 已固化);多帧逻辑只在 env 开启时叠加,单帧行为字节不变 |
| PRD 三失败模式条目未及时更新 | PR-C 标注 PRD-绑定;实现前重读 PRD,缺则 flywheel-comm ask Tadashi |
