# FLY-1570 拆 watchdog 全家 — 独立 QA 报告

Issue: FLY-1570 (https://linear.app/geoforge3d/issue/FLY-1570/消息层重构-a-批次1-拆-watchdog-全家)
日期: 2026-08-04
基于: plan.md

**判定:PASS** · 验证 head `d0453aa0`(提交裁决前重新 fetch 核对,未漂移)
**PR**: https://github.com/xrliAnnie/flywheel/pull/771
**Ship 报告(已 delivered=true)**: https://fw-reports-a53de2.vercel.app/r/1a1385de455ff47cfdfc00f44f95bacd/

529 房部署的是 `750181bf`,与 PR head 的唯一差异是 QA 自己的 `progress.md`;
`git diff d0453aa0 750181bf -- packages scripts` 为空,即代码逐字一致。

---

## 1. 验收标准逐条结论(issue 5 条 + plan §5.6 QA 硬性要求)

| # | 验收项 | 结论 | 关键证据 |
|---|---|---|---|
| 1 | 全仓残留扫描无死引用 | PASS | 三层扫描;例外仅 `truth.ts` RETIRED_FLAGS、CLAUDE.md 叙述行、本 PR 新增守卫测试自身 |
| 2 | build + 全量测试 | PASS | `pnpm -r build` exit 0;`pnpm lint` 0 error;**分支独有失败全部有 main 对照组证伪** |
| 3 | Bridge 起得来 + 健康面 | PASS(生产 fleet 12/12 属 ship 节点) | 529 房真启 1 次 + 真重启 1 次;`/health` w1/w2/w3/w4 全绿;probe 契约 20/20 |
| 4 | 真机一轮零追命告警 | PASS | 真 Runner 46 分钟(40 分钟卡门),追命 kind 计数 **0**;生产阳性对照同窗 +4 行 |
| 5 | 保留清单逐项点名 | PASS | 见 §5 |
| 6a | 529 真机 E2E(真组件) | PASS | 真 Bridge + 2 真 Lead + 1 真 Runner(跨 Lead 路由 = 真 N-to-N) |
| 6b | 真 Discord 腿(真送达 + 读取确认) | PASS | 2 条告警真发真读回 + Claude-in-Chrome founder 视角确认 |
| 6c | 结论绑定精确 head + 前后对照数字 | PASS | 见 §4 |
| 6d | 涉及重启的验收必须真实重启 | PASS | 记账 bypass(Lead 批准,限 19871)真进程重启 |

---

## 2. 静态门

- `pnpm -r build` → exit 0
- `pnpm lint` → exit 0(13 warning,0 error)
- **残留扫描(plan §5.1 三层)**
  - a) 模块/符号层:3 个文件命中 —— `packages/config/src/feature-flags/truth.ts:298`(RETIRED_FLAGS,白名单)、`CLAUDE.md:111,150`(叙述性里程碑,白名单)、`packages/teamlead/src/bridge/__tests__/fly1570-watchdog-teardown.test.ts`(**本 PR 新增的守卫测试**,断言这些文件不存在 —— 是执法机制本身,非残留)
  - b) kind 层:全部落在 display / runtime-compat 白名单(KIND_CONTRACTS 穷尽 Record、TICKET_KINDS / ticket-owner-map / INFORMATIONAL_KINDS / ISSUE_PROGRESS_KINDS / NO_OWNER_KINDS 的 legacy 条目、titleFor/bodyFor/历史行 parser)
  - c) env 层:被删 env 名仅出现在 RETIRED_FLAGS(40 条 tagged FLY-1570)
- 23 个应删模块文件逐个 `find` 确认不存在
- contract delta 核对:`pane_hash_stuck` / `runner_stuck_unhandled` / `runner_throttle_stalled` 三条已由 `arc:"auto"` 降为 `human_by_design` 且 remediationRef 已删;`pane_error_stalled` / `workflow_route_input_rejected` / `runner_lead_pending_unhandled` / `inbox_loop_stalled` 保持原值(plan §3.11 R5 要求)
- AutoRepairBot dispatch 中三个真 auto kind 的 handler 已删

---

## 3. 测试门 —— 零回归可归因本改动(每条都有 main 对照组)

基线 = `main` @ `05e7b451`,在**同一台机器**用独立 worktree 全量构建后跑。

