# FLY-1393 看门收编 — 探索

Issue: FLY-1393 (https://linear.app/geoforge3d/issue/FLY-1393/foundation看门收编-watchdog-最小集落地-开关真值修复-关掉的检测按-1391-四条清单收编假开关拆除1392-之后)
日期: 2026-07-21
基于: FLY-1391 `watchdog-minimum-set.md` · `architecture-current.md` · `architecture-target.md` · `research.md` · `plan.md`(裁定基线,不重查)

> 本文是 FLY-1393 design 阶段的第一份文档:把 issue 的四条 scope 展开成可裁定的设计问题,每个问题给选项与倾向。
> 证据分两层:FLY-1391 交付物直接引用;本单**增量核查**(本分支代码 audit + 2026-07-21 活进程运行事实)单独标注。
> 增量核查的完整 file:line 证据在 research.md;本文只引结论。

## 0. Founder 意图(recite,所有裁定向这两句对齐)

Annie 2026-07-20:

> 「勉强为(进程死了)这种比较少的情况,我们还是需要有 Watchdog 做一个最终的防线。但是我希望 Watchdog 一定要精简再精简。」
> 「我们整个发送信息的机制(包括收据的机制)都还没有完全做好…需要先把发送机制这边都修好。」

⇒ 两条设计公理:

1. **精简 = 结构性的,不是关几个开关。** 判据只有 FLY-1391 `watchdog-minimum-set.md §0` 那一条:
   凡是失败模式本身会让进程发不出消息的,消息语义永远覆盖不了它 —— 收据管「做没做」,watchdog 只管「还在不在」和「外面变了没有」。
2. **先修发送机制(FLY-1392),再画 watchdog 裁定线。** 裁定基准 = 「消息+收据语义覆盖之后还剩什么必须外部观测」。

## 1. 本单增量核实的事实(改变设计形状的六条)

FLY-1391 的运行事实是 2026-07-20 时点快照,Bridge 此后重启过。本单同尺重测(活进程 pid 36285;
阳性对照:`ps eww` 读出 **59** 个 `FLYWHEEL_*` 变量,与 1391 一致)+ 本分支(HEAD `91817ec80`)代码 audit:

### 1.1 开关基线今天仍成立,且「病」比 1391 记录的大

- `FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS` 仍缺失;`DETECTION_GAP_SCAN=1`、`STUCK_FOUNDER_PAGE=1` 仍在。
- **增量**:`FLYWHEEL_STUCK_ERRORSIG=1` 也在 env 里 —— FLY-1243 已退役、生产代码零读取(仅注释)。**第三条残留,1391 没列**。
- **增量(最重)**:「flag 显示开、组件没在跑」不止 issue 列的两个 —— registry 里 **六个 default_on flag** 的组件全被
  legacy 总闸压死:`misroute_patrol`·`founder_reply_watchdog`·`lead_pending_escalation`·`park_watch`·
  `stuck_detect`·`stuck_founder_page_killswitch`。这是**结构性双闸病**:per-lane flag 说开,master gate 说关,
  查 env / 查 registry 都得出错误结论。
- **增量**:`FLYWHEEL_CHECKPOINT_WATCHDOG` **未注册**(registry 缺席)却在 `gate-poller.ts:2104` 活读 —— 真值表反向的洞。

⇒ 「开关真值」的病理定稿为**四种形态**:

| 形态 | 实例 | 修法 |
|------|------|------|
| A. 陈旧 env 残留(flag 已退役,零读取) | `DETECTION_GAP_SCAN=1` · `STUCK_ERRORSIG=1` | 清 env + registry tombstone,检查脚本防再犯 |
| B. 真·假开关(有读取,组件不可达) | `STUCK_FOUNDER_PAGE=1`(stuck detector 生产零馈送) | 组件裁定(退役)后连 flag 一起拆 |
| C. 双闸(per-lane flag default_on,legacy 总闸压死) | 上述六个 registry flag | 删总闸 + 巷退役 → 双闸结构性消失 |
| D. 未注册活 flag | `CHECKPOINT_WATCHDOG` | 随巷退役删除(若留必须注册) |

### 1.2 W-2 的外部 failure domain 已有骨架(FLY-1082,1391 未提)

`scripts/bridge-liveness-probe.sh` + `com.flywheel.bridge-liveness-probe.plist`:launchd 每 60s、
**部署在 Codex Infra Bot 的 launchd 域**(「nobody rescues their own side」)、curl `/health`、
连续 5 分钟不通 → episode-latched 单条 @Annie(统一频道)、恢复报一次 all-clear。
加上 Bridge 自身的 launchd `KeepAlive` 与 `BridgeEventLoopWatchdog`(event loop 卡死 → SIGKILL → 变成可重生的 crash),
**「Bridge 死了」四层兜底已在**。

⇒ W-2 真正剩的缺口只有一个:**外部探针只探「/health 通不通」,不探「投递循环在不在推进」** ——
Bridge 活着、HTTP 通着、但 HeartbeatService tick 卡死(in-Bridge 的 `InboxLoopHealthChecker` 恰好挂在这个 tick 上)
时,投递循环卡死无人报。这就是 minimum-set W-2「自指未解」在现状里的**精确残余**。

### 1.3 G-13(shell 告警不认统一频道)已修

`lead-alert.sh:244` 已读 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`(FLY-927),且生产 `~/.flywheel/.env` 里
`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` 与 `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` **都已设**(脚本每次运行 source .env)。
1391 research.md §6.2 引用的 FLY-915 文档行是陈旧的。⇒ 本单不需要修 G-13,只在验收里实测确认一次。

### 1.4 RunnerIdleWatchdog 的「idle」语义确证了 issue 的 W-1 归类

`runner-status.ts` 分类四态:`executing` / `waiting`(在等输入或 45s 无变化)/ **`idle` = tmux 窗口活着但
Claude 进程没了(bare shell)** / `unknown`。⇒ `runner_idle_detected` 发射的主形态是
**「进程没了但窗口还在」的人可见告警** —— 这正是 W-1 存活告警巷,issue 的「分类错误必须移出」成立。
而同类里的 `waiting`/StuckRunnerDetector 馈送是「卡住检测」= FLY-1048 检测簇成员,按 minimum-set §3 该消失。
⇒ **移出 legacy 半径的是 idle(存活)告警;stuck(卡住)不移,随簇退役。**

### 1.5 W-1 的探测基元全部没被 legacy 闸住(与 1391 一致,本分支复核)

`probeRunnerProcessLiveness` 的全部消费者(HeartbeatService 三处 / crash-reaper / phase-orchestrator /
terminal-thread-archive / done-thread-reconcile / lifecycle-closeout 等)零 legacy 依赖,生产在跑。
被闸死的只是**面向人的告警巷**(idle 发射、gate_timed_out、pane 冻结巷、suspicious 报告)。
⇒ W-1 落地 ≠ 造探测,= **把「死了要出声」的巷接回来**(含 G-1 `stale_approved_ship_dead` 零人类触达的修复)。

### 1.6 LeadWatchdog 内部三巷的 legacy 边界清晰

blocked-keyword 巷(W-4)+ 三条硬约束(episode-latch / ownStateRegion 回声免疫 / isTransientThrottlePane)
**全部不在 legacy 闸内,生产在跑**;被闸死的是冻结巷(`pane_hash_stuck`/`pane_error_stalled`)与
多帧 suspicious 报告巷。⇒ W-4 现状 = 已在岗,缺的只是**独立开关**;冻结巷去留并入 W-4 决策材料。

## 2. 设计问题一:收编分类表(本单核心交付物)

「收编」= 给现存**每一个** watchdog 类组件一个定案归属,判据用 minimum-set 的语义,不用组件名:

| 归属 | 判据 | 后果 |
|------|------|------|
| **W-1 存活** | 检测「进程死了」,死者发不出消息 | 告警巷接回,独立开关,移出投递半径 |
| **W-2 循环心跳** | 承载消息的机制自己停了(自指) | 保留 + 外部探针补投递循环维度 |
| **W-3 外部漂移** | 对端不给我们发收据 | 盘点确认在岗(多为 inline guard,不设开关) |
| **W-4 活着但干不了活** | W-1 与收据之间的盲区带 | 保留,独立开关,去留呈 Annie |
| **投递类 → 退役** | 巡逻对象在 1392 里是队列一等属性 | 删码 + 删 flag,绑 1392 落地检查单 |
| **在岗不动** | 非投递类、诚实开关、不属最小集四条 | 盘点标注,不碰 |

分类定稿(逐组件 file:line 证据见 research.md):

| 组件/巷 | 现状 | 归属 | 目标态动作 |
|---------|------|------|-----------|
| `probeRunnerProcessLiveness` 基元 + HeartbeatService 五态 probe + 「仅肯定 alive 才刷 heartbeat」守卫 | ✅ 在跑 | W-1 基元 | 不动(守卫必须保留,minimum-set §3.5) |
| crash-reaper / zombie_reconcile / server-loss / stale-close / viewer-reaper / cmux pane-died hook / fleet_sensor_tmux | ✅ 在跑 | W-1 消费者(回收/fleet) | 不动 |
| **RunnerIdleWatchdog `idle` 发射巷**(`:257`) | ❌ legacy 圈内 | **W-1 告警巷(收编)** | 移出 legacy → `FLYWHEEL_WATCHDOG_LIVENESS`(default_on) |
| G-1 `stale_approved_ship_dead`(console.warn + 无人读的审计行) | ⚠️ 零人类触达 | W-1 告警巷 | 接到统一告警频道(修法=接线,不是补记录) |
| RunnerIdleWatchdog → StuckRunnerDetector 馈送(`:202`)+ stuck-escalation + `STUCK_FOUNDER_PAGE` + `stuck_detect` + `stuck_pane_confirm` + `watchdog_judge` | ❌ 生产零馈送 | 检测簇(卡住)→ 退役 | 删码 + 删 flag(附属层核实无他消费者后随簇删);绑 1392 检查单 |
| HeartbeatService `gate_timed_out`(`:701`) | ❌ legacy 圈内 | 催办类 → 退役 | 删码(1392 §D 无收据超时升级取代) |
| HeartbeatService guardrail 重投腿(`:596`) | ❌ legacy 圈内 | 投递重发 → 退役 | 删码(1392 队列重发取代) |
| misroute 捞回(`gate-poller.ts:1012` + `misroute_patrol` flag) | ❌ legacy 圈内 | 投递类 → 退役 | 删码 + 删 flag(1392 入队拒绝未知收件人取代) |
| lead-pending 催办+升级(`:1881`/`:1054` + `lead_pending_escalation` flag) | ❌ legacy 圈内 | 催办类 → 退役 | 删码 + 删 flag(processed_at 超时取代;连带 G-18 P3 错位一起消失) |
| founder-reply-watchdog(`:606`/`:1133`/`:3594` Z2 + `founder_reply_watchdog` flag) | ❌ legacy 圈内 | 投递类 → 退役 | 删码 + 删 flag(1392 收据取代) |
| delivery-ack / redeliver / dead-letter 腿(`plugin.ts:4280,4329` + lead-event-ack-policy) | ❌ legacy 圈内 | 投递类 → 退役 | 删码(1392 队列内建) |
| gap-scan / detection-reconcile / park-watch / delivery-reconcile 四 tick(`plugin.ts:7016-7051` + `park_watch` flag) | ❌ legacy 圈内 | 检测簇/投递类 → 退役 | 删码 + 删 flag |
| checkpoint-park 巡检(`:2103` + 未注册 flag `CHECKPOINT_WATCHDOG`) | ❌ 独立 flag=0 | 催办类 → 退役 | 删码 + 删未注册 flag |
| `ZOMBIE_GATE_RESOLVE` Z1 僵尸门清理(env=0 诚实关) | ❌ OFF | 陈旧门驱逐 → 退役 | 删码 + 删 flag(1392 门答→销账取代) |
| AlertChannelHub **T2 按年龄升级腿**(G-15 缺陷所在) | ✅ 在跑 | 催办类 → 退役 | **绑 1392 升级闭环在岗后**才禁删 —— 它是当前唯一在跑的升级腿,提前禁 = 裸奔 |
| AlertChannelHub 其余(T1 建工单/告警线程/路由) | ✅ 在跑 | 告警投递面,非巡逻 | 不动 |
| loop_heartbeat → `inbox_loop_stalled`(in-Bridge checker) | ✅ 在跑 | W-2 | 保留 + `FLYWHEEL_WATCHDOG_LOOP_HEARTBEAT`;外部维度见 §4 |
| BridgeEventLoopWatchdog + launchd KeepAlive + bridge-liveness-probe.sh | ✅ 在跑 | W-2 家族 | 不动;外部探针**扩一个维度**(§4) |
| LeadWatchdog blocked-keyword 巷 + 三硬约束 + `pane_idle_suppress` | ✅ 在跑 | W-4 | 独立开关 `FLYWHEEL_WATCHDOG_BLOCKED`;去留呈 Annie(§6) |
| LeadWatchdog 冻结巷(`pane_hash_stuck`/`pane_error_stalled`,`:561`)+ suspicious 报告巷(`:519`) | ❌ legacy 圈内 | W-4 邻域(frozen) | **保持退役**(FLY-193 误报史;漏报由 1392 30min 升级兜)——并入 W-4 决策材料呈 Annie |
| W-3 inline guards:`isArchivedThreadError` / verify-approval `pr_head_sha` / `gh pr checks` 探针 / 配额监控(runnerQuotaScan,legacy 圈外仍跑)/ auth 过期检测 | ✅ 在跑 | W-3 | 盘点收口成清单;**不设开关、不建统一巡检**(§3) |
| complete-marker-reconciler | ✅ 在跑 | ~~W-5~~ MQ 崩溃语义旁路补偿 | 本单不碰(1392/后续吸收) |
| `lead_dual_active_scan` / auto-QA / AutoRepairBot / runner-recovery-nudge | ✅ 在跑 | 非投递类 | 不动,盘点标注(recovery-nudge 的 5 道活状态闸是 G-15 修法范本,留作 1388 参照) |

## 3. 设计问题二:开关模型

minimum-set §4 硬要求:**每条保留的 watchdog 必须有自己独立的开关,且不得与任何「投递层」flag 耦合。**

倾向方案:

- 新增(注册进 FLY-709 registry,`default_on` kill-switch):
  `FLYWHEEL_WATCHDOG_LIVENESS`(W-1 告警巷:idle 发射 + dead 告警接线)·
  `FLYWHEEL_WATCHDOG_LOOP_HEARTBEAT`(W-2 in-Bridge checker)·
  `FLYWHEEL_WATCHDOG_BLOCKED`(W-4;Annie 拍砍则改 default_off 或不建)。
- **W-3 明确不设开关**:成员是 inline guard(merge 时验 head、发送时处理归档错、gate 前探 CI),不是周期巡检;
  其中 verify-approval 属 merge authority 机制,**可关反而是安全洞**。W-3 落地 = 盘点 + 验证在岗。
- **W-1 探测基元不设开关**:开关只管「发射告警」的巷;基元被资源回收共用,关基元超出 watchdog 语义。
- 删除:`FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS`(圈内巷删码后总闸拆除)+ §2 表中标「删 flag」的全部
  (misroute_patrol / founder_reply_watchdog / lead_pending_escalation / park_watch / stuck_detect /
  stuck_founder_page_killswitch / zombie_gate_resolve / 未注册 CHECKPOINT_WATCHDOG);
  env 清残留:DETECTION_GAP_SCAN / STUCK_ERRORSIG。
- **双闸病从此结构性不可能**:总闸没了,巷级 flag 与巷同生同死,「flag 开着但总闸压死」失去存在形态。

## 4. 设计问题三:W-2 独立 failure domain 的最小补强

in-scope 边界(issue 条 4):检测独立,缓解(supervisor/break-glass)不做。

现状四层已在(§1.2)。**唯一缺口**:外部探针不看投递循环。倾向方案(最小新增,不造新进程):

1. Bridge `/health`(或子端点)增加 **watchdog manifest**:请求时**现算**(直接读 DB,不依赖任何 in-Bridge tick)
   per-Lead `loop_heartbeat.last_success_at` 年龄 + HeartbeatService 最近 tick 年龄 + 四条 watchdog 巷的注册/开关态。
2. `bridge-liveness-probe.sh` 增加一个检查维度:/health 通但 manifest 报 stalled(超阈值)→ 走**同一条**
   episode-latched @Annie 页路径。外部域、告警巷、去重、latch 全部复用 FLY-1082 既有件。
3. G-13 已修(§1.3),验收实测一次即可。
4. 明确写死:探针**只告警不修复**;supervisor 是另一单(plan 留指针)。

⇒ 收益叠加:这个 manifest 同时就是 §5 检查脚本的「运行层」数据源 —— 一个机制服务两个验收项。

## 5. 设计问题四:开关真值检查脚本(验收 3「检查脚本化」)

现状缺口:FLY-709 drift test 只验「flag 在声明文件里被读」,验不了「读到的值接进了 tick」(形态 B),
不管「已退役 flag 的 env 残留」(形态 A),也没抓到未注册活 flag 的全部(形态 D 靠正向扫描,CHECKPOINT 漏因在
allowlist/测试引用)。倾向方案(两层):

1. **静态层**(脚本,可进 CI + 可对活进程跑):env(活进程 `ps eww` 或 `.env`)里每个 `FLYWHEEL_*` 变量必须是
   registry 在册 active flag 或 NON_FLAG_ALLOWLIST 成员;registry 增加 **tombstone 清单**(退役 flag 名 + 退役单号),
   env 命中 tombstone 即 FAIL 并给出「删这行」的指令。抓形态 A/D。
2. **运行层**:比对 `/health` watchdog manifest 与期望集(四条巷:注册态、开关值、最近活动时间戳)。
   「读了但没接线」在 manifest 上直接可见。抓形态 B;形态 C 已被 §3 结构性消灭。

## 6. 设计问题五:W-4 决策材料(单独呈 Annie)

唯一有取舍空间的一条(1391 复核结论)。材料两面:

- **保留侧**:Lead 静默瘫痪(额度尽/auth 过期/卡确认框)即时可见;三条硬约束已实装且生产在跑(§1.6),
  FLY-218/220 后误报根治过一轮,近况可用 claims.db 告警账本拉 30 天误报率佐证。
- **砍掉侧**:该巷历史上是刷屏重灾区(FLY-193/218/220);砍掉后漏报**不是永远发现不了,是慢 ~30 分钟**
  (1392 §D 无收据升级兜底)。「宁可漏也不要吵」是可接受取舍,不是安全事故。
- 附带裁定项:冻结巷(pane_hash_stuck,已关)是否随本单永久删码(倾向:是 —— frozen 的终态表现=消息无收据,
  1392 兜住;检测本身的误报史证明不可靠)。

呈报路径:plan.md 附 W-4 决策 brief → Tadashi 转呈 Annie;plan 做成双分支(保留→`FLYWHEEL_WATCHDOG_BLOCKED`
default_on;砍→巷删码、冻结巷同删),**不阻塞设计定稿**。

## 7. 设计问题六:与 FLY-1392 的依赖处理

事实:1392 仍 Backlog 未开工;本单 blockedBy 1392。倾向方案:**设计并行、实现串行**。

- 设计裁定基准用 `architecture-target.md`(已合 main、Codex 已审、1392 issue 明文「一切以它为准」)。
- plan 内置 **「1392 落地检查单」**:每个退役组件绑定它在 1392 里的替代语义
  (misroute↔入队拒绝未知收件人;lead-pending/checkpoint-park/T2 年龄升级/gate_timed_out↔processed_at 超时升级;
  ack/redeliver/dead-letter/guardrail 重投↔队列内建;僵尸门↔门答销账)。
  实现阶段逐条核实替代**真的落了**才动删码;1392 实现若偏离 target 设计,检查单拦住误删。
- 分批次:**批 1(不依赖 1392,可先行)**= W-1 巷移出+接线、四条独立开关、假开关/残留拆除、检查脚本、
  W-2 manifest+探针扩展;**批 2(1392 检查单过后)**= 投递类删码 + 总闸拆除 + T2 腿退役。
  这正是 1373 教训的反面:圈按「谁在兜底」画,且**兜底者到岗后才撤旧岗**。

## 8. 边界(本单不做)

- 收据/重发/升级闭环本体 = FLY-1392;统一升级流重建 = FLY-1388(1392 后 re-scope;G-15 判据修复、G-16 归档 thread 归它)。
- supervisor / break-glass(W-2 的真缓解)= 独立后续单(暂无 issue,plan 留指针请 Tadashi 建)。
- complete-marker-reconciler 不碰;规格回写(D-1)不在本单。
- FLY-1391 plan.md「如果只修三件」中的 G-5/G-6/G-7 假成功三件 = 1392/独立小单,不在本单。

## 9. 开放问题(brainstorm gate 向 Tadashi 确认)

1. 设计并行/实现串行 + 批 1/批 2 拆分(§7)是否成立?批 1 不依赖 1392,是否允许 implement 阶段先行批 1?
2. W-4 呈 Annie 的时机与路径(§6):plan 附 brief 由你转呈,双分支不阻塞设计 —— OK?
3. 退役「删」的半径:legacy 圈内巷**全删**(承接 1373「另开删码单」遗留意图)vs 保守留禁 —— 倾向前者。
4. AlertChannelHub T2 升级腿退役时序绑 1392 检查单(升级闭环在岗才禁)—— OK?
