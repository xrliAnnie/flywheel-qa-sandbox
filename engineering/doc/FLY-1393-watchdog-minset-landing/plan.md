# FLY-1393 看门收编 — 实施计划

Issue: FLY-1393 (https://linear.app/geoforge3d/issue/FLY-1393/foundation看门收编-watchdog-最小集落地-开关真值修复-关掉的检测按-1391-四条清单收编假开关拆除1392-之后)
日期: 2026-07-21
基于: research.md

> 分类表与全部 file:line 证据在 research.md;本文只写「怎么落」。
> Tadashi brainstorm gate 四裁定已折入:① 批 1/批 2 拆分批准,批 1 ship 前 rebase 含 FLY-1392 的 main;
> ② W-4 决策 brief 附本文 §6,双分支不阻塞;③ 退役走**先禁后删两拍**,24h 无假警报窗兼作 soak;
> ④ AlertChannelHub T2 腿退役硬押 1392 升级闭环在岗证明。
> Codex design review R1(7 BLOCKER + 2 HIGH)与 R2(2 BLOCKER + 2 HIGH)已全部折入;
> R1#1 的「改用 probe 肯定死亡 verdict」部分拒绝(bare-shell 形态 probe 结构性看不见,理由见 S2,
> Codex R2 已接受);G-1 的死亡判定按 R2#2 改用四态 probe(那是 pane 级死亡,probe 正确覆盖)。

## 0. 目标与验收对照

| issue 验收 | 本计划对应 |
|-----------|-----------|
| 1. 四条最小集真机在岗(含故障注入) | §4 QA 矩阵(W-1 杀进程 / W-2 确定性停循环 / W-3 抽验 / W-4 现网案例) |
| 2. 四条之外投递 watchdog 全 OFF 且无假警报(24h) | 批 1 **真禁拍**(S4:hard-off,legacy=1 不可复活)+ 24h soak(§4.3)+ 批 2 删码 |
| 3. 假开关拆除,检查脚本化 | S4/S5(共享 tombstone 模块 + check-flag-truth 两层)+ 批 2 P3 |
| 4. 意图级:「安静 = 没事」重新成立 | 全部之和;终验 = 检查脚本绿 + manifest 与期望集一致 + **manifest 自身降级也会出声**(S6) |

## 1. 总体形状:两批

```mermaid
flowchart LR
  subgraph B1["批 1(设计通过即可开工,不等 1392 落 main)"]
    S1[四条独立开关注册] --> S2[W-1 idle 巷收编 + G-1 durable 接线]
    S1 --> S3[W-4 收编:episode 前置 gate]
    S4[真禁拍:hard-off + tombstone 共享模块] --> S5[check-flag-truth 脚本]
    S6[W-2:/health manifest + 探针扩维+降级告警] --> S5
  end
  B1 -->|rebase 含 1392 的 main + ship| SOAK[24h soak<br/>零假警报 = 验收2 + 退役 soak]
  SOAK --> CK{1392 检查单:行为项 +<br/>原子性硬门(target §2.4)全过?}
  CK -->|全过| B2A["批 2a:T2 腿独立禁用 commit<br/>(逐 kind 矩阵过后)+ 24h soak"]
  B2A --> B2B["批 2b:删码删 flag(含 T2)"]
  CK -->|有缺| HOLD[对应组件保持 hard-off 不删<br/>报 Tadashi 裁定]
```

