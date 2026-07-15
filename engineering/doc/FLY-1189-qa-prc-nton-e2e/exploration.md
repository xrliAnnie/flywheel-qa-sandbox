# FLY-1189 QA·FLY-1048 PR-C 529 Room 真机 N-to-N E2E — 探索

Issue: FLY-1189 (https://linear.app/geoforge3d/issue/FLY-1189/qa-fly-1048-pr-c-529-room-真机-n-to-n-e2e统一升级流-bi-4-抑制)
日期: 2026-07-11
基于: 无(本 issue 首篇;上游事实 = FLY-1048 文件夹 plan.md/qa-report.md + PR #556)

## 1. 为什么有这张单(问题定义)

Annie 追问「真的做了 QA 的 N-to-N 测试吗?」→ 查证结论:**没有**。

- `engineering/doc/FLY-1048-watchdog-detection-remaining/qa-report.md:16` 原文写明:PR #522 = 仅 PR-A,**不含 PR-C**;:25 写明 PR-C 需另起 pipeline。
- PR #556(PR-C)diff 里**没有任何 QA 报告、没有任何真机 E2E 脚本**(docs 只动了 progress.md)——已核 PR files 列表,属实。
- PR-A 那份 §7 真机补测也只是 **module-driven 进程内 harness + 单 bot 单隔离频道**,不是真 Bridge + 真 Lead + 真 runner,更不是 N-to-N。

PR-C 是**通知/路由类**(统一升级流),按 Annie 的既定标准(FLY-605/612/613 先例 + memory 铁律「检测/relay/通知类 QA 默认含真机段」),必须真 Discord N-to-N E2E 才能放行。Tadashi 已撤回错递的 ship gate,本单 = 独立于实现者的补测。

## 2. 被测对象(已核事实)

**PR #556 @ head 98c2108c**(branch flywheel-FLY-1048-pr-c,base=main,OPEN,MERGEABLE)。
PR-A(#522)与 PR-B(#525)已 merge 进 main,故 PR-C 的 dist = 三层完整叠加——正好满足 FLY-1048 plan D1「QA 覆盖三 PR 整体」。

PR-C 交付面(读代码确认,非转述):

| 组件 | 行为 |
|---|---|
| StateStore detection_escalations 耐久表 | episode key = (target_key, kind, episode_fingerprint);状态机 NEW→LEAD_NOTIFIED→ACKED/RESOLVED/ESCALATED/CLEARING;跨重启存活 |
| detection-detector-wiring(C4) | 三源入流:A6 gap 扫描(漏① runner_parked_unreported / 漏② lead_ask_unanswered / delivery_unconsumed)+ A7/B3 case-c(detection_stuck_confirmed)+ FN4(delivery_failed_reconcile);全部 runner-keyed |
| detection-escalation C2 Lead 腿 | issue 自己的 [FLY-XX] chat thread 安静帖(无 mention)+ owner Lead inbox(appendLeadEvent + runtime.deliver,GUARDRAIL 重投);owner = resolveLeadForIssue(dept label 路由) |
| detection-escalation C3 reconcile | GatePoller piggyback tick;LEAD_NOTIFIED 超 grace(默认 30min,global env FLYWHEEL_DETECTION_LEAD_GRACE_MS + per-project detection.lead_grace_ms)无 ACK → founder page |
| detection-escalation-sinks founder pager | @founder(config.discordOwnerUserId)发进该 episode 的 issue thread;founder_page_ledger 永久防重;只有确证 posted 才标 ESCALATED;无 thread/POST 失败 → 行留 LEAD_NOTIFIED 下轮重试 + onUndeliverable 兜底 |
| fleet guard | 同 kind 活跃 episode ≥ FLYWHEEL_DETECTION_FLEET_THRESHOLD(默认 4)→ 单条 detection_fleet_aggregate 走 915 alert 通道,不页 founder、不刷 Lead |
| C4a 新旧互斥 | env 开启时 case-c 由统一流独家通知,旧 stuck-runner-detector emit 前查活跃行跳过;ACK 双向镜像 |
| C5 BI-4 抑制 | CLEARING 态对该 target 全检测类静音;TTL(FLYWHEEL_CLEARING_TTL_MS 默认 2h)超时回 NEW 可再报;ESCALATED 永不 re-alert |

关键 flag(已核 registry diff):PR-A 3 个(FLYWHEEL_DETECTION_GAP_SCAN / FLYWHEEL_PANE_MULTIFRAME / FLYWHEEL_STUCK_ERRORSIG)+ PR-B 1 个(FLYWHEEL_WATCHDOG_JUDGE)+ PR-C 1 个(FLYWHEEL_DETECTION_ESCALATION),共 5 个注册 flag;issue 说的「6 个 flag 全开」按实际 registry 为准(另有数值 tuning knob 若干:FLYWHEEL_GAP_*、FLYWHEEL_FRAME_*、FLYWHEEL_DETECTION_LEAD_GRACE_MS、FLYWHEEL_DETECTION_FLEET_THRESHOLD、FLYWHEEL_CLEARING_TTL_MS)。全部未设 = 字节兼容现状。

**范围诚实(写进验收)**:统一升级流的 founder-page 只对 **runner-keyed** episode(createSessionTargetResolver 对 lead-keyed 返回 null → no_target)。Lead 侧 pane_error_stalled 走 PR-A 的 LeadAlertNotifier 告警面,PR-A 已有真机证据。所以 E4 的 N-to-N = **N 个卡死 runner × N 个 owner-Lead**,Lead 侧只做一条交叉对照。

## 3. 现有 QA 基建盘点(529 Room)

- 4 slot(`~/.flywheel/test-slots.json`):独立 bot/频道/端口;alerts 镜像(#test-flywheel-alerts,FLYWHEEL_ALERT_QUEUE_DIR/_DEADLETTER_DIR/FLYWHEEL_CLAIMS_DB 全 SLOT_DIR 隔离)+ roundtable 镜像已建(FLY-529)。
- `scripts/test-deploy.sh`:部署隔离 Bridge + 真 test Lead(claude-lead.sh);**当前 FLYWHEEL_PROJECTS jq builder 每 slot 只生成单 Lead**(leads:[1],match.labels:["*"])——N-to-N 拓扑的硬缺口(见 §4 决策 1)。
- 真 runner 注入配方(memory FLY-631 实战):TEST_REPLY_BY_ISSUE=1 开 chat threads(founder page 依赖 getChatThreadByIssue,**必须开**)+ POST /api/runs/start 带 Bearer + BRIDGE_DEPT_SCOPE_REJECT 或 *-Test label 路由;沙箱常备 issue FLY-202/124/136,FLY-145 带 Product-Test label。
- escalation 类真机配方先例(FLY-695/605):秒级 env 计时 + 真 wall-clock;真 Discord POST 后 GET 读回为权威证据(Chrome 不在时 API-authoritative,Tadashi 接受过)。
- 三段式 QA 先例:FLY-793(全链三 bug)、FLY-535/536(529 Room 真机)。

## 4. 关键设计决策(带备选与理由)

### 决策 1:N-to-N 拓扑 = 单 Bridge 多 Lead(不是多个 slot Bridge)

- **A(选定)**:一个 slot Bridge,FLYWHEEL_PROJECTS 配 ≥2 个 Lead(不同 dept label、不同 chatChannel、不同 botTokenEnv,复用 slot2/slot3 的频道和 bot),起 2 个真 test Lead 进程。需要给 test-deploy.sh 加**加性** multi-lead 能力(flag 未设 = 现状逐字,529 惯例)。
- B:两个独立 slot Bridge 各一个 Lead —— **架构上错**:owner 路由(resolveLeadForIssue)和跨 target 抑制(同一 detection_escalations 表)都发生在**一个** Bridge 进程内;两个 Bridge 各管各的,根本测不到「不串台」。
- C:不动 test-deploy.sh,手工拼 env 起 Bridge —— 重复造轮子,丢掉 529 的隔离保证(SLOT_DIR、生产零触碰 snapshot),不取。

理由:生产就是一个 Bridge 多 Lead;E4 的「路由到对的 owner-Lead」只有在单 Bridge 多 Lead 下才是真命题。

### 决策 2:「真卡死」的注入方式(不接受合成 pane 字符串)

原则:**注入的是真实故障,不是伪造的观测**。四类:

| 目标状态 | 注入 | 真实性论证 |
|---|---|---|
| case-c 冻结(零进展) | 对真 runner 的 claude 进程 SIGSTOP | 进程真挂起,pane 内容 = 真 claude 输出后真停;从检测层视角与真死锁不可区分 |
| error-stalled(FN1 同源) | 移走真 runner 的 worktree 目录 → 真 ENOENT 循环 | 复刻 FLY-910 真事故成因;错误由真命令真产生 |
| 漏① parked-unreported | 沙箱 issue 指令驱动真 runner 真执行 park、不上报 Lead | runner 是真 claude 会话,CommDB 里的 declared park 行是真的 |
| 漏② ask-unanswered | 真 runner 真跑 flywheel-comm ask,无人应答 | CommDB pending question 行是真的,超龄是真 wall-clock |

阴性对照(R1/FP 组)同样真:一个真在干活的 runner(不告警)+ 一个 park 且已正常上报的 runner(静默)。

### 决策 3:计时 = 缩短 env 跑主矩阵 + 一条 30min 默认真等待

grace/TTL/gap 阈值全部 env 可调(FLY-695 判例:真 wall-clock,不 mock clock)。主矩阵 grace 缩到 ~3min;**另设一条场景用默认 30min 真等**(先启动让它煮着,其余场景并行推进,+30min 收 founder page 证据)——堵住「你没真等过 30min」的质疑,且不多花墙钟。

### 决策 4:judge(PR-B)真开

「flag 全开」= 生产形态,FLYWHEEL_WATCHDOG_JUDGE=1 真调 codex。注入设计成**高置信机械 C 信号**(错误签名 + 空 prompt / 重复签名)——按 B3 合同这类不进 judge、judge 也无权降级,保 C-不漏的确定性;judge 的不确定路径观察记录即可,不作硬断言。

### 决策 5:三段式内的分工

- **Implement 阶段**(本 branch):建 harness——test-deploy.sh multi-lead 加性扩展 + 场景驱动脚本 + 故障注入器 + 自身 smoke;不判 PR-C 的 PASS/FAIL。
- **QA 阶段**(独立 session):在 529 Room 真机执行全矩阵、收证据(真 Discord 消息链接 + 检测日志锚点 + 生产零污染 snapshot)、出 qa-report.md 与 verdict;FAIL → kickback 给 PR-C 实现者(不是本单实现者)。

### 决策 6:founder page 的 @mention 用真 DISCORD_OWNER_USER_ID

证据靠 API GET 读回 mentions[].id == owner(FLY-605 判例)。代价 = Annie 会在 QA guild 收到少量真 @(每 episode 恰一次,量级 ~3-5 条)——这正是「不重复轰炸」的直接证据,提前在 gate 里知会 Tadashi。

## 5. 验收判据映射(issue E1-E5 → 场景)

| 判据 | 场景 |
|---|---|
| E1 检测真触发(三态 C 不漏) | SIGSTOP 冻结 + ENOENT 循环 → detection_stuck_confirmed;阴性对照不触发 |
| E2 统一升级流走完 | Lead 腿(thread 帖 + Lead inbox)→ 无 ACK 超 grace → founder page(真 @,thread 消息链接);含一条 30min 默认真等 |
| E3 BI-4 抑制 | 同 episode 跨多个 reconcile tick 只通知一次;CLEARING 静音;TTL 回弹再报;ESCALATED 永不再报——全真机复现 |
| E4 N-to-N(核心) | 2 Lead × 2 并发卡死 runner(+2 阴性对照):路由不串台(各自 thread/频道/bot)、抑制跨 target 隔离(A 的抑制不吞 B)、founder 每 episode 恰一页;fleet guard 单独场景(threshold 调 2)验聚合不轰炸 |
| E5 零生产影响 | 生产 alert-queue/deadletter/claims.db/comm.db/teamlead.db 前后 snapshot 零新增;全程只碰 SLOT_DIR + 测试频道 |

## 6. 风险 / 未决

- **529 Room 档期**:room 有其他 QA 在排(FLY-535/827)。执行期由 Tadashi 调度,设计不受影响。
- test-deploy.sh multi-lead 扩展是生产仓 QA 脚本改动 → implement 阶段照 529 惯例做字节兼容 + Codex code review。
- ~~ACK 路(Lead 真 ACK → 不页 founder)需要真 Lead 执行 disposition 端点~~ → **plan §D 场景 S6 已纳入**(P0,真 Lead 真 ACK)。
- 若真机发现 PR-C 缺陷 → FAIL + kickback,本单不代修(QA 独立性红线)。
