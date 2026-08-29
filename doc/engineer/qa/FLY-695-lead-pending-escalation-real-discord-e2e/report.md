# QA Report: FLY-695 — FLY-637-ext lead-pending escalation 真 Discord 升级链路 E2E

**Issue**: FLY-695 (QA · FLY-637 E2E — 真 Discord 升级链路；529 Room、秒级计时、故意卡 runner)
**Verifies**: PR #386 (FLY-637-ext) — lead-pending escalation 的**真投递链路**（催 Lead → 页 Annie）
**Verified head**: `1dd0ff85`（origin/flywheel-FLY-637，会 ship 的 head；含 FLY-663 better-sqlite3 merge）
**Date**: 2026-06-29
**Method**: 隔离沙箱（temp dir）驱动**真 GatePoller.poll()** 全链路 + **秒级计时 override** + **真 Discord 投递**到 529-Room 隔离告警频道 `#test-flywheel-alerts`（`1519421055805165842`）
**Verdict**: ✅ **PASS**（30/30 检查项绿；2 次完整复跑稳定）

---

## 0. 为什么有这个 QA（补 FLY-692 明确划在边界外的缺口）

FLY-692（PR #391）是 **mock-clock 逻辑层 + better-sqlite3 持久层** combined QA，它的「诚实边界」原文：

> 本 QA … **不**含 live 端到端：真实 20min–2h 退避延时、**真 Discord 催 Lead / 页 Annie 消息投递**、真 Bridge 重启 …

FLY-695 正是补这块：runner **真卡**在阻塞 question gate + Lead **故意不答** → **真催**到 Lead（mailbox）→ **真页**到 Annie 的 test 替身频道，用**秒级 timer override**（不实等 20min–2h）。

---

## 1. ⚠️ 关键架构发现（Tadashi 已确认，写在显眼处 —— 纠正心智模型）

验收 #1 原话「nudge **真发一条 Discord 消息**到 test-Lead 的频道」隐含一个心智模型：Bridge 直接把催促帖发到 Discord。**实际架构不是这样**，两条投递面**不对称**：

| 升级动作 | event type | 投递机制 | 落点 | Discord 可见性 |
|---|---|---|---|---|
| **催 Lead** | `runner_lead_pending_escalation` | `runtime.deliver()` → **MailboxLeadRuntime** | Lead 的 **mailbox JSON**（`<CLAUDE_CONFIG_DIR>/teams/<lead>/inboxes/<lead>.json`）| **不是直接 Discord 帖** —— Lead agent 读 inbox 后自己 relay 进 Discord（独立机制，**非 637 范围**）|
| **页 Annie** | `runner_lead_pending_unhandled` | `LeadAlertNotifier.alert()` | **统一告警 Discord 频道**（POST）| **真 Discord 消息**，GET 读回为证 |

**含义**：
- 「催 Lead」的「真投递」= **真写进 Lead 的 inbox（= Lead 真收到）**。这正是 Leads 平时收所有 Bridge 消息的方式（FLY-92/195 同路径）。本 QA 直接读那个 inbox JSON 作铁证。
- 「真到 Discord」**只有页 Annie 这条是 Bridge 直接做的**。催 Lead 要出现在 Discord 需要一个**活的 Lead agent 去转发**（FLY-637 不负责、不在范围）。
- 这是个**真实发现，不是 bug**：637 的设计就是「催 Lead 走 mailbox、页 Annie 走告警频道」。Annie 若想要催 Lead 也可视在 Discord，那是另一条（Lead relay / 直发）的 follow-up，不阻塞 637 ship。

> Tadashi（brainstorm gate）拍 **A**：nudge 在『真 mailbox 投递边界』取证（= Lead 真收到）、page 作为真 Discord 端到端产物。本 QA 按此执行。

---

## 2. 方法与隔离（绝不碰生产 / 绝不 Annie 真 DM）

驱动**真 GatePoller.poll()** 主循环（不是 mock 调私有方法，是真迭代 pending question → relay → maybeEmitLeadPendingNudge → emit），喂真组件：

- **真 StateStore**（better-sqlite3，temp 文件）—— sessions + `lead_pending_escalation` 退避行
- **真 CommDB**（`FLYWHEEL_COMM_DIR` 重定向到 temp）—— 种一个阻塞 `question` gate
- **真 MailboxLeadRuntime + 真 ClaudeCodeAdapter** —— 催 Lead → **真写 inbox JSON**（read-after-write verified）
- **真 LeadAlertNotifier** → `unifiedAlert` 指向隔离 `#test-flywheel-alerts` —— 页 Annie → **真 Discord POST**，curl GET 读回