| package | main(基线) | branch(候选) | 结论 |
|---|---|---|---|
| teamlead | 33 失败文件 / 78 失败用例 | **30** 失败文件 / 79 失败用例 | 候选失败文件更少 |
| config | 4 / 7 | 4 / 7 | 同 |
| flywheel-comm | 3 / 3 | 3 / 4 | 同族 |
| claude-runner | 4 / 19 | 4 / 12 | 同族(负载相关) |

**「分支独有失败」逐条查清(这是本次 QA 的核心纪律)**

| 文件 | 表象 | 对照组做法 | 结论 |
|---|---|---|---|
| `AlertChannelHub.contract-escalate.test.ts` | legacy-copy pin 期望 `🙋 Annie` 实得 `🙋 <@1138…>` | 同一测试跑 main | **main 逐字同错** → 宿主 `DISCORD_OWNER_USER_ID` 环境污染,既有 |
| `fly1502-fix-regressions.test.ts` (v2-cutover) | 5000ms 超时 | 交替配对跑 8 次(branch/main 各 4) | 1749/2466/1790/1944 vs 1756/2799/1894/1849 ms,**无差异、0 失败**;且 PR 未触及该包及其依赖链(diff 为空) → 高负载超时 |
| `rules-bundle-truth.test.ts` | 1 失败 | 两边重跑 | **两边 25/25** → 负载 flake |
| `fly1503-host-gaps.test.ts` / `runner-injection.test.ts` (v2-host) | 12+2 全失败 | 基线补跑该包 | **main 逐字同错**(`listen EINVAL` = QA Runner 自身 TMPDIR 过长撞 unix socket sun_path 上限) |
| `host-cli-e2e.test.ts` (v2-cli) | 3 失败 | 同上 | 同 |

**阳性对照(证明尺子有效)**:把 TMPDIR 换成 `/tmp/fw1570` 后,v2-host **两边各 82/82**、v2-cli **两边各 43/43** 全绿。

---

## 4. 529 隔离房真机 E2E

拓扑:slot-1,候选 head 真 Bridge(19871)+ 两个真 Lead(`flywheel-test-1` / `flywheel-test-2`)+ 一个真 Runner(FLY-138)。
Runner 被**正确路由到第二个 Lead**(CommDB 登记行 `lead_id=flywheel-test-2`)= 真 N-to-N。

### 4.1 零追命告警(验收 4)

Runner 生命周期 11:17 → 12:08(46 分钟),其中 **11:21:46 起卡在 brainstorm 门上 40 分钟** —— 正是被删机制最爱追命的场景(receipt T1 90s / T2 5min / T3 12min、lead-pending 20min 宽限)。

| 读数 | 结果 |
|---|---|
| slot `lead_events` 追命 kind 计数 | **0** |
| slot `detection_escalations` | **0** |
| slot bridge.log 追命 kind 字符串 | 15 个关键词全 **0** |
| isolated `alert_claims` | 只有保留 kind(`three_stage_stuck` / `rate_limit` / `rules_bundle_legacy` / `bin_integrity_drift` / `founder_reply_unreachable_runner`) |

**修前/修后对照(阳性对照,证明「零」不是因为没事发生)**:同一时间窗生产库(跑 main 代码)`detection_escalations` 由 **14527 → 14531**,`max(rowid)` 持续增长 —— 被删的写入方在 main 上确实活着,在候选上确实死了。

生产存量基线(ship 前置,见 §7):`receipt_unprocessed` LEAD_NOTIFIED 2058 + ESCALATED 22、`wake_failed` ESCALATED 1、退休 kind 未结 alert_threads 17、`codex_nudge_*` pending **0**。

### 4.2 复活项正面注入(唯一声明的 0→1)

- 11:37:55 删掉活会话 `0da6da4f`(FLY-138,status=running)的 CommDB 登记行 = FLY-1049 Z2 形态
- 11:39:50 真 Bridge 发出 `founder_reply_unreachable_runner`,attribution 正确(issue FLY-138 / gate `1699d867`)
- 恢复登记行后行为收敛
- **门的对照**:main 上 `watchdogOn = this.legacyWatchdogsEnabled() && …`,而 `legacyWatchdogsEnabled()` 是 FLY-1393 墓碑硬 return false → 该检测器在 main 上是**死的**;候选上门只剩 `FLYWHEEL_FOUNDER_REPLY_WATCHDOG !== "0"`(默认开)

### 4.3 退休 kind 重启重放(两组读数并列,按 Lead 要求)

