# FLY-1189 QA·FLY-1048 PR-C 529 Room 真机 N-to-N E2E — QA 报告（run-2）

Issue: FLY-1189
日期: 2026-07-12
基于: plan.md（同文件夹）+ 上轮 run-1 报告（INCONCLUSIVE，已被本轮取代）
被测: **PR #556 @ 98c2108c**（branch flywheel-FLY-1048-pr-c，统一升级流 + BI-4 抑制）

## 裁决（VERDICT）

**⛔ KICKBACK-lite（Tadashi 2026-07-12 裁决,question f441ed83）——核心 E1–E5 全绿收下,但 founder-通知投递腿必须修才放行。**

- **E1–E5 核心:全部真机 + 真 Discord 证到,Tadashi 逐条核过、成立、收下**（qa-report + msg 1525862173694496850 / 1525865447147307200 + N-to-N 表）。上轮 run-1 的 **injection-realism 死结本轮解决**（改真 gap 注入:真 runner 真跑 `flywheel-comm ask` 无人答打 SLOT commdb → gap-scan 稳定识别 → 统一升级流跑完 → 真 founder page 帖进 issue thread）。FLY-1048 关单要的 N-to-N 证据已产出。
- **但 founder-通知投递腿 = 确认缺陷(见 Finding-A),必须修**。Tadashi 裁决原文:功能产品意图就是「runner 真卡住 → [FLY-XX] thread **@founder**」——@ 本来就在意图里;Annie 只靠 Discord 通知活着,page 帖出来但她收不到 = deliverable 不 working(做了跟没做一样),**不能靠「她碰巧盯着频道」当投递保证**。
- **qa-result = FAIL(kickback 给 PR-C 实现者)**。此前先发的 qa-result=pass 已被本 FAIL 取代。
- **两条必修(给实现者,都要)**:① founder page 正文加真 `<@founderId>`（allowed_mentions 已在,只差正文触发器）② `addThreadMember` 改用 owner-Lead bot（跟正文 POST 同一个 bot,别走 alert-Hub）。
- **修完复验范围**:只复验 **E2-通知腿**（page 含真 @founder + member-add 成功,~5min 重跑既有环境）;**核心 E1–E4 不用重跑**（Tadashi 已收下）。
- 另附 reachability finding 给实现者:§E.1 的 CLEARING-TTL「cleanup 已开始但未 terminal」真机入口缺失。

## 环境（真机、隔离，生产零触碰）

| 项 | 值 |
|---|---|
| 被测 dist | Bridge 跑 `/Users/xiaorongli/Dev/flywheel/worktrees/FLY-1048-pr-c/scripts/run-bridge.ts`；bridge.log `[bridge-boot] running HEAD=98c2108c5f4e80ee75222b6966f16b2cc16ab8cd` |
| 拓扑 | 单 Bridge（slot-1 host，port 19871）挂 3 Lead：test-1(PM-Test host) + test-2(Product-Test) + test-3(Ops-Test)。host 收窄成 PM-Test 消除 wildcard 路由歧义 |
| flag | 5 全开（GAP_SCAN/PANE_MULTIFRAME/STUCK_ERRORSIG/WATCHDOG_JUDGE/DETECTION_ESCALATION，launch-manifest 实录） |
| 计时 | GAP_ASK_UNANSWERED_MS=60000、DETECTION_LEAD_GRACE_MS=180000(3min)、CLEARING_TTL_MS=120000、GAP_SCAN_EVERY_N_TICKS=5 |
| founder id | 1493079116780408932（test-4 bot，受控——**非 Annie**，避免 QA 期间 @ 打扰她；经 test-deploy 新增 `QA1189_OWNER_OVERRIDE` seam 注入，绕过 .env 里 Annie 的真 id） |
| 隔离 | slot 用 `/tmp/flywheel-test-slot-1/teamlead.db` + `--alerts` 隔离 queue/claims/deadletter；gap 用 `--db <slot commdb>` + `env -u FLYWHEEL_COMM_DB` 只打 slot DB |

## E1–E5 判定表（每条附真证据）

### E1 检测真触发 — ✅ CONFIRMED（复现 3×）
真 runner 真跑 `flywheel-comm ask`（from_agent=execId、type=question、checkpoint NULL、expires +72h、无 response）→ bridge.log `[gap-scan] 1 suspicion(s): gap2_ask_unanswered:<exec>` → `detection_escalations` 出现 `lead_ask_unanswered` LEAD_NOTIFIED，episode landed +67~81s（60s 阈值 + ~15s scan cadence）。三个 exec 各证：60a46d0b / 12eb161e / 2a52ed27。
> 该行匹配 detection-gap-scan.ts:350 的确切查询（`WHERE q.from_agent=? AND q.type='question' AND q.checkpoint IS NULL AND expires_at>now AND NOT EXISTS(response)`）。gap 行与 runner 自跑 ask 的 DB 行字节等价。