**秒级 override**（env，全 env 可调，证明阈值逻辑）：`FLYWHEEL_LEAD_NUDGE_GRACE_MS` / `_BACKOFF_FACTOR` / `_CAP_MS` / `_PAGE_ANNIE_ROUNDS`。

**隔离铁证（绝不碰生产）**：`FLYWHEEL_COMM_DIR` / `CLAUDE_CONFIG_DIR` / `FLYWHEEL_ALERT_QUEUE_DIR` / `FLYWHEEL_ALERT_DEADLETTER_DIR` / `FLYWHEEL_CLAIMS_DB` 每场景全部指向**新建 temp 沙箱**。页目标是**隔离 test 频道的频道帖**（`#test-flywheel-alerts`，bot=`flywheel-test-1`/`TEST_BOT_TOKEN_1`）—— **不是 DM**，Annie 真 DM 从不被页。生产 Bridge（主仓 PID）全程不碰、不重启。

**harness**: `scripts/qa-fly-695-lead-pending-escalation-e2e.mjs`（本 PR）。

---

## 3. 验收结果（6 条全 PASS）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | **真 nudge 投递**：grace 到 → 真催（= Lead 真收到）| ✅ | Scn1：grace 前 0 催；grace（5s）后 inbox JSON 出现 `runner_lead_pending_escalation` 第 1 条（**真 mailbox 写入 + read-after-write verified**）|
| 2 | **退避时序（scaled）**：第 2 轮 ~2×grace、第 3 轮 ~4×、封顶 | ✅ | Scn1：#1→#2 ≈ **10.7s**（2×grace=10s）、#2→page ≈ **21.4s**（4×grace=20s）。Scn5：cap=8s 时 #2 ≈6.3s（2×grace<cap）、#3 ≈8.3s（**钳到 cap**，非 4×grace=12s）、#4 ≈8.4s（**cap 持续**）|
| 3 | **满轮 → 真页**：催满 `PAGE_ANNIE_ROUNDS`（=2）→ 真发一条 page 到 test 频道 | ✅ | Scn1：2 轮催 Lead 后第 3 个 escalation = page → **真 Discord POST** 到 `#test-flywheel-alerts`，`sent:true`，**curl GET 读回**确认消息存在（见 §4 message id），body=「⚠️ Runner waiting — Lead unresponsive: FLY-695 … runner_lead_pending_unhandled」。**eventType=`runner_lead_pending_unhandled`**（非 stuck 语义，不进 AutoRepairBot）|
| 4 | **Lead 答了 → 立刻停 + 清状态** | ✅ | Scn2：催 #1 后 Lead 插 response（答题）→ question 掉出 pending → 再过 next-eligible 也**无 #2**；`lead_pending_escalation` 退避行**被 prune 清掉**（`getLeadPendingEscalation`→undefined）；无 page |
| 5 | **kill-switch** `FLYWHEEL_LEAD_PENDING_ESCALATION=0` → 完全不催不页 | ✅ | Scn3：过 grace 后连续 4 tick → **零催、零页、零退避行** |
| 6 | **排除项不触发真投递**：非阻塞 ask / founder-facing gate / 冻住 | ✅ | Scn4：① 非阻塞裸 ask（checkpoint=null）→ 0 催 0 页；② founder-facing（`approve_to_ship` + `brainstorm`）→ 0 lead-pending 催/页（FLY-605 管 founder）；③ 冻住（session running 无 pending question）→ 0 催 0 页（FLY-195 管冻死）|

**补充验证**：
- `PAGE_ANNIE_ROUNDS=2` 是**测试值**（够证明阈值逻辑）。**生产默认 = 3，全 env 可调；`=0` 显式定义为「永不页 Annie、只一直退避催 Lead」**（Scn5 实证：rounds=0 跑满 4 催 `paged_annie` 始终 false、`pages=0`）。
- page 是**频道帖、非 mailbox 催**：Scn1 出 page 时 inbox 催数仍为 2（不污染催计数）。

---

## 4. 真 Discord 证据（GET 读回）

页 Annie 真帖落在隔离 `#test-flywheel-alerts`（guild `1485787271192907816` / channel `1519421055805165842`），bot `flywheel-test-1` 发：

| 跑次 | message id | GET 读回 content（截断）|
|---|---|---|
| smoke (scn1) | `1521391255609938022` | ⚠️ **Runner waiting — Lead unresponsive: FLY-695** (qa695-test-lead / runner_lead_pending_unhandled) … |
| full run #1 | `1521392153375277216` | 同上 |
| full run #2（确定性复跑）| `1521393122003779594` | 同上 |