种入 5 行(各带真 Discord thread):`pane_hash_stuck`(NULL)、`pane_error_stalled`(NULL)、`runner_stuck_unhandled`(ticketed NEW,first_seen 2020)、`inbox_loop_stalled`(NULL)、`runner_login_expired`(保留项特例)。

**(a) fresh-process 等价路径**(真 slot DB + 真 Discord,候选 dist vs main dist 同脚本):

| 行 | 候选(本 PR) | main 对照 |
|---|---|---|
| `pane_hash_stuck` (NULL) | **原地不动**,`capturePane` 一次没调 | **被 auto-resolve + 归档** |
| `pane_error_stalled` (NULL) | 原地不动 | 被 auto-resolve + 归档 |
| `inbox_loop_stalled` (NULL) | 原地不动 | 存活(唯一存活的) |
| `runner_stuck_unhandled` (NEW) | **→ ESCALATED**,真发 T2「修不掉(T2:重试 0 次 / 超时)」 | **被 auto-resolve**,票据从没走到 T2 |
| `runner_login_expired`(保留) | **captureRunner 调用 → 自愈 resolve + 归档 + 恢复消息** | 同(保留项两边一致) |

候选 `capturePane calls: []` 是关键差分 —— 正是 plan §3.11 R4 预警的「留条目删分支会误 resolve」被成对删除后的正确形态。

**(b) 真进程重启**(Lead 批准的记账 `FLYWHEEL_RESTART_GUARD_BYPASS`,硬限 19871):

- 旧 Bridge PID 11571 停止 → 新 PID 16499 启动,`/health ok`,14s ready
- 保留组件全部重新挂上(见 §5)
- **活着的 Runner 经 `session_monitoring_reestablished` 被重新收养**,`status=running` 未被误判失败(FLY-172 对账保留有效)
- 三条 NULL 行**跨重启仍原地不动**(无 boot-time 追命重放)
- ticketed 行在**重启后第二个 tick(12:03:24)真升级为 ESCALATED** 并真发进隔离频道

### 4.4 真 Discord 腿

- 保留链 `rate_limit` 经真实发送链路发进隔离频道,消息 id `1534160183192715384`,读回确认(author `flywheel-test-1`、channel `1519421055805165842`、时间戳、正文)
- 复活项 `founder_reply_unreachable_runner` 同上,消息 id `1534164152736678021`
- **Claude-in-Chrome 在 founder 真会话上做视觉确认**:一屏同时看到 S3 线程的 T2「修不掉」消息、S5 线程的 `runner_login_expired 已恢复`、以及 S1/S2/S4 三个退休 kind 线程的「There are no messages in this thread yet」
- 频道位于 `QA Testing` 分类下的 `#test-flywheel-alerts`,**生产频道零污染**

### 4.5 隔离核实

- 生产 `delivery-secret` sha 前后逐字一致(`a5ff7615aa3544b58deb1192caade2796e7b1d54`,mtime 未变)
- 生产 Bridge 全程存活(21 sessions / 16 Leads),未被触碰
- slot 的 alert queue / deadletter / claims.db 全部隔离在 slot 目录
- 收尾:slot-1 已 teardown(19871 释放、worktree 清理、extra Lead supervisor 0 进程);slot-3 是他人在用的房间,未触碰

---

## 5. 保留清单逐项点名