**先禁后删对每个退役面都成立**(R2#1):legacy 圈 + checkpoint-park + Z1 的禁拍在批 1(hard-off);
T2 腿现状**没有任何退役 gate**且在跑,它的禁拍是批 2a 的独立 disable commit(前置 = §3.1 逐 kind 矩阵),
禁用后跑自己的 24h soak,批 2b 才删 —— 不存在「直接删」的路径。

**依赖纪律**:批 1 ship 前 rebase 到含 1392 的 main(依赖先落、依赖者 rebase);ship 顺序 Tadashi 协调。
批 2 只有在 1392 已合 main 且 §3.1 检查单(含原子性硬门)逐条核过后开工。

## 2. 批 1 切片(TDD;每片独立 commit)

### S1 · 四条独立开关(registry 注册 + 接线)

| flag(registry name / envVar) | polarity | 门控范围 | 读时机 |
|------------------------------|----------|---------|--------|
| `watchdog_liveness` / `FLYWHEEL_WATCHDOG_LIVENESS` | default_on kill-switch | W-1 告警巷:RunnerIdleWatchdog **仅 idle(bare-shell)发射**(S2)+ G-1 死亡告警(S2)。不管探测基元与回收消费者 | RunnerIdleWatchdog 构造注入;**GatePoller G-1 巷 = 构造注入同一 boot 捕获值**(R1#6 补) |
| `watchdog_loop_heartbeat` / `FLYWHEEL_WATCHDOG_LOOP_HEARTBEAT` | default_on kill-switch | W-2 in-Bridge `InboxLoopHealthChecker` | checker 构造注入 |
| `watchdog_blocked` / `FLYWHEEL_WATCHDOG_BLOCKED` | default_on kill-switch | W-4 两活巷:LeadWatchdog blocked-keyword + HeartbeatService session_stuck。附属层(stuck_pane_confirm/watchdog_judge/pane_idle_suppress)不并、不动 | LeadWatchdog 构造注入;session_stuck 巷 call-time |
| (W-3 无开关) | — | inline guard 不设开关:verify-approval 属 merge authority,可关即安全洞 | manifest 里以 `required/no_switch` 静态合同行呈现(R1#3) |

约束:全部 `!== "0"` default-on 惯用法;**与任何投递层 flag 零耦合**(minimum-set §4)。

### S2 · W-1 收编:idle 巷精确接回 + G-1 durable 接线

**R1#1 采纳(gate 下沉)**:`RunnerIdleWatchdog.ts:257` 的闸位于整个状态机之前,直接换 flag 会连带复活
`waiting`(`:285-300`)与 `idle|unknown` 合流分支(`:302-318`)。落法:

1. `:257` 的 legacy early-return **原样保留**(它继续压住 waiting/unknown = 维持退役态,批 2 随簇处置);
   新增一条**独立的 idle-only 发射路径**:状态分类为 `idle`(bare-shell,`runner-status.ts:9-12`)时,
   由 `watchdog_liveness` 门控发射 `runner_idle_detected`;`waiting`/`unknown` 在此路径**结构性不可达**。
2. **R1#1 的「改用 probeRunnerProcessLiveness 肯定死亡 verdict」拒绝**:probe 只看 `#{pane_dead}`
   (`tmux-lookup.ts:384-400`),bare-shell 形态(Claude 进程没了、pane 里 shell 活着)probe 必返 `alive` ——
   **这恰是 probe 看不见、只有 pane 分类看得见的死亡形态**;pane 级 `dead_pin` 有肯定死亡证据,
   `absent` 则可能只是 CommDB target 过时,只能诊断并走幂等 reWake。idle 分类就是该形态的正确证据。
3. 反向测试(R1#1):`legacy=off, liveness=on` 下 waiting 与 unknown **必须静音**,仅 idle 发射;
   `liveness=off` 全静音;默认值行为对比现网 = 仅新增 idle 发射一种。
4. **G-1 durable 接线(R1#6 采纳)**:现状 `stale-approved-ship-reconciler.ts:114-118` 在 `alertDead` 前
   先写 `deadAlerted` dedup ⇒ 首投失败即永久静音。改为:callback 返回「已 durable accept(告警 ledger/queue
   落账成功)」结果,**成功后才写 dedup**;失败保留稳定 eventId(execution_id + 批准标识,不含时间戳)按
   backoff 重试。kind 落地清单:`ALERT_EVENT_TYPES` + `KIND_CONTRACTS`(owner/arc)+ ticket-owner 路由 +
   恢复 posture,implement 期逐处登记。测试:sink 不可用 → 下轮重试;queued 成功;Bridge 重启后 claims 去重;
   `liveness=0` 静音。
5. **G-1 死亡判定换四态真值(R2#2 采纳)**:现状 `gate-poller.ts:3817-3823` 用 `isTmuxSessionAlive`
   (仅 `tmux has-session`,`tmux-lookup.ts:220-239`)—— dead-pin 会读成 alive(漏报),timeout/EACCES
   被折成 false(误报死亡)。改为:先解析该 execution 的精确 tmux window,用既有四态
   `probeRunnerProcessLiveness`:`dead_pin` → death alert;`alive` → reWake;
   `absent|indeterminate` → **fail-closed 不宣告死亡** + 可观察诊断 + 仍走幂等 harmless reWake(与 minimum-set
   W-1「indeterminate 永不回收」同一纪律,但不丢失可能唯一的一次恢复机会)。测试五组:
   dead_pin / absent / alive / indeterminate / target 缺失 ——
   **target 缺失(`lookupTmuxTarget` 的 `gone` 与 `error` 两分支,`tmux-lookup.ts:150-196`)期望都写死为
   「不宣告死亡 + 可观察诊断」**;只有对精确 target 实跑 probe 得到 `dead_pin` 才告警。

### S3 · W-4 收编(episode 前置 gate,R1#8 采纳)

1. **gate 必须在任何 episode/cooldown/lastAlerted 状态变更之前**:LeadWatchdog blocked 巷在
   `state.episodeKind = kind`(`LeadWatchdog.ts:455-463`)**之前**判 `watchdog_blocked`;
   flag=0 时保持「未观察到 episode」的完整状态 —— 否则恢复钩子(`:372-376, 652-662`)会对从未发出的告警
   触发 recovery(幽灵 episode)。
2. session_stuck 巷:`checkStuckInner` 发射判定同样置于 dedup(`notifiedStuck`/quiet persist)写入之前。
3. 测试:flag=0 下 notifier、ticket、claims、recovery hook **四面全静**;默认值路径以 FLY-218/220 现有
   测试套断言字节不变。

### S4 · 真禁拍(R1#2 采纳:hard-off,不是元数据)

1. 新增 `retired-watchdog-policy.ts`:`retiredWatchdogLaneEnabled(): false`(常量 false + tombstone 注释)。
   **全部退役巷的闸从 `legacyDeliveryWatchdogsEnabled` 换到它** ⇒ `FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS=1`
   **不再能复活任何退役巷**(禁拍是代码性质,不是配置状态);代码本体保留到批 2 删。
   checkpoint-park 巡检同法(`gate-poller.ts:2103-2105` 的 `=== "1"` 换成 hard-off)。
   **Z1 僵尸门清理同法(R2#1 采纳)**:它的 gate 是独立 default_on 的 `zombieGateResolveEnabled`
   (`zombie-gate-hygiene.ts:35-39`),生产只是被 env=0 压着 —— 批 1 一并 hard-off,
   `ZOMBIE_GATE_RESOLVE=1` 复活尝试进 QA 反例。
2. registry:`legacy_delivery_watchdogs` 与六个双闸 flag + `stuck_founder_page_killswitch` +
   **`zombie_gate_resolve`(R2#1)** 标 `retiring: "FLY-1393"`;未注册活 flag
   `FLYWHEEL_CHECKPOINT_WATCHDOG` **注册为 retiring 条目**(补上形态 D 的账)。
   语义定死(R1#9):`retiring` 对 resolver = 值仍可读但组件 hard-off;对检查脚本 = env 里出现**不报错**、
   但「retiring 巷 effective_enabled=true」= **FAIL**;对 UI/manifest = 显示 retiring 徽记。
3. `RETIRED_FLAGS` tombstone 表(envVar/name/retiredIn)先登三尸体:`DETECTION_GAP_SCAN`、`STUCK_ERRORSIG`、
   `DETECTION_ESCALATION`;drift 测试加反向断言:tombstone envVar 生产 src 零布尔 gate 读取。
4. **共享模块(R1#9 采纳)**:registry + tombstone + `NON_FLAG_ALLOWLIST` 从 drift 测试内部常量抽为
   `packages/config` 生产导出,脚本与测试同源;`CHECKPOINT_WATCHDOG` 注册后从 allowlist 移除。
5. ops:`~/.flywheel/.env` 删两行尸体残留;生产不显式设 `FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS`(hard-off 后
   该 flag 对退役巷已 inert,写 0 只是文档性动作,由 Tadashi 定要不要留注释行)。

### S5 · check-flag-truth 检查脚本(验收 3)

- **静态层**:`.env`(默认)或 `--live`(`ps eww` 活 Bridge)的全部 `FLYWHEEL_*` → 必须命中
  {active flag ∪ 共享 allowlist ∪ retiring 名单};命中 tombstone → FAIL(打印「删这行」);未知变量 → FAIL。
- **运行层**:curl `/health` watchdog manifest 与期望集比对;**「retiring 巷 effective_enabled=true」= FAIL**
  (R1#2);manifest 字段语义见 S6。
- 自证:阳性对照进脚本自测(塞假 env var / 改错期望集 → 必须红)。

### S6 · W-2 补强(manifest 健康语义 + 探针降级告警)

1. 前置核验:确认 `com.flywheel.bridge-liveness-probe` 生产 launchd 实际加载;未加载先按 FLY-1082 模板部署。
2. `/health` 增 `watchdogs` 段,**带 schema version**(R1#5)。字段语义(R1#3 采纳 —— 「最近发射时间」
   不是健康证据,健康系统可能几个月不发射):每组件报
   `wired` / `effective_enabled`(flag 现值 × hard-off 合成)/ `last_check_started_at` / `last_check_completed_at`
   / in-flight age / **cadence-aware freshness**(按各自 tick 周期判新鲜:LeadWatchdog 每 Lead 默认
   10min 且多 Lead 错峰、idle watchdog 3s、checker 5min);`last_emitted_at` 仅审计不判健康;W-3 行 =
   `required/no_switch` + `observation=static_contract` 静态合同,避免把静态盘点伪装成运行时心跳。
   W-1 的 3s pane capture 是进程存活基元;历史上搭车且可能调用模型的 quota/auth classifier 保持独立
   1h cadence,并在 callback 前先 claim,异常也不形成 3s 重试风暴。
   `wired` 从 tracker 实际注册到对应 runtime component 后才翻 true,不写死;支持的一键关闭只把
   `effective_enabled` 报 false,**不等于 manifest 损坏**。外部探针把 disabled 列为独立状态并继续评估
   其它巷,尤其不能因 W-4 被关而跳过 W-2 stalled。
   post-listen 构造的实例经 **late-bound health provider** 接入。数据请求时现读,不依赖任何 in-Bridge tick。
3. `bridge-liveness-probe.sh` 扩维(R1#4/#5 采纳):
   - stalled 维度:/health 可达且 manifest 报循环停滞超阈值(阈值 ≥ in-Bridge 10min,避免抢跳)→
     既有 episode-latched @Annie 页路径,独立 episode key;
   - **manifest 降级不许永久静默**:从外部探针首次连续观察到 invalid 起算 rollout grace(不使用可能已很大的 Bridge uptime),
     grace 后且连续 N 次 unknown(字段缺失/解析失败/schema 不识)
     → 独立 `watchdog_manifest_degraded` episode 页,恢复发 all-clear;`/health` 解析 `ok` 字段,不只看 2xx;
   - state file 升级:单一 downCount 结构 → **按 cause 分桶(down / stalled / manifest_degraded / disabled)、原子写入、
     旧格式迁移**;各桶独立 latch/恢复,互不遮蔽。
   - **stalled 桶为 per-Lead 粒度(R2#3 采纳)**:state 持久化 `stalledByLead` 集合;fleet 级单 episode 页
     (避免逐 Lead 刷屏),但**成员变化发 update**(A 已 latch 后 B 加入 → update;A 恢复 B 仍停 → update,
     **不发 all-clear**;集合清空才 all-clear)。
   - **不可观测期转移表(R2#3)**:down 期间其它观测态 **freeze**(不推进不恢复);up + 坏 manifest 只推进
     degraded 计数;up + 有效 manifest 才逐 Lead 评估/恢复 stalled。测试交错序列:A stall → B 加入 → A 恢复
     B 仍停;stalled 期间 Bridge down 再 up;恢复后 manifest 仍坏。
   - 支持的 minimum-set kill switch 关闭态输出 `ok disabled=<components>`,并通过独立外部通道立即提醒、
     默认每 1440min 低频复提醒、重开时 all-clear;投递失败不置 latch,下轮重试。它不进入 degraded 桶、不提前
     return;stalled 集合仍照常推进。只有结构/schema/wiring/W-3 evidence 损坏与 retiring 巷复活才是 manifest invalid。
4. W-2 故障注入(R1#4 采纳):DB 回拨会被 1s/30s tick 覆盖、赶不上 60s 探针窗 —— **降级为 manifest 组装单测**;
   真机注入改用**确定性 fault seam**:仅暂停单个 Lead 的 `LeadInboxLoop`(tick 在 `recordTickStarted` 后
   永久 pending 的注入点,QA 环境专用、生产路径零行为),保持 /health 与其它 Lead loop 正常 ——
   分别验证 in-Bridge checker 与外部探针各自 episode、恢复、互不遮蔽。

## 3. 批 2 切片(删拍;前置 = §3.1 全过 + soak 干净)

### 3.1 FLY-1392 检查单 = 行为项 + **原子性硬门**(R1#7 采纳)

**全局硬门(先于逐条行为核)**:`architecture-target.md §2.4` 三条原子性合同 —— evidence 绑 actor+owner fence、
副作用幂等或 transactional outbox、逐消息类型 evidence 定义 —— 必须在**已合 main 的 1392 实现**里给出
merged code anchor,并有 crash-window(副作用已做 evidence 未写)/ replay(重放不重副作用)/ wrong-actor
(他人副作用不冒充本 Lead 收据)三类测试。**硬门不过,批 2 整体不开工** —— 上游明文:三条不成立,
「催已过门结构性消失」等推论全塌(target §6)。

行为项(逐条核过才动对应删除):

| 退役组件 | 1392 替代 | 核法(行为)+ anchor 要求 |
|---------|----------|------------------------|
| misroute 捞回 | 入队拒未知收件人 | 未知收件人投递被拒且可观察;anchor + 测试 |
| lead-pending 催办/升级 | processed_at 超时升级 | 压住 blocking 问题 → 升级链触发 |
| founder-reply-watchdog | 收据+重发闭环 | founder 回复故障注入 → 重发/升级可见 |
| ack/redeliver/dead-letter + guardrail 重投 | 队列内建重试/死信 | 死信路径 + 上限告警存在 |
| gate_timed_out | 无收据超时升级 | review 超时升级可见 |
| 四 tick(gap-scan 等) | 缺口=无收据自见 | 随上四条隐含 |
| StuckRunnerDetector 簇 | 无收据 30min 升级 + W-4 活巷 | 升级链在岗 + S3 已收编 |
| checkpoint-park / Z1 | processed_at 超时 / 门答销账 | 门生命周期核验 |
| **AlertChannelHub T2 腿** | 收据驱动升级 | **逐 kind 替代矩阵**(R1#7):T2 现做 recovery check / ARC 二次 retry / unresolved escalation 的完整生命周期(`AlertChannelHub.ts:757-881`),generic processed_at ≠ incident 修复完成;每个 alert kind 写明由 1392 哪个语义承接,矩阵不全 **P7 不删** |

任何一条核不过 → 对应组件保持 hard-off 不删,报 Tadashi;不阻塞其它条目。

### 3.2 删除序列(每删除独立 commit)

P1 gate-poller 巷 → P2 HeartbeatService 两腿 → P3 plugin 四 tick + misroute 接线 →
**P4a keep/delete/migrate 审查 commit(R2#4 采纳:具名产物 + 审查过 = P4 硬门)** —— 初裁如下,
对已合 main 的 1392 复核后定稿:

| 消费面 | 初裁 | 依据/待核 |
|--------|------|----------|
| `stuckDetectorHolder` 馈送与构造(`plugin.ts:5142-5146, 6541-6549, 6637-6667, 9357-9378`) | delete | 簇本体 |
| remanage `re_arm` 端点(`stuck-remanage-routes.ts:155-208, 414-583`) | **migrate** | `plugin.ts:1078` 自述:detector 关闭时 `re_arm` 仍删 DB latch —— 残留卫生语义要么保留要么随表一起裁,P4a 定 |
| `stuck_dispositions` 等历史表 | **keep 数据、停写入** | 审计价值;保留策略 P4a 写明。**停写入 ≠ 整段移除**(R3 备注 2):recovery-nudge 的 `applyStuckDispositionWithReceipts`(`runner-recovery-nudge.ts:267-320`)把旧表写、unified episode resolve 与 founder 回执放在同一事务 —— P4a 须拆出 unified-only primitive,只停旧表写、保留 ack/receipt 副作用 |
| detection ACK mirror | delete | 簇附属 |
| runner-recovery-nudge | **keep(不动)** | 独立在岗组件(research §2.6),只切断与簇的交互点 |
| 判定/确认共享件(`watchdog-judge` 路由、error-signatures) | **keep** | 被活着的 FLY-1234 confirm 层消费(research §1) |

→ P4 簇删码(P4a APPROVED 后)→ P5 checkpoint-park + Z1 删码 → P6 LeadWatchdog 冻结巷 + suspicious 巷
(W-4 若砍则 blocked 巷同批)→ **批 2a:T2 腿独立禁用 commit + 24h soak**(前置 §3.1 逐 kind 矩阵;
只关 retry/escalation,保留 T1 与恢复能力)→ **批 2b:P7 T2 删码** → P8 flag 拆除 + 全部转 tombstone +
总闸删除 → P9 复跑 check-flag-truth + drift + 24h 复观察。

## 4. QA 矩阵(验收 1/2;真机 = 529 Room 隔离,soak 除外)

### 4.1 故障注入(529 Room)

| 条 | 注入 | 期望 |
|----|------|------|
| W-1 | 真 runner,kill pane 内 Claude 进程(留 bare shell) | poll 周期内 `runner_idle_detected` 落账且 Lead 收到;**waiting/unknown 场景(卡输入框/杀 tmux server)静音**(R1#1 反向);`liveness=0` 对照静音 |
| W-1/G-1 | approved-ship + dead session;**首投注入 sink 失败** | 恢复后重试成功恰一条(R1#6);claims 去重防重复 |
| W-2 既有面 | kill -9 Bridge 阻止重生 ≥5min | 外部探针 @Annie(FLY-1082 回归) |
| W-2 新维度 | **fault seam 暂停单 Lead loop**(HTTP 与他 Lead 正常;effective Comm root 必须位于系统 temp 且不在 `~/.flywheel`) | manifest 报 stalled;探针独立 episode 页;in-Bridge checker 同触;两通道互不遮蔽;恢复各自 all-clear |
| W-2 降级 | 破坏 manifest(缺字段/坏 JSON) | 连续 N 次后 `watchdog_manifest_degraded` 页;恢复 all-clear(R1#5) |
| W-3 | head 漂移 → verify-approval 拒;归档改名错误路径 | 既有行为在岗(回归级) |
| W-4 | FLY-218/220 套回归 + `blocked=0` 对照 | flag=0 下 notifier/ticket/claims/recovery **四面全静**(R1#8 幽灵 episode 断言);默认路径字节不变 |
| W-4 关闭不遮 W-2 | `blocked=0` + Lead A loop stale | manifest 结构仍 valid,输出 disabled;关闭提醒与 W-2 stalled 同轮各自触发;每日复提醒、重开 all-clear |
| 真值·阳性对照 | 塞假 env var / 改错 manifest 期望 | **脚本必须红**,还原后绿 |
| 真值·复活尝试 | `LEGACY=1` / `ZOMBIE_GATE_RESOLVE=1` 置入 | 退役巷仍 hard-off、manifest `effective_enabled=false`、**truth check 保持绿**(retiring env 出现不是静态失败 —— R3 备注 3,防实现者误改语义) |
| G-1 判定 | 五组:dead_pin / absent / alive / indeterminate / target 缺失 | 仅 dead_pin 告警;alive 直接 reWake;absent 与 indeterminate 都诊断后走幂等 harmless reWake、不得宣告死亡 |
| 探针状态机 | 交错序列:A stall→B 加入→A 恢复 B 仍停;disabled 首投失败/日提醒/重开;stalled 中 Bridge down/up;up 后 manifest 仍坏 | 成员 update 不误 all-clear;disabled 投递重试且不遮 W-2;down 期 freeze;degraded 独立推进(R2#3) |

### 4.2 独立 QA
按项目硬门(FLY-1211):实现 runner 主动起独立 QA;qa-result PASS 只在全部硬门(含 codex code review)过后。

### 4.3 生产 soak(验收 2,兼批 2 前置)
批 1 ship + Bridge 单次重启(bridge-ship-discipline:先改配置后杀进程)→ 24h:claims.db + 告警账本零假警报;
soak 干净才进批 2。

## 5. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 批 1 新开关引入行为漂移 | default_on + 字节兼容断言;单 flag 回滚 `=0` |
| hard-off 关闭了 legacy=1 逃生口 | 这是有意的(禁拍语义);真要临时复活 = git revert 对应 commit,不是翻 env |
| G-1 新告警刷屏 | 事件罕见 + 稳定 eventId 去重 + durable-accept 后才 dedup |
| 探针误页 Annie | stalled 阈值 ≥ in-Bridge 阈值;manifest 降级有 grace + 独立 episode(不混入 down) |
| 批 2 误删仍被依赖代码 | §3.1 硬门 + P4 keep/delete/migrate 表 + 独立 commit 回滚 |
| 1392 实现偏离 target | 检查单核**行为与 anchor**,核不过就不删 |
| Bridge 重启窗 | 单次重启;sessions 保活按既有先例 |

## 6. W-4 决策 brief(由 Tadashi 转呈 Annie;双分支,不阻塞本设计)

**问题**:「活着但干不了活」检测(W-4)保不保?四条里唯一有取舍空间的一条(1391 复核结论)。

**现状**:两条活巷 —— Lead 侧 blocked-keyword(额度/auth/权限,含 FLY-218/220 三重防刷屏硬化)、
runner 侧 session_stuck + FLY-1234 pane 确认层(正面证据才 emit;昨晚 FLY-1395 两次告警即此巷,
该案例真阳性未独立验证,见 research §5-2)。一条死巷 —— 冻结巷(pane_hash_stuck)无论如何永久删(Tadashi 已预同意)。

| | 保留(推荐) | 砍掉 |
|---|-----------|------|
| 收益 | Lead/Runner 静默瘫痪**即时**可见 | 零此类打扰 |
| 代价 | 历史刷屏重灾区(FLY-193/218/220);三重硬化后需 soak 佐证 | 漏报=慢 ~30 分钟(1392 升级兜),不可逆盲区 |
| 开关 | `FLYWHEEL_WATCHDOG_BLOCKED` default_on,一键可关 | flag default_off 或不建,巷删码 |

**推荐**:保留 + default_on。三重硬化已生产验证;独立开关就是「嫌吵随时关」的行使方式;保留的下行被开关封顶,
砍掉的下行不可逆。

## 7. 复核记录

Codex design review(xhigh,persistent session)**3 轮 → APPROVED**:

- R1 CHANGES REQUESTED(7 BLOCKER + 2 HIGH,全采纳,1 处部分拒绝):W-1 闸点会连带复活 waiting/unknown
  (→ gate 下沉 idle-only 独立路径);retiring 元数据不构成禁拍(→ hard-off 政策模块,legacy=1 不可复活);
  last_emitted 不是健康证据(→ manifest 改 cadence-aware check 时间戳);DB 回拨注入会被 tick 覆盖
  (→ 确定性 fault seam);manifest fail-quiet 复制静默病(→ degraded episode);G-1 dedup 先于投递
  (→ durable-accept 后 dedup);1392 检查单漏原子性合同(→ target §2.4 升为全局硬门);W-4 幽灵 episode
  (→ episode 前置 gate);allowlist 未共享(→ config 包共用模块)。
  **部分拒绝且 R2 接受**:「W-1 改用 probe 肯定死亡 verdict」—— probe 只看 pane_dead,bare-shell 形态
  结构性看不见,idle pane 分类才是该形态的证据。
- R2 CHANGES REQUESTED(2 BLOCKER + 2 HIGH,全采纳):Z1/T2 漏在禁拍外(→ Z1 批 1 hard-off;T2 批 2a
  独立禁用+soak → 批 2b 删);G-1 死亡判定弱于仓库标准(→ 四态 probe,indeterminate fail-closed 但保留幂等 reWake);
  探针 stalled 缺 per-Lead 粒度与不可观测期转移(→ stalledByLead + 转移表);P4 缺具名裁定(→ P4a 初裁表+硬门)。
- R3 **APPROVED** + 3 条 NON-BLOCKING(已折入:G-1 target-missing 期望写死、P4a 保留 recovery-nudge
  回执副作用、truth QA 拆两类预期)。

## 8. 边界与 follow-up

- 不做:收据/重发/升级闭环(FLY-1392)、统一升级流与 G-15/G-16(FLY-1388 re-scope)、规格回写(D-1)、
  complete-marker-reconciler、G-5/G-6/G-7。
- **Follow-up 指针(请 Tadashi 建单)**:supervisor / break-glass(W-2 检测 ≠ 缓解;target §1.3 三件套)。
- 两批共用本分支/同一 issue;批 2 因 1392 时序拖长时是否拆单,Tadashi 届时裁定。