3 次跑均产出一条真 page 帖、内容一致；退避时序逐跑稳定（#1→#2 ≈10.7s 两跑相同、#2→page ≈21.4/21.5s、cap 钳制 ≈8.3s）—— 真秒级 wall-clock 下无 flaky。

GET 读回方式：`GET /api/v10/channels/1519421055805165842/messages/<id>`（bot token，**Discord API 权威真相源**）。channel 列表 GET 亦确认两帖均在频道。

> **Chrome-as-Annie 说明（诚实边界）**：本 session 的 Chrome profile 未登录 Discord（导航跳登录页），按安全规则**不输入凭据**。按既有 QA 先例（FLY-582/FLY-605 reference：「Chrome 可能 DOWN → API 是权威真相源，Tadashi 接受 API-authoritative」），真 Discord 证据以 **Discord API GET 读回**为权威。两帖确实落在隔离 test 频道、内容正确。

---

## 5. 测试证据（harness 输出）

```
FLY-637 dist: worktrees/fly-637-qa/packages/teamlead/dist （origin/flywheel-FLY-637 @ 1dd0ff85，topo build）
alert channel: 1519421055805165842 (#test-flywheel-alerts)

Scenario 1  (real nudge backoff + REAL Discord page, rounds=2)
  ✅ AC1 no nudge before grace
  ✅ AC1 nudge #1 → REAL Lead mailbox after grace (inbox JSON: runner_lead_pending_escalation)
  ✅ AC2 no nudge #2 before grown interval
  ✅ AC2 nudge #2 after ~2×grace (interval ≈ 10.7s)
  ✅ AC2 page interval ~4×grace (interval ≈ 21.4s)
  ✅ AC3 page fired a REAL Discord alert (sent:true, channel 1519421055805165842)
  ✅ AC3 page eventType = runner_lead_pending_unhandled
  ✅ AC3 nudge count still 2 (page is NOT a mailbox nudge)
  ✅ AC3 GET read-back: page exists in #test-flywheel-alerts
  ✅ AC3 GET read-back body names FLY-695 + Lead-unresponsive
Scenario 2  (Lead answered → stop + clear)         5/5 ✅
Scenario 3  (kill-switch = 0)                       3/3 ✅
Scenario 4  (exclusions: ask / founder / frozen)    6/6 ✅
Scenario 5  (backoff cap clamp + rounds=0 no-page)  6/6 ✅

──── SUMMARY  PASS=30 FAIL=0 ────   (2 次完整复跑稳定，真秒级时序无 flaky)
```

---

## 6. Boundary / Notes（诚实边界）

- 「催 Lead 真到 Discord」= **mailbox 投递（Lead 真收到）**，不是 Bridge 直发 Discord 帖（§1）。要催 Lead 也可视在 Discord 需活 Lead relay —— **非 637 范围**，可作 follow-up，不阻塞 ship。
- 秒级 timer 是 env override（生产默认 grace=20min / ×2 / cap=2h / page=3 轮）；本 QA 证明的是**机制 + 真投递 + 退避数学在真 wall-clock 下成立**，不是生产的绝对时长。
- 真退避数学（指数 + cap 钳制 + page-once + reset）在 FLY-692 的 30/30 mock FSM driver 已穷尽证；本 QA 在**真秒级 wall-clock + 真投递**下交叉复证（不是重跑 FLY-692）。
- 隔离用 `FLYWHEEL_COMM_DIR`（FLY-493 引入的 comm.db 重定向）+ `CLAUDE_CONFIG_DIR` + `FLYWHEEL_ALERT_*` + `FLYWHEEL_CLAIMS_DB`，每场景独立 temp，生产零污染、生产 Bridge 不重启。

---

## 7. 结论

**6 条验收项全 PASS（30/30 检查、2 次复跑稳定）**：真 mailbox 催 Lead（= Lead 真收到）、真秒级指数退避（2×→4×→cap 钳制）、满轮真 Discord 页到隔离 test 频道（GET 读回为证）、Lead 答了立停清状态、kill-switch 全关、排除项（非阻塞 ask / founder-facing / 冻住）全不触发。关键架构发现（催 Lead = mailbox 投递、非 Discord-direct）已写在显眼处。

**建议**：FLY-637 → 可 ship（跟 FLY-694 一起一次小重启）。catch：「催 Lead 也可视在 Discord」如 Annie 要，留 follow-up（活 Lead relay），不阻塞本 ship。
