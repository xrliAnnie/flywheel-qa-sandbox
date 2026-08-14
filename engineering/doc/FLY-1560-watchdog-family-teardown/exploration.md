# FLY-1560 拆掉 v1 看门狗全家(B方案·阶段1)— 探索

Issue: FLY-1560 (https://linear.app/geoforge3d/issue/FLY-1560/b方案阶段1-拆掉-v1-看门狗全家-逐个拆线回归1-2-天)
日期: 2026-08-14
基于: 无(本文件夹首篇;上游权威设计 = `doc/messaging-rework/design.md`(FLY-1569))

## 1. 这单在今天到底是什么(issue 考古,先对时)

FLY-1560 写于 **2026-07-31**(B 方案总单 FLY-1559 的阶段 1)。它出生时的世界:v2 还在、看门狗一个没拆、信箱还没有。此后两周世界变了,**照原文逐字执行会拆错东西**,所以先把「原文 scope → 今天还剩什么」对清楚:

| 原文 scope 条目 | 今天的状态(源码 + 生产实证) |
| -- | -- |
| stuck-detection 族(pane 猜测、timeout 推断) | **绝大部分已由 FLY-1570(PR #771,8-04 合入)物理删除**:stuck-runner-detector / StuckWatcher / stuck-candidate / stuck-escalation / pane-hash 检测链 / detection-escalation 族 / gap-scan / park-watch / misroute 巡逻 / FLY-1393 墓碑全家 |
| 收据追讨层(receipt escalation / lead_inbox 追讨) | **已由 FLY-1570 删除**(runner/lead 双收据巡逻、lead-pending 升级、resend 引擎);FLY-1645(收据账本机器拆除)另在收尾 |
| detection-ack / founder auto-page | 追讨型 auto-page 已随 FLY-1570 死亡;detection-ack 端点作为统一检测接口保留(FLY-1570 第 9 刀修过 fail-safe) |
| **RunnerIdleWatchdog / LeadWatchdog** | **还在,这就是本单的活**。FLY-1570 刻意保留了一个「最小集」:RunnerIdleWatchdog 进程存活 + 额度/登录扫描、LeadWatchdog 10 分钟 tick + W-4 blocked 识别链、Bridge 主循环自杀 watchdog、founder-reply unreachable-runner 检测器、watchdog-health 健康面 |

**founder 开工令(2026-08-14 深夜,Linear FLY-1560 评论,原话)**:「let's start 第 1 步 拆 watchdog 全家 (1560)」。评论同时给了现状快照:RunnerIdleWatchdog.ts / LeadWatchdog.ts / HeartbeatService.ts / LeadAlertNotifier.ts / LeadHealthProbe.ts 全在 main,相关代码 390 处。

**⇒ 本单今天的真实定义:把 FLY-1570 留下的「最小集」也拆掉 —— 是 A 批次的第二刀,不是重做第一刀。**

## 2. 为什么现在能拆(拆除条件盘点,逐条可证伪)

FLY-1569 设计(`doc/messaging-rework/design.md`,权威)的替代结构与落地状态:

| 替代件 | 单 | 状态(2026-08-14 实证) |
| -- | -- | -- |
| 一张 mailbox 表(收敛四条流) | C · FLY-1572 | ✅ 已合入(PR #780) |
| 租约重投 + 合批投递 + 死信闸 | D · FLY-1573 | ✅ 代码已合入(PR #798);⚠️ **生产 Bridge(PID 81583)实测 `FLYWHEEL_MAILBOX_QUEUE=0`,还没翻开** |
| Discord 入站收编 mailbox | E · FLY-1574 | ✅ 已合入(PR #797)且生产 `FLYWHEEL_MAILBOX_DISCORD=1` 已开 |
| Runner stop 通知(带原因) | B · FLY-1571 | ✅ 已合入(PR #770)—— 「正常停了」不再靠猜 |
| Lead 巡检钟(哑闹钟,Lead 自己核名册) | FLY-1687 | ✅ 已合入(PR #827),生产 48h 内 `patrol_tick` 7 条在岗 |
| Action List(task 表欠账) | F · FLY-1575 | ❌ Backlog 未做 |
| Stop hook 出口把门 | G · FLY-1576 | ❌ Backlog 未做 |

生产 48 小时事件账(`~/.flywheel/teamlead.db` lead_events,8-12→8-14 实测):要拆的家族还在产出 —— `inbox_loop_stalled` 109 条、`runner_idle_detected` 62 条、`zombie_session_backlog` 42 条;同时替代件在岗的证据 —— `mailbox_dead_letter` 78 条(死信闸真在干活)、`patrol_tick` 7 条。

**对齐结论(issue 风险节「真正切换投递通道之前,最后一层保护不撕」在今天的具体化)**:
- 信箱代码全在,但 **D 单租约/死信闸生产开关还是 0** → 本单可以并行开发,但 **ship 顺序有硬前置:`FLYWHEEL_MAILBOX_QUEUE=1` 先在生产翻开并观察正常,才许合入撕保护层**(翻开动作属 FLY-1573/部署链,不是本单的活,本单只把它写成 ship 前置门)。
- F/G(出口把门)未落地 → 「Lead 停手时还欠着账」这一类没人管。这不是本单要补的洞(那是 F/G 的活),但**诚实边界必须写明**:拆完之后到 F/G 落地之前,这类漏靠 FLY-1687 巡检钟 + Lead 自查兜。

## 3. 要拆的对象盘点(初版,研究阶段逐个核销)

按 founder 快照 + 源码现状,家族剩余成员:

1. `packages/teamlead/src/RunnerIdleWatchdog.ts` — 进程存活收尸 + idle 检测(`runner_idle_detected`)+ 额度/登录扫描搭车
2. `packages/teamlead/src/LeadWatchdog.ts` — 10 分钟 tick 载体 + W-4 blocked 识别链(usage-limit/rate-limit/529/resume-menu 分类器,FLY-1218/1220 那套)
3. `packages/teamlead/src/HeartbeatService.ts` — 心跳记账(FLY-172 孤儿对账一族的地基?研究阶段核)
4. `LeadAlertNotifier`(位置待核)+ claims.db 告警发射链 — **注意边界:通用告警传输 vs watchdog 专用发射器**,前者归 FLY-1764 重设计,本单不动
5. `packages/teamlead/src/lead-backends/codex/LeadHealthProbe.ts` — Codex Lead 健康探针
6. `packages/teamlead/src/bridge/BridgeEventLoopWatchdog.ts` — Bridge 主循环自杀器(**自我存活,不是盯别人**;FLY-1570 QA 沙箱实证 SIGKILL 有效、救过命)
7. `packages/teamlead/src/bridge/founder-reply-watchdog.ts` — unreachable-runner 数据一致性检测(活会话但 CommDB 登记行没了)
8. `packages/teamlead/src/bridge/watchdog-health.ts` + `watchdog-minimum-set.ts` + `/health` watchdogs manifest + `scripts/bridge-liveness-probe.sh` 外部契约
9. `packages/teamlead/src/account-heal/account-switch-watchdog.ts` — 账号切换(FLY-1456 quota daemon 固化后是否已是死路?研究阶段核)
10. `inbox_loop_stalled` / `zombie_session_backlog` 的现存发射器(FLY-1570 拆过一轮之后还在响,发射器在哪?研究阶段核)

## 4. 核心张力(设计要拍的板)

**张力 1:「grep 零命中」vs「不是所有叫 watchdog 的都是看门狗」。**
验收 1 要求 `grep -ri watchdog packages/teamlead/src` 零命中(fixture 除外)。但家族里至少两个成员的行为不是「盯 agent 的创可贴」:
- BridgeEventLoopWatchdog:盯的是**自己进程**的事件循环,挂了自杀由 launchd 拉起 —— 这是进程自愈,信箱替代不了它,巡检钟也替代不了它;
- founder-reply unreachable-runner:抓的是**真实数据不一致**(两张表打架),是对账器不是猜测器。
选项 A:全删,一个不留(字面服从,代价是丢真保护);选项 B:行为该留的留,**改名 + 挪家**,让「watchdog」这个词和「盯 agent 猜死活」这个机制一起从代码里消失,PR body 逐条声明「保留了什么行为、为什么、改叫什么」(对验收的诚实解释:零命中达成,但靠的是改名的那几条要摆在明面上,不许藏)。→ 倾向 B,理由:issue 的病根定义是「消息会丢的创可贴」,自我存活和数据一致性对账不在病根定义内;founder 快照点名的五个文件全数处理。
**改名不是免死金牌**:每一个「保留行为」都要过一遍「它是不是在盯别的 agent 猜死活」—— 是,就删,不管它叫什么名字。

**张力 2:idle/blocked 检测删掉后,「进程活着但人卡死」谁发现?**
FLY-1570 已接受过一轮这个风险(批 1→批 2 空窗)。今天的兜底比那时厚:stop 通知(B)、死信闸(D,待翻开)、巡检钟(1687,Lead 每到点核名册)、pane-loss reconciler(FLY-1628,换代死体收敛)。设计要如实写:**删掉的是「系统替 Lead 盯」,留下的是「Lead 到点自己看」+「信箱到期自己重投」**,残余盲区 = Lead 巡检间隔内的卡死不被主动发现 —— 这是 founder 在 FLY-1569 §7/§8 里已经拍过的方向(出口把门替代看门狗),不是本单新引入的风险。

**张力 3:额度/登录扫描是外部事实,不是消息问题。**
`runner_login_expired`、额度耗尽这类事实系统自己不产生事件,靠扫描发现。信箱救不了它们。删 RunnerIdleWatchdog 时这两个搭车检测怎么办:跟车一起死(退回人肉发现)/ 挪到别的载体(quota daemon FLY-1456 已固化、runner-quota-scan)。研究阶段核清楚现有 quota daemon 的覆盖面再定。

**张力 4:告警传输层的边界(与 FLY-1764 划界)。**
开工令原话:「本单只拆,不建新告警路由 —— 拆出的空洞由 1764 补」。所以:watchdog 专属的**发射器**全删;`LeadAlertNotifier`/`AlertChannelHub`/claims.db 这层**传输**如果还有非-watchdog 客户(死信通知、巡检失灵 severe、重启通知),传输层留给 1764 重设计,本单不动它 —— 除非审计证明某段传输已无任何活客户(那就是死代码,删)。

## 5. 不做什么(scope 红线)

- ❌ 不建任何新告警路由/新通道(FLY-1764 的活)
- ❌ 不动 mailbox/投递循环/死信闸的任何投递逻辑(D/E 单已交付的资产)
- ❌ 不做 F(task 表)/ G(stop hook)(批次 3)
- ❌ 不碰 legacy push 旁门(founder 定了单独讨论,明确不在本单)
- ❌ 不加 feature flag(founder 2026-07-24 直令,FLY-1570 同款纪律;物理删除,回滚 = revert PR)
- ❌ 不动 schema、不删数据(孤儿表「删代码不删数据」,与 FLY-1570 同款)

## 6. 验收的今日化(原文三条 → 可执行)

1. `grep -ri watchdog packages/teamlead/src` 零命中(fixture 除外)—— 含改名项;每个改名在 PR body「保留行为清单」逐条声明
2. Bridge 全量测试绿、能起、跑一晚零 auto-page/零追讨消息 —— 复用 FLY-1570 的验收 4 形态(claims.db + lead_events + Discord 三处取证)
3. 删除清单逐条列 PR body;**FLY-1503 已 Canceled(v2 整体退役后镜像反转)**,「互相核对」执行为:对照 FLY-1503 原文枚举的家族清单逐条标注 已删(FLY-1570)/ 本单删 / 不存在,不因它 Canceled 而跳过核对
4. (新增,对齐 issue 风险节)ship 前置:`FLYWHEEL_MAILBOX_QUEUE=1` 已在生产翻开并稳定 —— 撕最后一层保护之前信箱必须真在岗

## 7. 待研究问题(research.md 逐条回答)

- Q1: RunnerIdleWatchdog 三个职能(收尸/idle/额度登录)各自的消费者是谁?删了谁瞎?
- Q2: LeadWatchdog 10-min tick 上挂着哪些对账 rider?挪去哪(GatePoller / patrol-tick)?
- Q3: HeartbeatService 是谁的地基?session_monitoring_* 事件链断了会怎样?
- Q4: `inbox_loop_stalled`(48h 109 条)现在的发射器是谁?
- Q5: `zombie_session_backlog` 发射器 + zombie-gate-hygiene 是检测器还是对账器?
- Q6: LeadAlertNotifier / AlertChannelHub / claims.db 还有哪些非-watchdog 活客户?
- Q7: LeadHealthProbe(Codex Lead)删了之后 Codex Lead 崩溃靠什么发现?(launchd KeepAlive?)
- Q8: account-switch-watchdog 在 quota daemon 固化后还是活路吗?
- Q9: `/health` watchdogs manifest + bridge-liveness-probe.sh 的消费方有哪些?契约怎么收?
- Q10: grep 91 个命中文件的完整分层(模块本体/接线/顺带提及/测试/fixture)