| 保留项 | 证据 | 结论 |
|---|---|---|
| Bridge 主循环自杀 watchdog | **沙箱真跑**:候选 dist 的 `BridgeEventLoopWatchdog` 在真实主循环阻塞下自杀,进程 **exit 137 = SIGKILL** | PASS |
| RunnerIdleWatchdog 进程存活 | 11:18:35 真发 `runner_idle_detected`;`/health` w1 `freshness=fresh` | PASS |
| LeadWatchdog 10 分钟 tick | boot 日志 `LeadWatchdog started (600000ms …, recognized blocked conditions only)`;w4 两次 `fresh`(11:32:40、11:58:24、12:03:24) | PASS |
| W-4 blocked 全链 | 同上,`wired=true effective_enabled=true` | PASS |
| W-2 delivery loop 契约 | `wired=true` / `effective_enabled=true` / `switch="required"` / 顶层无 `not_started` / freshness 只由 `leads[]` 决定;`bridge-liveness-probe` 契约测试 **20/20**;活 manifest 满足探针全部 jq 断言 | PASS |
| 各 reaper | boot 即见 `terminal-reaper`、`viewer-session-reaper`;`crash-reaper` / `chrome-session-reaper` / `mcp-descendant-reaper` 代码在位(触发型,本窗未触发) | PASS |
| 状态收敛对账 | `commdb-fsm-reconcile`、`FLY-1066 CommDB residue`、`done-thread-reconcile`、`lease audit outbox`、fleet sensors、account-switch watchdog 均搭在保留的 `onPollComplete` 上并观测到执行 | PASS |
| unreachable-runner(复活) | §4.2 正面注入真发 | PASS |
| founder reply 投递红线 | `FLYWHEEL_FOUNDER_REPLY_DELIVER` 及分支保留(`gate-poller.ts:2221`),registry `founder_reply_deliver` 保留含 live-observe 测试引用;`founder_reply_watchdog` flag 保留为 default_on 且 retiring 标记已去 | PASS |
| zombie gate hygiene | `runZombieGateHygiene` 保留;resolve 由 main 的 `env FLYWHEEL_ZOMBIE_GATE_RESOLVE="0"` 改为显式 `resolveDeadGates: false` —— 语义等价,无新 0→1;无其它生产调用方 | PASS |
| `/health` manifest 消费方 | `w4_runner_blocked` 行随其唯一驱动者(stuck detector)一并移除;`retiring` 数组移除 —— 外部探针 `bridge-liveness-probe.sh:132` 用 `(.watchdogs.retiring // [])` 兜底,契约不破 | PASS |

---

## 6. 顺带发现的 529 房既有缺陷(与本 PR 无关,建议单独开单)

1. **生产 `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 泄漏进隔离 Bridge** —— `~/.flywheel/.env` 里的 `FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN`(FLY-927 单一发送身份)被 `test-deploy.sh` 的 shell 继承进 slot Bridge,而该生产 bot 对 `#test-flywheel-alerts` 无权限 → **房内所有 Bridge 侧告警一律 `discord-403` 死信**。本次用受支持的同名 knob 指向 `TEST_BOT_TOKEN_1` 绕过,但房间默认状态下测不了告警送达。
2. **`qa-fly-529-alert-smoke.sh` 会自己 deploy 同一 slot** —— 撞上已占用槽位后立刻触发 teardown,而 teardown 又卡在 cmux mutator lease 60s 超时(FLY-1482 正在修的那条)。所幸本次 teardown 未执行任何动作,我的房间未受损。
3. `#test-flywheel-alerts` 仅 slot-1 的 bot 有 View/Send 权限,slot-2/3/4 的 bot 均 403 —— 用 `--alerts` 时主 Lead 必须是 slot 1。

---

## 7. 诚实边界(未测什么、为什么、风险、何时补)

| 项 | 为什么没做 | 风险 | 补测计划 |
|---|---|---|---|
| 生产 Bridge 重启 + fleet 12/12 | **权限边界**:这要求把未合入代码部署到生产,属 ship 动作,不在 QA 节点授权内 | 低 —— 风险是「生产特有配置导致起不来」;候选在隔离房真启 1 次 + 真重启 1 次均健康 | ship 窗按既有部署流程执行并在 `/health` 核 12/12 |
| 收据类记录 24h 长窗观察(plan §5.4) | 时间跨度超出本次 QA 窗口 | 低 —— 结构性替代证据:代码内已无任何写入方(全仓扫描零命中)、隔离房 46 分钟零新增、同窗生产旧代码仍在增长 | ship 后按 plan 三指标(first_detected / COUNT 斜率 / rowid)跨两个回放周期确认 |
| **ship 前置(plan §3.11 自带,非本 PR 缺陷)** | — | 生产现存 **2081** 条未结 `receipt_unprocessed`/`wake_failed` + **17** 条未结退休 kind alert_threads | plan 要求停旧 Bridge 后复查,非零则**先人工收敛再起新版本**;`codex_nudge_*` pending 已核为 **0** |

---

## 8. 提交说明

裁决提交时撞 `credential_expired`(凭据软窗 1 小时,而本单验收合同实跑约 65 分钟 —— 结构性互斥,非拖延)。
诊断为纯超窗:`workflow_run_node` node_id=qa attempt=1 state=running、credential id=98 `consumed_at` 空 / `revoked=0` / absolute deadline 至 2026-08-05T10:58Z、`workflow_claims` 我名下零行。
处置按既有分诊表:**绝不 `env -u`**(真 DAG 节点),verdict 原文冻进文件保证重试 payload 逐字一致,请 Lead 延 `expires_at` 后由后台 poll-and-submit 在窗口一有效时立即提交。