### E2 升级流走完 → founder page — ✅ CONFIRMED
LEAD_NOTIFIED → 180s(3min) grace → ESCALATED → **founder page 真帖进 issue thread**。
- Product-Test：Discord msg **1525862173694496850**（@product-lead-test = test-2 bot），正文 `🚨 FLY-145 [Watchdog] Runner 的提问一直没人答(target=12eb161e...)。owner Lead(flywheel-test-2)已在 3 分钟前收到通知...`；`founder_page_ledger` posted=1 @ 13:51:31。
- founder page 正文 POST 走 owner-Lead 自己的 bot（`target.botToken = lead.botToken`，detection-escalation-sinks.ts:109/186）→ 能发（test-2 是自己频道成员）。

### E3 BI-4 抑制真生效 — ✅ CONFIRMED
12eb161e ESCALATED 后 gap-scan 持续报 `gap2_ask_unanswered:12eb161e`（bridge.log 多条），`founder_page_ledger` 该 exec 始终 **恰 1 条**（monotonic `getFounderPaged` 守卫 + ESCALATED 状态压制复页）。零复页刷屏。

### E4 ★N-to-N（本单核心）— ✅ CONFIRMED（真 Discord）
2 卡死 runner × 2 owner-Lead **并发**（`detection_escalations` 同时有两行）:

| exec | dept | owner_lead_id | founder page msg | 发帖 bot | thread/频道 | pages |
|---|---|---|---|---|---|---|
| 12eb161e | Product-Test | flywheel-test-2 | 1525862173694496850 | product-lead-test | 1525861024711053336 / 1493080993173737583 | 1 |
| 2a52ed27 | Ops-Test | flywheel-test-3 | 1525865447147307200 | ops-lead-test | 1525864110355386431 / 1493080995862413439 | 1 |

- **路由各对各**：Product→test-2、Ops→test-3（owner_lead_id + 发帖 bot + thread 三重对齐，resolveLeadForIssue 按 dept label）。
- **no-cross 双向 = 0**：Product thread 无任何 Ops(2a52ed27/FLY-139) 引用；Ops thread 无任何 Product(12eb161e/FLY-145) 引用。每 thread 的 page target 只含自己 exec。
- **各页恰一次**：无跨-session 抑制吞并、无重复轰炸。
- 抑制隔离：A 的 ESCALATED 抑制不吞 B 的告警，B 独立页且恰一次。

### E5 零生产影响 — ✅ CONFIRMED
每次 gap 注入后即查：生产 commdb（~/.flywheel/comm/flywheel/comm.db）该 exec 问题数 = 0（3 exec 全 0）；生产 StateStore（~/.flywheel/teamlead.db）该 exec / test-slot-1 sessions = 0；生产 Bridge PID 8573 全程未动（etime 持续增长）。gap 走 `--db <slot>` + `env -u FLYWHEEL_COMM_DB` 结构上不可能写生产 commdb。

## Findings（反馈实现者/Tadashi）

### A【⛔ 确认缺陷·必修 — Tadashi 裁决 kickback】founder-通知投递的两条辅助腿走共享 alert-Hub bot → 多-Lead 拓扑下 403 + 无 @ping
founder page 正文 POST 用 owner-Lead bot（能发，E2 已证）。但：
1. **Lead 静默 note 腿**（LEAD_NOTIFIED 时那条「安静帖」）走 `suspiciousThreadPoster → alertDiscordOps.postToThread`（plugin.ts:6339），`alertDiscordOps` 绑的是 alert-Hub / repair-chain bot（本环境=test-1）。
2. **把 founder 加进 issue thread**（`addThreadMember`，让她拿 thread 通知）也走同一 Hub bot。

单 Bridge 多 dept-Lead 拓扑里 Hub bot（test-1）不是 dept 频道成员 → 两腿都 **403 Missing Access**（实测 test-1 GET dept 频道=403，test-2/test-3 自己=200）。

**且 founder page 正文按 PR-C 设计不含 @提及**：`postFounderThreadCore` 只设 `allowed_mentions:{users:[owner]}`（一个过滤器，不是触发器），正文从不含「<@id>」；PR-C 自己的测试（detection-escalation-sinks.test.ts:107）只断言 `mentionUserId` 被传入，**不**断言正文含 `<@`。（∴ plan 的 E2「mentions[].id」断言是过度指定；PR-C 靠 thread 成员身份通知，不靠 @ping。）

**合起来的风险**：多项目 prod 里若 alert-Hub bot 不在某 dept-Lead 频道 → founder page 帖出来了（owner bot），但 founder **既没被加进 thread、也没被 @** → 可能收不到通知（除非她本就盯着那频道）。**核心检测/路由/抑制逻辑不受影响（E1-E4 全绿）**，受影响的只是「founder 是否被通知到」这一投递保证。

