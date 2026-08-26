# FLY-1764 大喇叭(lead_events 推送通道)整体重设计 — 实施计划(implement-ready)

Issue: FLY-1764 (https://linear.app/geoforge3d/issue/FLY-1764/机制-大喇叭lead-events-推送通道整体重设计-先聊清设计再动手告警该投给谁要不要专用通道与邮局的关系)
日期: 2026-08-14
基于: research.md

> **2026-08-26 FLY-2075 现行守卫(优先级最高)**:founder 改裁「不双发,只发 Discord」。Flow 2 的 mailbox 最后一公里与 `FLYWHEEL_ALERT_COPY_TO_CHANNEL` 已拆除;下文保留为历史决策与实现审计上下文,不再代表现行路由。
>
> 本文档最初是设计提案(讨论稿),经互动图解 HTML 批注后,founder 于 2026-08-14 直令裁定方向并要求**本单直接做实现,不拆单**。本版已把裁定折入,升级为 implement-ready 实施计划(讨论稿原文见 git 历史 `e332d2754` 及之前)。
>
> **Attempt 2 终裁增补(2026-08-14,优先级最高)**:founder 随后把告警最后一公里改为 **Flow 2** —— actionable 告警作为**一行 mailbox 信**只投 `claude-infra-bot-lead`(claw),复用 Lead inbox 的即时机械(单条 identity、立即写、立即 nudge);**默认不发 Discord 副本**。路由表保留 `FLYWHEEL_ALERT_COPY_TO_CHANNEL=1` 观察性抄送开关,默认 OFF。下文凡写「统一告警频道是唯一主通道」「告警不进 mailbox」或依赖 Discord ticket lifecycle 的地方,均被本增补取代;原段落保留为首轮设计/已实现工作的审计上下文。

## 0.0 Founder 裁定(2026-08-14 直令 · 逐条对应 · 不许偏离)

| # | 裁定 | 本计划落点 |
|---|---|---|
| ① | 告警按 owner 定向:能修的人 = claw(claude-infra-bot)为主收件人 | Flow 2 直接写 claw 的项目 CommDB mailbox,同一 `eventId` 形成一个稳定 delivery identity,随后立即 nudge |
| ② | 不要双发;宁愿不发 Discord | mailbox 是 primary/唯一默认落点;`FLYWHEEL_ALERT_COPY_TO_CHANNEL` 默认 OFF,只有显式 `=1` 才 best-effort 抄送原 raw channel sink |
| ③ | 不是每个 Lead 都广播一次 | 工作块 A:退役广播腿(§4) |
| ④ | 投到专人也不能无限淹没(collapse/去重) | mailbox `id/delivery_id=infra_alert:<owner>:<kind>:<eventId>` 保证同一事件只占一行;producer 既有 episode identity 继续保留 |
| ⑤ | 本单直接做实现,不拆单 | §4 全部工作块(A/B/C/D/E)在本单一个 PR 实现 |
| 旋钮 1 | 告警迟到语义 α/β 做成可配,用设计推荐值 | 工作块 C:新 env `FLYWHEEL_ALERT_REPLAY_FRESHNESS`,默认 α(accept_delayed) |
| 旋钮 2(终裁撤回) | owner 缺席 SLA | **Flow 2 默认档不设时限升级机制**;owner 缺席的发现归 FLY-1773 第③件「读者可判活」管辖,安全底线由 pressure-hold 自动暂停派发独立兜住(founder 知情接受,2026-08-14;见工作块 D) |

## 0. 一句话主张

**大喇叭该被拆掉,不是被改造** —— 要人修的 actionable 告警只写 claw 的收件箱,要系统做的动作由 pressure-hold 机制化,全体 Lead 不再收到 FYI 广播;Discord 仅是默认关闭的观察性副本。

## 1. 三段论(每段都有代码/数据依据,见 research.md)

### 1.1 「要人修」→ Flow 2 定向写 claw mailbox

- 首轮实现已经消掉 N×Lead 广播,但最后一公里仍把 owner 工单发进 Discord。founder 终裁认为这仍是重复通道:告警 owner 与 runner/Lead 本来就应复用同一台即时收件机械。
- Flow 2 在 Router 的 `ticket` 分支调用 `LeadInboxRuntime.enqueueInfraAlert()`:固定 owner=`claude-infra-bot-lead`,一条 durable row,写后立即 `nudge()`;`issue_thread` 与纯 informational `notify` 分类保持原路。
- Discord raw sink 不再是 ticket 主落点。`FLYWHEEL_ALERT_COPY_TO_CHANNEL` 未设/`0` 时调用次数必须为 0;仅 `1` 时在 mailbox 成功后 best-effort 抄送,抄送失败不能反向否定 durable primary。
- **诚实定性(Codex R1-1)**:这条告警腿的语义是「**每 episode 去重的 durable 工单流**」,不是严格的 last-value 流 —— Discord 故障,或统一频道每分钟根消息配额溢出(`LeadAlertNotifier.ts:943-955`)时,完整 episode 会进 `~/.flywheel/alert-queue/`(默认 cap 500 条/3 天),恢复/取得配额后**最老优先回放**,发送前不校验压力是否已解除。对内存告警这类瞬时事件,恢复后可能补发已过时的历史工单。两种产品合同 —— **founder 裁定(旋钮 1):两种都实现,做成可配,默认取设计推荐值 α**:
  - **合同 α(默认档)**:接受「一 episode 一条、可能延迟、绝不 N×Lead」的审计型告警,现状即可。量级的诚实说法(Codex R2-1):本次 48h 样本仅 3 条 `swap_pressure_high`,但代码不保证上界 —— 最坏回放量受默认 queue cap 500 条/3 天策略约束(超 cap 淘汰 `LeadAlertNotifier.ts:1164-1172`,超龄淘汰 `:1194-1198`,均进 dead-letter;drain 后统一 meta-alert `plugin.ts:9983-9989`),期间多次 high→clear 的 episode 不塌缩。α 为默认档,验收须覆盖:Discord down 或 unified rate-limit 期间多次 high→clear→high → 恢复后回放顺序、cap/age 淘汰与 dead-letter/meta-alert 行为符合上述描述。
  - **合同 β(可配开启)**:要求严格 latest-value —— 给告警腿加 drain-time 的 episode 级复核(回放前能证明该 episode 已结束才弃投留档,reason `stale-episode`,不算投递故障)。**本单工作块 C 实现**,经旋钮开启。**不要**用 mailbox 里的 #834 来实现它。

### 1.2 「要系统做」→ 已机制化,无需通知任何人

- 压力确认时 Bridge **自动置 pressure-hold(新 runner 派发暂停),压力回落自动解除**(`fleet-sensors.ts:10, 515-522`,`ensureSensorHold()` + runner-admission 硬挡)。
- 广播文案的两个动作请求:「暂缓新任务」= hold 已硬性执行;「考虑收掉可暂停的 runner」= owner(infra)在告警频道认领的活,不是全体 Lead 的活。
- ⇒ Annie 的 Q1「告警投给谁」答案:**能动手的 owner(告警频道认领)+ 系统自动执行的部分谁都不用收**。「给每个 lead 都说一次」确实没有意义 —— 非 owner 的 Lead 收到后唯一能做的就是围观,实证代价是把多个 Lead 的上下文窗口灌满(8-13 实录:一条说「资源不够」的消息,自己消耗掉最多资源)。

### 1.3 「与邮局的关系」→ 同一收件机械,但不恢复全员广播

- DR 报告的语义区分仍成立,但 founder 的最终产品取舍是:先复用已经能「单条认领 + 立即写 + 唤醒」的 mailbox 机械,不为看板再发第二份。
- 这不是复活 FLY-1749 的全套 TTL/collapse/at-most-once 状态机:Flow 2 只新增一个 `source_kind=infra_alert`、`msg_class=model` 的普通 owner 定向行,继续走现有 ACK/lease 机器;去重边界是稳定 delivery identity。
- **邮局的边界(Codex R1-2 修正)**:不是「只装会话」,而是「装**有明确收件人的必达消息**」—— 包括会话,也包括定向 action 指令(如 server-loss 恢复通知:`server-loss.ts:423-475` 按 owner Lead 定向发 casualty 名单 + resume 指针,带 durable outbox/重试合同 —— 它不是会话,但**应该**留在邮局)。被驱逐的只是「无明确收件人的全员 FYI」。
- ⇒ Annie 的 Q3 最终答案:**合用机械,不双发通道**。mailbox 仍只接有明确收件人的消息;被永久驱逐的仍是「无明确收件人的全员 FYI」。

## 2. 流量分流表(Q4:现存流量各归哪条道)

| 流量 | 现状 | 新归宿 | 改动 |
|---|---|---|---|
| 机器级告警(swap/OOM/load) | 双发:告警工单 + 全 Lead 邮箱广播 | **只写 claw mailbox 一行**;Discord copy 默认 OFF | 退役广播腿 + Flow 2 最后一公里 |
| 载荷调度(暂缓派发) | pressure-hold 机制 + 广播 FYI | **只留 pressure-hold**(已在) | 无(随广播腿退役,FYI 消失) |
| server-loss 恢复通知 | `notifyLeadInstruction` 定向发归属 Lead(非广播) | 现状即可 —— 它是定向 action,属于邮局 | **无。共享的 `notifyLeadInstruction` sink 必须保留**(Codex R1-2) |
| Bridge actionable 系统告警(abnormal_exit / stale_checkout 等) | Router ticket → Discord 工单 | Router ticket → claw mailbox;copy 默认 OFF | Flow 2 最后一公里 |
| mailbox 死信通知 | 定向归属 Lead + 30min 聚合 | 现状即可(是定向不是广播) | 无 |
| 巡检闹钟 patrol_tick | 定向、已是单飞语义 | 现状即可 | 无 |
| runner_question / founder_reply / engine escalation 等会话流量 | mailbox 必达 | 现状即可(1751 管邮局内部语义) | 无 |

普查依据:48h 实测里「见者有份」广播只有 fleet broadcast 一族;其余全是定向(research.md §6)。**重设计的产品刀口只有一处**(实现伴随合同见 §4)。

## 3. 1748/1749 已写代码的取舍(Q5)

| PR | 内容 | 裁决建议 | 理由 |
|---|---|---|---|
| #829(FLY-1748) | legacy push 查询显式排除终态行(42 行) | **修复并入本单(工作块 B)** | 防御性修复,与任何设计兼容:终态行不该重投在哪个世界里都成立。修的是邮局本身的缺陷,不是广播的 |
| #834(FLY-1749) | mailbox 内 last-value 语义全套(TTL/collapse/at-most-once,+2837 行) | **作废不合** | 设计前提消失:广播不再进邮箱,mailbox 内的第二套语义失去服务对象。「压力解除撤回通知」的诉求由「不进邮箱」自然消解 |

状态更新(2026-08-13 晚已执行):FLY-1748 / FLY-1749 已按 founder 裁决**关单、PR 保留**作参考。因此 #829 不再走「原单复活」——它的 42 行修复由本单工作块 B 以 cherry-pick(保留原提交作者)或等价重写方式并入本分支。

诚实说明:#834 的存量行退休脚本(`legacy-swap-broadcast-retirement.sh`)**只可提取思路,不可当作现成能力** —— 它以 `FLYWHEEL_FLEET_SENSOR_SWAP=0`(关掉整个 swap sensor)作为 producer fence,而新设计要保留 sensor;`retractLoadShedBroadcasts` 也只存在于 #834 分支,不在 main(Codex R1-4)。若未来出现新的「必须进邮箱的可过期广播」需求,#834 是参考实现,关单不删分支即可。

## 4. 本单实现范围(founder 直令 ⑤:直接实现,不拆单,单一 PR)

五个工作块:首轮完成 A/B/C/D;attempt 2 追加 **E(Flow 2 最后一公里)** 与 QA 阻断修复(legacy schema/rollback/CI 枚举)。全程 TDD(RED→GREEN→REFACTOR)。gates:全仓 `pnpm lint` + `pnpm -r build` + 触达包定向 vitest(生产 host 上只跑触达文件 —— 全量 vitest 会压死生产 Bridge 的既有教训;全量以 CI 为准)。

### 工作块 A(高优):退役广播腿

**精确刀口(Codex R1-2)**:移除 `FleetSensorsDeps.notifyLead` / `listLeadIds`、`broadcastLoadShed()` 及其三处调用点;**保留** `leadProjectByAgentId`、`notifyLeadInstruction` 与 server-loss 接线(`plugin.ts:9501`)。同时收口 `swapPressureRepair()` 自身的分支(`fleet-sensors.ts:463-503`):`sensorHoldMatches` 保留 `ensureSensorHold()` 的幂等 hold 复核,但 detail 删除「已补发广播」的虚假叙述;为避免把「无动作」伪装成 `attempted`、也避免把已经安全的状态升级成 founder @-ping,先给 `RepairOutcome` / `AlertChannelHub` 增加一个明确的**非升级** `no_action` 结果与渲染合同,再将 `monitorMatches` 按 `currentHold` 拆开 —— 无 hold 的 live episode → `needs_human`(这是会真实 @ founder 的升级,因为派发尚未暂停);已有 manual hold → `no_action`(hold 已生效,不 @ founder);已恢复/已切换的旧 episode → `no_action`。`no_action` 必须落为 `repair_status=no_action` + **新增** ticket 状态 `MONITORING`(零 mention、零 attempt bump);实现必须显式扩展 `decideTicketEscalation`,让 `MONITORING` 不做 ARC 重试、不落入 `NEW` 的 unclaimed fallback,而只在该 kind 的 `policy.timeoutMs` 结束后仍未恢复时升级(swap 沿用 30 分钟,owner 已配置也一样);禁止继续使用 `attempted/action:none`,也禁止对已有 hold 的状态返回 `needs_human`。

**Cutover 合同(crash-safe 顺序,Codex R1-4)**:
1. 停旧 Bridge / 证明旧 producer 不存活(旧 Bridge 活着就可能在清理后重插 `swap-broadcast:*`);
2. 安装不再产生广播的新 bytes;
3. 用生产同一个 `commDbRootDir()` 解析器确定 root(保留 `FLYWHEEL_COMM_ROOT` / `FLYWHEEL_COMM_DIR` 覆盖语义),扫描该 root 下全部项目子目录中的 `comm.db` —— **不得**只枚举当前 Bridge `projects` 配置 —— 再逐库事务化、幂等退休精确身份行(`swap-broadcast:*`)并清 lease/retry 状态;任一库打不开/未知 schema/锁重试耗尽则 fail closed;
4. 对第 3 步同一 root、同一磁盘枚举全集复查 postcondition:零 live `swap-broadcast:*` 行;配置已摘除但磁盘仍在的项目也必须纳入;
5. 才启动新 Bridge。覆盖中途 crash 重跑幂等、未知 schema fail-closed、竞争 writer 测试。

**部署前提 gate(Codex R1-3)**:退役前必须验证告警腿在生产真实可用,否则是把糟糕的双路变成脆弱的单路 —— ① unified channel(`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`)已配置且 sender/repair token 可解析(fleet 假身份 `leadId='swap'` 在 unified 缺位时不会回退到任何 Lead,直接 dead-letter);② ticket owner / founder mention 配置齐;③ 一条真实 canary 告警走通全链。

**伴随合同(blast radius,Codex R1-5)**:`fleet-sensors.ts:463-503` 的 `swapPressureRepair` 分支/outcome/detail、`AutoRepairBot.ts:21-40` 的 outcome 合同、`StateStore.ts:9442-9465` 的 `repair_status` / ticket 状态说明、`ticket-escalation.ts:88-118`(当前没有 `MONITORING`;必须新增显式分支:与 `REPAIRING|ACK` 共用 `policy.timeoutMs` 的超时判断,但零 retry/零 attempt,且绝不掉到末尾 `NEW` 的 `unclaimedMs` 分支),以及 `AlertChannelHub` 内**全部** `repair.outcome` 消费点(现为 `:489` 初次渲染、`:549` repair status、`:555` ticket 状态、`:866` 重试文案/计数)。这些二值 if/三元在 union 加成员时不会自动报错,实现必须改成三态 exhaustive switch + `assertNever`: `attempted` 才记 attempt/REPAIRING,`needs_human` 才 mention/ESCALATED,`no_action` 只写中性说明/no_action/MONITORING;重试路径若收到 `no_action` 也不得渲染「安全闸拒绝」或消耗 attempt。另同步 `kind-contract.ts:223-228`、`AutoRepairBot.ts:59-64,142-150`、`LeadWatchdog.ts:1190-1195` 中「pressure-hold + per-Lead notify」的叙述/断言、fleet sensor / auto-repair / alert hub / ticket-escalation 单测、两份真实 QA 脚本 —— 不是新设计,但不列出来会变成 review 惊喜。

**验收**:注入压力 episode → 告警频道恰 1 条工单 + hold 置位 + **全项目 comm.db 零新增 `swap-broadcast:*` 行**;压力回落 hold 自动解除;`monitorMatches` 三态契约测试:live+无 hold 才 `needs_human` 并 @ founder/写 `needs_human`+`ESCALATED`;live+manual hold 返回 `no_action`,零 mention、`repair_status=no_action`、ticket/root=`MONITORING`、attempt_count 不变;在 owner 已配置时把时钟分别推进到 5 分钟(`unclaimedMs`)与 30 分钟窗口之后(`timeoutMs`):前者仍 `none`/零升级,后者若仍未恢复才升级;旧 episode 返回 `no_action`,零 mention/零 attempt,随后由 recovery probe 安静 RESOLVED。对初次与重试两条 Hub 路径都断言 `no_action` 绝不写 `needs_human`、绝不写 `REPAIRING|ESCALATED`、绝不记 ARC attempt;**交叉验收**:server-loss 定向通知仍按 owner 发送、crash replay 幂等(证明共享 sink 未被误伤);故障注入:Discord down / queue spill / owner id 缺失 各证明 hold 仍生效且人类升级路径符合 §6 裁决。

### 工作块 B(小):并入 FLY-1748 修复(原 PR #829)

FLY-1748 已关单留 PR(§3 状态更新),故不走原单复活:把 #829 的 42 行 `flywheel-comm/src/db.ts` 修复(腿 B 两条读查询从投影视图改为 JOIN 物理表并显式 `state IN ('QUEUED','LEASED')`)以 cherry-pick(保留原提交作者)或等价重写并入本分支。验收沿用原单:终态行(DEAD/ACKED)不再被 legacy push 重推,原 PR 的测试一并进来并保持绿。

### 工作块 C:旋钮 1 — 告警迟到语义 α/β 可配(新代码)

**语义**:β 开启时,queue 回放(drain)前对每条告警做 **episode 级**新鲜度复核 —— 能**证明该条 payload 的 episode 已结束**才弃投(文件仍移入 dead-letter 目录留审计档,reason `stale-episode`,但**这是预期产品行为,不是投递故障**);证明不了(`null`)一律照常投递。**Fail-open to delivery 是硬要求:绝不因证据不足而静默丢告警 —— 宁可多投,不可漏投。** α(默认)= 现状字节兼容:回放不做复核。

**配置**:env `FLYWHEEL_ALERT_REPLAY_FRESHNESS` ∈ { `accept_delayed`(α,默认)、`drop_stale`(β)}。unset/空/无效值 → α + 启动时一条 logger 提示(无效值不 fail-close:告警链路的失效模式必须是「多投」而不是「断投」)。env 读取沿用 `policyForKind` 解析 `FLYWHEEL_SWAP_PRESSURE_TIMEOUT_MIN` 的既有代码风格;该 legacy timeout 本身不属于 Flow 2 的活合同(见工作块 D)。

**新鲜度真相源(Codex R1-1:必须 episode-aware,且类型安全)**:`FleetSensors` 新增**同步**窄方法 `replayFreshness(input: ReplayFreshnessInput): boolean | null`,`ReplayFreshnessInput = { eventType, leadId, eventId, episodeId? }`(新导出窄接口;**禁止**用不完整对象强转 `AlertThreadRow` 去调 `recoveryProbe`)。方法只读既有内存/durable 缓存证据(`memMonitor.lastEvaluation`、sensor hold snapshot、`botLastAlive`、`bootReconcileDone`),**零 IO、不发明第二套健康判定**。合同:返回 `true` **仅当能证明该 payload 的 episode 已结束**;明确仍活着 → `false`;证明不了 → `null`。逐 kind 判定表:
- `swap_pressure_high`:① 当前证实健康(`lastEvaluation.healthy === true`)→ `true`(机器证实健康 ⇒ 任何 swap episode 均已结束);② 当前 sensor-owned hold 的 episodeId === `input.episodeId` → `false`(同一 episode 仍活);③ 当前 sensor-owned hold 存在但 episodeId ≠ `input.episodeId` → `true`(旧 episode 已被新 episode 取代;新 episode 会发/已发自己的告警条目,人类可见性不丢);④ 其余(无 hold 且非证实健康,或 `input.episodeId` 缺失)→ `null`。
- `infra_bot_down`:`botLastAlive.get(provider) === true` → `true`;`false` → `false`;undefined → `null`。
- `bridge_abnormal_exit`:`bootReconcileDone` → `true`;否则 `null`。
- `tmux_server_lost`:一律 `null`(结束证据需要 `repair_status`,queue payload 不携带 —— 照常投,fail-open)。
- 其余 kind:`null`。

**episode identity 生产步骤(Codex R2-1:没有这一步,判定表 ②/③ 在生产 queue 中不可达)**:当前 swap producer 只把 episodeId 编码进 `eventId`(`swap-pressure:<id>` / `swap-holdfail:<id>`),**没有**设置 `AlertPayload.episodeId`(`fleet-sensors.ts:576-605` `buildAlert()` 的 hold-failure 与 sustained 两个返回对象均缺),而 `enqueue()` 只 spread 原 payload,不会从 `eventId` 派生。锁定方案:**在 `buildAlert()` 两个生产分支都写入 `episodeId: args.episodeId`**,由既有 enqueue spread 原样持久化(不做多处字符串解析);同步更新 `AlertPayload.episodeId` 的注释(`LeadAlertNotifier.ts:545-546`,当前只描述 FLY-1309 lease 用途)加上 swap replay-freshness 用途,防后续维护者误删。存量 queue 里的旧记录无 `episodeId` → 判定表 ④ → `null` 照常投,天然向后兼容。

**接线(具体文件)**:
1. `packages/teamlead/src/LeadAlertNotifier.ts`:
   - config 新增可选**同步** `replayFreshnessProbe?: (input: ReplayFreshnessInput) => boolean | null` —— 签名刻意非 Promise(Codex R1-3):drain 循环不引入新 await,probe「永不 settle 挂死整条队列」的悬挂面结构性为零(`drainQueue` 是单串行循环且 caller 有 `leadAlertDraining` 重入锁,一次悬挂 = 告警投递永久停摆,不可接受);
   - 构造时解析 env 得 `replayFreshnessMode`;仅 `drop_stale` **且** probe 已注入才启用复核;
   - `drainQueue()` per-entry 循环:在 aged-out 检查(`:1195-1199`)之后插入 —— β 模式下 try/catch 同步调 probe(抛错 → 当 `null` + logger 一条):`true` → 文件移入 dead-letter 目录(reason `stale-episode`)+ **`staleSuppressed++`;不计入 `deadLettered`**(Codex R1-2);`false`/`null` → 不动,走既有投递路径。`drainQueue()` 返回值新增 `staleSuppressed` 字段。
2. **drain caller 合同(Codex R1-2)**:`plugin.ts:9983-9989` 的 `alert_dead_lettered` meta-alert(文案「检查 Discord alert config」)只对真实投递故障(`deadLettered > 0`)触发;`staleSuppressed` 是预期 β 行为,只落一行中性 logger 日志,**绝不**发故障告警 —— 否则每次正常 stale 弃投都伪造一条「告警链路坏了」,既误导 operator 又违背裁定 ④「owner 不能被淹没」。
3. `packages/teamlead/src/bridge/plugin.ts`:构造 `leadAlertNotifier`(`:7716`)时注入同步闭包,经既有 `fleetSensorsHolder`(`:4171`)调 `replayFreshness`;holder 未填(sensors 未构造/已关)→ 返回 `null`。
4. shell 腿(`lead-alert.sh` 写入的 queue 记录)走同一 `drainQueue()` → 自动被同一旋钮覆盖,零额外改动(shell 记录无 `episodeId` → swap 判定表 ④ → `null` 照常投,天然安全)。

**测试(RED 先行)**:
- β + 判定表 ①/③:文件进 dead-letter 目录且 reason=`stale-episode`、`staleSuppressed` 计数、**`deadLettered` 不增**、`sent` 不增、不进 `delivered` 数组;
- β + ②(同一 episode 仍活)/ ④(无证据)/ probe 抛错:照常投递(断言与 α 路径一致);
- **episode 交错场景(Codex R1-1)**:episode A 入队 → A 恢复 → episode B 变 high(当前整体不健康)→ drain:A 按 ③ 判 stale 弃投,B 自己的条目照常投;
- **生产形状交叉测试(Codex R2-1,防手填 fixture 假绿)**:A/B 两条 payload 必须由真实 `FleetSensors` alert producer 产出(不许手填 `episodeId` 的 fixture),经 notifier `enqueue()` 落盘 queue JSON,再执行 β drain,断言 A 计入 `staleSuppressed`、B 正常投递 —— 覆盖「producer 真的写了 `episodeId` 且 spread 持久化真的保住它」这条链;
- Bridge restart 后 identity 不可判(`lastEvaluation` null、无 hold)→ `null` 照常投;
- **caller 合同(Codex R1-2)**:drain 结果仅 `staleSuppressed > 0` → **不**发 `alert_dead_lettered`;malformed / permanent / Discord 4xx → 照常发;
- β 下 oldest-first 顺序不变;
- α(env unset):既有 drain 测试全数不动(字节兼容回归哨兵);无效 env 值:行为 = α + logger 恰一条;
- 非 fleet kind payload 在 β 下照常投递(判定表兜底 `null`)。

### 工作块 D:旋钮 2 退役 — owner 缺席无时限升级(终裁,零代码变更)

`FLYWHEEL_SWAP_PRESSURE_TIMEOUT_MIN` 仍是旧 Discord ticket lifecycle 的既有配置(`ticket-escalation.ts:57-65`),但 **Flow 2 的 owner mailbox 行不经过该 lifecycle**,因此它不再是本设计的活旋钮,也不得被解释成 mailbox 的 30 分钟升级保证。founder 于 2026-08-14 知情接受以下合同:
1. actionable ticket 写入 claw mailbox 并立即 nudge 后,**没有按 5/30 分钟或其他时限自动升级 founder 的机制**;
2. claw 是否缺席、是否仍在读信,由 FLY-1773 第③件「读者可判活」负责发现,本单不另造 presence/SLA 机械;
3. 人类缺席不削弱机器安全底线:swap 压力由 pressure-hold 自动暂停新 runner 派发,与 mailbox 是否被读取、owner 是否在线独立。

工作块 A 中关于 `MONITORING` / `timeoutMs` / 30 分钟升级的段落是首轮 Discord 工单设计审计上下文,在 Flow 2 默认档下均由本终裁覆盖;本次只收口文档,零代码、零新增测试。

### 工作块 E(attempt 2):Flow 2 owner mailbox 最后一公里

1. 新增单一真值路由 `INFRA_ALERT_LAST_MILE_ROUTE`:owner 固定 `claude-infra-bot-lead`;copy env 固定 `FLYWHEEL_ALERT_COPY_TO_CHANNEL`;默认值固定 `false`。
2. `LeadInboxRuntime.enqueueInfraAlert(owner,payload)` 在 owner 所属项目 CommDB 写一条 row:`source_kind=infra_alert`,`type=<eventType>`,`msg_class=model`,severity 映射 P1/P2/P3;identity=`infra_alert:<owner>:<kind>:<eventId>`,相同 active identity 重入不增行;写后立即 `nudge(owner,project)`。
3. `createInfraAlertSink` 的 `ticket` 路由改走 `ticketSink`;`issue_thread` 仍走 issue thread,纯 informational `notify` 仍走 raw sink。未绑定的 progress fail-safe 也落 ticketSink。copy switch `=1` 时 primary 成功后 best-effort 调 raw sink;unset/`0` 时 raw ticket 调用必须为 0。
4. `plugin.ts` 把 ticketSink 接到同一 `leadInboxRuntime`;`packages/config` truth 表登记 copy env。验收:真实 MailboxQueue 一行、同事件重入仍一行、立即 nudge、全 `AlertEventType` 分类 sweep、默认零 Discord、开关开启才一份 copy。

### Attempt 2 QA 阻断修复

- legacy retirement 每库先 COUNT;0 行直接跳过;命中时先读 `pragma_table_info('mailbox')`,只更新存在的可选 lease/retry 字段,共享身份/状态字段仍 fail-close。
- cleanup 在旧 Bridge 已停后失败时,与 build-fail 同款 `rollback_and_restart($DEPLOYED_SHA)`;迁移窗口明确禁用 code-only rollback 时保留 fail-close + severe alert。
- `legacy-swap-broadcast-retirement.test.sh` 明确接入 `.github/workflows/ci.yml`;新增 suite inventory 自检,全部 `scripts/__tests__/*.test.sh` 必须归类为 CI 枚举或 reviewed manual-only,漏接/重复/陈旧路径均令 CI 红。

### 观察项(不立单,指定判据)

「ack 后仍重放」的最后一环(research.md §5):工作块 A+B 落地后 7 天观察窗,owner = infra 线。**取证协议是人工的,不是 DB 查询**(Codex R2-2:`mailbox_log` 不记录 legacy push 投递事件,pane 渲染次数也无持久计数器):发现任一 Lead pane 同一 message_id 渲染 >3 份时,立即 capture-pane 存档 + 记录时间戳与 message_id + 对照 `mailbox` 表该行的 state/acked_at;凭这组证据立单。若 legacy-push 议程日后给成功 notification 加了结构化审计面,再升级为可执行查询。
**已知不修**:普通 live LEASED 指令在未 ACK 期间每 30 秒重新满足 push query 的行为是腿 B(legacy push)自身的既有语义,A+B 不改变它 —— 归 legacy push 退役议程。

## 5. 本设计不做什么(诚实边界)

- **不动定向流量**(runner→Lead、founder_reply、死信通知、patrol、server-loss):它们不是大喇叭,本来就该进各自 Lead 的邮箱。
- **不动邮局内部语义**:FLY-1751 二次定稿(攒批 10 条/30s + /clear 换代腿)已派工,与本单正交。
- **不动 legacy push 腿 B 的存废**:它的退役另有议程(2026-08-14 10:00 讨论);本设计与其兼容(广播退出邮箱后,腿 B 少了最大的重投源,但腿 B 自身缺陷不是本单修)。
- **不给 lead_events 做手术**:它作为审计账本 + 去重锁工作正常;16 个休眠 ack 列的清理是另一件独立的卫生活,不搭车。
- **不修「ack 后仍重放」之谜**:消除其最大触发源后转观察(§4 观察项有判据/观察窗/owner)。
- **β 不默认开启**:合同 β 已折入本单(工作块 C 可配旋钮),但默认档是 α —— 生产回放行为在旋钮拨动前字节不变。

## 6. 风险与反方观点(自我攻击 + 需要 Annie 裁决的点)

| 反方 | 回应 |
|---|---|
| 砍广播会不会让 Lead 失去「该降载」的感知? | 「暂缓派发」已被 hold 硬性执行,不依赖 Lead 自觉;「收 runner」是 owner 在告警频道认领的活。且实证上广播的净效果是负的(灌满 Lead ctx,加剧内存压力)。全仓无任何 Lead rule/prompt 依赖 `[fleet-alert]`/`swap-broadcast` 执行控制动作(Codex R1 独立核验) |
| 告警频道会不会漏?(Discord 挂了或频道配额满怎么办) | 告警腿有完整失败处理:transient 或 unified rate-limit 溢出 → `~/.flywheel/alert-queue/`(cap 500/3 天)最老优先回放,permanent → dead-letter + 独立 meta-alert(`LeadAlertNotifier.ts:788-816, 943-1009`)。代价是恢复/取得配额后可能补发过时工单(§1.1 合同 α/β —— 已裁定做成可配旋钮,默认 α;拨 β 可消掉过时补发) |
| **owner 缺席怎么办?(终裁)** | Flow 2 把 actionable ticket 写入 claw mailbox 并立即 nudge 后,**不设时限升级机制**,也不再承诺 30 分钟后升级 founder。owner 缺席的发现归 FLY-1773 第③件「读者可判活」管辖;机器安全由 pressure-hold 自动暂停派发独立兜底。founder 已知情接受这一取舍(2026-08-14) |
| 为什么不做 Lead 主动 pull 系统状态的接口? | YAGNI:hold 状态在告警工单可见,Lead 也可被 owner 定向通知。等真实需求出现再说 |
| 1749 的 +2837 行白写了? | 是,按 founder 的方法论裁决:「如果它是在不正确的设计上写的代码,它并没有意义」。留 PR 作参考实现,不合 |

**裁决记录(2026-08-14,founder 直令,均已折入本计划)**:① 合同 α vs β → 两种都实现,做成可配旋钮,默认 α(工作块 C);② owner 缺席 SLA → 终裁撤回 30 分钟升级,Flow 2 默认档无时限升级,缺席发现归 FLY-1773 第③件,pressure-hold 独立兜底(工作块 D);③ 拆单节奏 → 不拆单,工作块 A/B/C/D/E 同一 PR 本单实现(§4)。

## 7. 生效配置与退役旋钮速查(运维参考)

| 旋钮 | env | 取值 | 默认(=设计推荐值) | 语义 |
|---|---|---|---|---|
| 告警迟到语义 α/β | `FLYWHEEL_ALERT_REPLAY_FRESHNESS` | `accept_delayed` / `drop_stale` | `accept_delayed`(α) | β 时 drain 回放前做 episode 级复核:能证明该 episode 已结束才弃投留档(`stale-episode`,计 `staleSuppressed`,**不算投递故障**);判定不了(null)照常投。unset/无效值 = α |
| owner 缺席 SLA(已退役) | Flow 2 无对应 env;`FLYWHEEL_SWAP_PRESSURE_TIMEOUT_MIN` 仅属旧 Discord ticket lifecycle | — | **无时限升级** | ticket 写 claw mailbox 后不自动升级 founder;缺席发现归 FLY-1773 第③件,安全底线由 pressure-hold 独立兜住(founder 知情接受,2026-08-14) |
