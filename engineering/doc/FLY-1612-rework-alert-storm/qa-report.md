# FLY-1612 rework 告警风暴收敛 — 独立 QA 报告

Issue: FLY-1612 (https://linear.app/geoforge3d/issue/FLY-1612/告警治理-workflow-rework-held-重试无去重无退避直发-issue-thread-同一句话对-founder)
日期: 2026-08-12
基于: plan.md

## 0. 结论

**PASS**。被测代码 = PR #818 head `62ce5009`（我的 worktree 在其之上只多出 progress/qa-report 文档提交，`git diff origin/flywheel-FLY-1612..HEAD` 的产品代码部分为空）。

判据不是「实现者的测试绿了」，而是三条独立取证：

1. **生产病灶我自己复核过**，而且在我做 QA 的这半小时里它还在烧。
2. **同一套 harness、同一个场景，只换代码版本**：main = 122 条告警 / 181 次 claim；本 PR = 1 条 / 1 次。harness 能造出风暴（阳性对照成立），所以「1 条」不是 harness 坏掉。
3. **7 种新告警形态全部真机投递进 FLY-529 隔离 Discord 房间**，founder 视角截图为证，生产告警面零污染。

## 1. 被测对象与 head 纪律

| 项 | 值 |
|---|---|
| PR | #818（draft）|
| origin/flywheel-FLY-1612 | `62ce5009479701c36837750dd3013478fb458a0a` |
| QA 开跑时 worktree HEAD | `62ce5009`（clean） |
| 编译产物 build-identity | 与 QA 期间 HEAD 一致（每次跑前重建 dist） |
| 对照组 | `origin/main` = `4f246f52`，用 `git archive` 抽出 `packages/teamlead` 单独编译，**不在共享 worktree 里 checkout** |

> head 漂移说明：`flywheel-comm progress` 会 path-limited 提交 `progress.md`，所以 QA 过程中本地 HEAD 前进过。**产品代码 diff 恒为空**，本报告的全部结论都对应 `62ce5009` 的产品代码。

## 2. 生产病灶：我自己的独立取证（不是复述 research）

实现者的 research 用的是 `~/.flywheel/teamlead.db` 的 `workflow_run_event`。我换了一条**投递侧**账本 —— `~/.flywheel/alerts/claims.db` 的 `alert_claims`（只读查询），数字对得上：

| request | 告警条数 | 窗口 (UTC) | 跨度 |
|---|---|---|---|
| `rework:73d4d2df…` | **1272** | 08-11 12:02:58 → 12:32:56 | 29 分钟 |
| `rework:4e82b04e…` | 1229 | 08-11 13:31:22 → 14:01:22 | 30 分钟 |
| `rework:9a5c291b…` | 1143 | 08-09 10:16:51 → 10:46:50 | 29 分钟 |
| `rework:5c1db659…` | 874 | 08-12 07:40:41 → 08:10:40 | 29 分钟 |
| **全库 `rework_stalled_alert:*` 合计** | **12,080** | — | — |

**病是活的**：就在我跑 QA 的时候（2026-08-12 20:31 → 21:01 UTC），生产上有一个 episode 正在烧，**365 条**。逐条 uid 里的 generation 段在 30 秒内从 826 走到 831 —— 每 tick 铸一个新键，正是本单要治的那个缺陷；21:01:14 的 `rework_stalled_hold` 收尾（60 分钟 hold 阈值）。近 24 小时 4 个 episode 共 2,068 条。

## 3. 主证据：同 harness、同场景、只换代码版本

harness（`qa-fly-1612-storm-harness.mjs`，我自己写的，不复用实现者的测试）驱动**真编译产物**：真 `StateStore` + 真 `WorkflowReworkCoordinator` + 真 `WorkflowEngineDispatcher`，虚拟时钟按生产 1 秒 tick 节奏跑，从真实的 `qa_fail → 引擎铸 rework request` 入口开始。告警计数取两处：`workflow_alert_outbox` 表 + 注入的真 `alertSink` 实际收到的投递。

压缩阈值跑（alert 60s / hold 180s，只为让窗口在几百 tick 内跑完；机制与生产逐字相同）：

| 场景 | main（对照） | 本 PR | 说明 |
|---|---|---|---|
| 僵尸激活 `state_not_revivable:completed` | **122 条告警 / 181 claim / 181 release**，delivery 终态 `held` + `hold_count=0` + `generation=181` | **1 条 / 1 claim / 0 release**，`needs_lead` + `hold_count=1` | main 终态与生产 FLY-1680 现场（`held / hold_count=0 / generation=2423`）**逐字段同形** |
| worktree 脏（FLY-1602 原型） | **122 条 / 181 claim** | **1 条 / 5 claim**（1/2/4/8 分钟退避后第 5 击） | — |
| pane-loss `persisted_target_missing` | **122 条 / 181 claim** | **1 条 / 5 claim** → 移交 FLY-1648 | — |
| 脏 worktree 在退避窗内被清干净 | **122 条**，且 run 已被 force-hold（注：这一格的 force-hold 是我压缩阈值造成的，生产 60 分钟阈值下不会这么早） | **0 条**，delivery 回到 `wake_delivered`，run 保持 `active` | founder 全程无感 |

main 侧跑 300 tick 要 22–44 秒墙钟，本 PR 侧 0.9–1.2 秒 —— 1 秒热循环消失这件事在墙钟上直接可见。

**生产默认阈值（30 / 60 分钟）、70 分钟虚拟窗口、4200 tick** 复跑本 PR：

| 场景 | 告警总数 | claim 数 | 终态 |
|---|---|---|---|
| 僵尸 | 1 | 1 | `needs_lead` / run `held` |
| worktree 脏 | 1 | 5 | `needs_lead` / run `held` |
| pane-loss | 2（移交 severe + FLY-1648 自身预算耗尽 severe） | 5 | `needs_lead` / run `held` |

计划承诺的「每 episode ≤4 条」成立，实测更紧。

## 4. 逐条验计划里最容易出事的那几处

### 4.1 pane-loss 移交那一刻的字段（Codex R2 #1 关心的点）

在告警落库的**那一个 tick**（第 900 tick = 15.0 分钟）抓快照，不是跑完再看：

```
holdCount: 0            ← 归零，FLY-1648 拿到完整 5 击预算
targetNodeState: pending ← reservation 没被 supersede（普通第 5 击会置 superseded）
deliveryState: held / runStatus: held / last_error: persisted_target_missing
告警: 恰 1 条 severe (rework_pane_loss_handoff)
```

跑完 1000 tick 后 `hold_count` 变成 2 —— 那是 FLY-1648 恢复机器接手后**自己**的预算在走，符合设计。

**诚实边界**：我的 fixture 在移交时没有已签发的 credential，所以我这一跑对「credential 未被 revoke」是**空断言**，证不了。我改为核实实现者的定向测试是否空过：`StateStore.workflow-rework.test.ts` 里对 `credential_hash='credential-pane-loss-handoff'` 断言 `revoked: 0`、`grant_started_at` 保留，并且有对照分支（`revoked: grantStarted ? 0 : 1`）和普通 needs_lead 路径断言 `revoked: 1`。**是真差分，不是空过。**

### 4.2 operator kill switch 是「可逆暂停」而不是终局

关掉 re-entry 370 秒、hold 阈值只有 180 秒的情况下跑：

- 整个暂停期 **恰 1 条 severe**（`rework_reentry_paused`），恢复时 **恰 1 条 warning**（`rework_reentry_resumed`）；
- 暂停期间 delivery 一直是 `pending`、run 一直 `active` —— **没有被 force-hold**，说明 stall clock 真的停了，不是「只是不扫描」；
- 恢复后又跑了 100 秒（自然 age 已 500 秒 ≫ 180 秒 hold 阈值）**仍未 force-hold** —— 证明恢复时刻确实成了新的 clock floor。

### 4.3 stall 告警 episode 键 + 解堵收口

让 delivery 因 owner 竞争持续 `busy`（零 store 改动，与生产 `busy` 同形），跨过 alert 阈值后 70 个 tick：

- **`rework_activation_stalled_alerted` 恰 1 条**（旧键会是 ~70 条）；
- 解堵到 `wake_delivered` 时 **恰 1 条 warning `rework_stall_recovered`**，正文按最早那条 receipt 算时长（「resumed delivery after 2 minutes」）。

**诚实边界**：这个场景的 main 对照也只有 1 条 —— 因为我的 `busy` 造型不会推高 generation，而 main 的键不稳定**恰恰依赖 generation 被 claim 循环推高**。所以这一格的 before/after 差异是**多了一条收口 warning**（0 → 1），不是条数下降；条数下降的证据在 §3 的三个真失败场景里。这条我不含糊过去。

### 4.4 第一口（issue thread）没有偷偷回来

本 PR 产出的全部 7 种告警形态，`eventType` 实测**都是 `workflow_engine_escalation`**（Lead 告警面），没有一条是 `workflow_engine_issue_alert`（founder issue thread 面）。这是运行时取证，不是读代码。

## 5. 真机 Discord E2E（FLY-529 隔离房，AC：新形态真的发得出去且长得对）

这是本单唯一的 Discord 面：告警内容与 severity。**新增了 `severity: "warning"`**（此前 workflow engine 只发过 `"severe"`），所以必须在真 Discord 上验，不能只看类型联合。

做法：把 harness 真实产出的 outbox payload 原样喂给**真 `LeadAlertNotifier`**（与 `plugin.ts` 同一套 composition：`resolveAlertDirsFromEnv` + `createClaims*` + unified alert channel），投进 FLY-529 隔离频道 `#test-flywheel-alerts` (`1519421055805165842`)，queue / deadletter / claims 全部重定向到 scratch slot。

结果（marker `QA1612-140908`，Discord 真消息 id 均已留存）：

| disposition | severity | 渲染 | 落地 |
|---|---|---|---|
| `rework_retry_exhausted`（僵尸文案） | severe | 🚨 | ✅ `1537206335970607197` |
| `rework_pane_loss_handoff` | severe | 🚨 | ✅ `1537206338247991317` |
| stall alert (`held`) | severe | 🚨 | ✅ `1537206339866988544` |
| `rework_stall_recovered` | **warning** | **⚠️** | ✅ `1537206341091991596` |
| `rework_reentry_paused` | severe | 🚨 | ✅ `1537206343457447937` |
| `rework_reentry_resumed` | **warning** | **⚠️** | ✅ `1537206344698953819` |

第 7 条（`rework_retry_exhausted` 的 worktree-脏文案）返回 `sent:false` —— 是**我**给两条同 disposition 的消息用了同一个 transport eventId，被 ClaimsDB 正确去重挡下。不是产品缺陷；顺带证明通道侧去重这层是活的。

正文实测可读，founder 能看懂在说什么：

- 僵尸：`… target actor is completed (irreversible); settled needs_lead after 1 attempt(s)` —— **没有谎称五次**。
- stall：`… first stalled at 2026-08-12T21:07:13.865Z (1 minutes ago)` —— issue 要求的「距首次 X」到位了。
- 暂停：`… paused by operator configuration with its delivery, reservation, activation, credentials, and verification state unchanged.`

**生产隔离**：`~/.flywheel/alert-queue` 新增文件 **0**，`alert-deadletter` 新增 **0**，我的 6 条 claim 全在 slot-local claims.db，生产 claims.db 里 `event_id LIKE '%QA1612-140908%'` 命中 **0**。（生产 claims.db 的 mtime 确实变了 —— 那是生产 Bridge 自己在同一时间写它自己的 claim，我逐行核过内容，不是我写的。）

founder 视角截图（Claude-in-Chrome，Annie 已登录会话，真频道）：
`/Users/xiaorongli/.flywheel/runner-state/d99cf355-6da2-4ab7-90c0-7f72e82e4225/browser-tmp/claude-chrome-screenshots-ey66Sz/screenshot-1786569210115-1.jpg`

## 6. 自动化门

| 门 | 结果 |
|---|---|
| `packages/teamlead` 相关 6 个套件 | **210 passed**（StateStore.workflow-rework 26 / workflow-engine-dispatcher 77 / workflow-rework.e2e 3 / workflow-rework-coordinator 21 / phase-orchestrator 74 / land-lifecycle 9） |
| `packages/config` feature-flags registry | **31 passed** |
| `pnpm lint`（全仓 2401 文件） | **0 error**，13 warning（既有基线） |
| `pnpm -r build`（22 workspace） | **exit 0**，全绿 |

主机负载红线：本机 load 29–50、free mem 1GB，按 `feedback_heavy_vitest_suite_on_prod_host_kills_bridge` 只跑定向文件、单线程，**没有跑全量 `test:packages:run`**（会压死生产 Bridge）。全量结果以 CI 为准。

## 7. Honest boundary（我没测到的）

1. **credential 保全**：我的 harness 那一格是空断言，见 §4.1；结论借的是实现者的非空过定向测试，我核实了它非空过，但那不是我独立跑出来的差分。
2. **全量 `pnpm test:packages:run`**：主机负载红线下没跑，以 CI 为准。
3. **部署后真实生产观察窗**：计划 §5 要求「尾流归零起算 ≥2h alerts 频道零同文连发」—— 这必须在 Bridge 重启部署之后做，属 post-ship 验收，不在本节点范围。部署前 preflight（`workflow_alert_outbox` 里 `rework_stalled_alert%` 的 pending/delivering 计数）也留给部署那一步。
4. **`severity=warning` 不触发 severe DM**：代码路径是 `severity === "severe" && lead?.alertDmUserId`；我的测试 Lead 没配 `alertDmUserId`，所以 severe 那几条也 `dmSent:false` —— 这一跑对「warning 不 DM」是**不结论**，我只从代码读到它不可能 DM。
5. **`replacement_pending` materialize 单次失败**这一族按计划 §2-6 明确排除在预算承诺外，我没为它做独立预算验证。

## 8. 建议（不阻塞 PASS）

**LOW — `enqueueReworkRecoveredIfAlertedTx` 的首条 stall receipt 查询**：SQL 是 `WHERE run_id=? AND event_uid >= ? AND < ? ORDER BY seq LIMIT 1`。`event_uid` 有 UNIQUE 索引所以是范围扫描（不是全表），且只 JSON.parse 一条 —— 计划 §84 的核心约束（最多两次 parse）守住了。但 `ORDER BY seq` 可能让 SQLite 对整个区间做一次排序；碰上存量 1272 行的 legacy 风暴 request，这个排序会在 `wake_delivered` 写事务里发生一次。不影响正确性，量级也小，记为 follow-up 观察项即可。