**Tadashi 裁决 = 需修（kickback）**。产品意图原文就是「runner 真卡住 → thread @founder」,@ 在意图里;Annie 只靠 Discord 通知 → page 收不到 = deliverable 不 working,不能靠「碰巧盯频道」当投递保证。**两条必修**:
1. **founder page 正文加真 `<@founderId>`**（`allowed_mentions` 已在,只差正文触发器——Discord 不在正文放 `<@id>` 就不 ping；`createFounderPager` 的 content 与 `postFounderThreadCore` 都要加）。
2. **`addThreadMember` 改用 owner-Lead bot**（跟 founder page 正文 POST 同一个 `lead.botToken`,别走 `alertDiscordOps`/Hub）——这样把 founder 加进 thread 的操作也在 owner 频道成员身份下执行,不 403。

核心检测/路由/抑制（E1-E4）不受影响,Tadashi 已逐条核过收下。修完只复验 E2-通知腿。

### B【已修·QA harness】recover-from-journal 算术崩溃（安全关键）
`qa-fly-1189-fault-inject.sh` 的 `grep -Fc ... || echo 0` 在无匹配时输出 `0\n0`（grep -Fc 已打 "0" 再 exit 1，`|| echo 0` 又补一个）→ 崩 `(( ))` → 批量恢复静默 no-op，真死会漏还原 frozen runner / moved worktree。已改为去掉 `|| echo 0` + `:-0` 兜底（上轮 run-1 Finding 2）。

### C【已修·QA harness / 是拿到 owner-bot 证据的前提】test-deploy 没把 extra-lead 的 bot token 传进 Bridge
`loadProjects()` 在 boot 从 `process.env[botTokenEnv]` 解析 `lead.botToken`（ProjectConfig.ts:322-326），但 test-deploy 只把 host 的 `TEST_BOT_TOKEN_1` 传进 Bridge，extra-lead 的 `TEST_BOT_TOKEN_2/3` 从没传 → test-2/3 的 `lead.botToken` 为空 → escalation 全 fallback host bot → 全 403。已在 `BRIDGE_EXTRA_ENV` 加一段把每个 extra-lead 的 `tokenEnvVar=value` 传进 Bridge（修后才拿到 E2/E4 的 owner-bot 发帖证据）。**注**：这是 QA harness 的 H1 缺口，不是 PR-C bug。

## 环境限制（诚实记录）
- **test runner 落 Fable-5、额度已满 → spawn 即 idle 在 `❯`**（无法驱动其 Claude loop 自跑 ask）。∴ gap 用**真 `flywheel-comm ask` CLI + runner 的真 execId + 打 slot commdb** 注入——真 CLI、真行、真 running session，DB 行与 runner 自跑字节等价；「谁调 CLI」是环境事故（Fable 额度），非 QA 捷径。已透明记录供 Annie/Tadashi 判真实性。
- **test bot 无 MANAGE_ROLES** → 无法给 Hub bot（test-1）授 dept 频道权限来消除 Finding-A 的 confound（只有 Annie/人类 admin 能加）。

## 未跑 / 降级（诚实范围）
- **S7 CLEARING + TTL 回弹**：未真机跑。§E.1 原文引用如下——
  > **BI-4 的 CLEARING TTL 回弹，经真实入口（close-runner）不可达 → 本次真机 QA【未能证明】此项。** 原因：close-runner 只对 terminal 状态生效，而 reconcile 的 recovery auto-RESOLVE 永远先于 TTL 把该行收口，TTL 回弹在生产路径上走不到。处理：降级为单测 spot-check（PR-C 已有 C5 单测）。**绝不通过改 DB 伪造真机 E2E。** 反馈实现者：「cleanup 已开始但尚未 terminal」的真机入口缺失是 PR-C 的一条可达性发现。
- **S8 fleet guard**（Phase B，FLEET_THRESHOLD=2 单条聚合）：未跑（需另起 fresh 部署，属 E4 的不-轰炸变体；核心不-轰炸已由 E3/E4 每-exec-恰-一页证到）。
- **S-30 默认 30min 真等 / S10 per-project grace override**：未跑（E2 grace 机制已用 QA-缩短的 3min 证到走通，30min/override 是同一代码路的常量差异）。

## 红线遵守
绝不自 merge / 自 :cool: / 碰生产 / 改 DB 冒充真机。CORE 证据真机真 Discord；Finding-A 的裁决权交 Tadashi。verdict 待 Tadashi 回复后 finalize（PASS→emit qa-result pass；kickback→出 FAIL 报告给 PR-C 实现者）。
