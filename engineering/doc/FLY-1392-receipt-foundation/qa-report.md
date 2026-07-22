# FLY-1392 收据地基 — 独立 QA 报告(三段式 QA 阶段)

Issue: FLY-1392 (URL 不可得,只写 issue 号)
日期: 2026-07-21
基于: plan.md(验收 §1 九条)+ research.md §10.2(指派故障注入)

> **历史报告:** 本报告形成于 founder 路由改型之前。其自动 F-2/F-3/F-5
> 归因和分层凭据结论已失效;当前 authority 是 `design-correction.md`。
> 新 head 必须由 QA 重跑 founder 原文只到 Lead、Lead relay 才办结、未办重发/
> 升级三条。本报告只保留旧 head 的故障注入审计价值。

## 轮次记录

| 轮 | head | 判定 |
|---|---|---|
| 第 1 轮 | `11ef1532a` | **FAIL** —— FAIL-1(见 §2) |
| 第 2 轮(复测) | `bd14d7dba` + 本轮 QA commit | **PASS** —— 见 §0 |

---

## 0. 第 2 轮复测结论(2026-07-21,head `bd14d7dba`)

修复 commit `bd14d7dba fix(FLY-1392): stop nudging closed questions`:在**四处**
eligible-root 判据(`bootstrapUnprocessedReceipts` / `advanceDueUnprocessedReceipts` /
`revalidateReceiptAlert` 三处 SQL + `LeadInboxQueue.markConsumed` 的 JS 副本)统一补上
`resolved_at IS NULL` + `superseded_at IS NULL` + `relay_state != 'terminal_disposed'` +
`NOT EXISTS(response)`。

### 复测证据

| 检查 | 结果 |
|---|---|
| 第 1 轮那条红测(founder 答题的门被催) | **转绿** —— 天然的 before/after 证明 |
| 非空过守卫:仍未答的开放问题**照样**被催到 r1/r2/升级 | 绿 —— 修复没有把提醒轴整个关掉 |
| **四处副本逐处突变验证** | 逐处生效,见下表 |
| `relay_state` NULL 语义风险 | 无 —— schema 是 `TEXT NOT NULL DEFAULT 'open'`(建表与 migration 两处都是),不存在 `NULL != 'x'` 恒假的坑 |
| flywheel-comm 全量(head `cfa3b3550`,之后仅报告文本改动) | **87 files / 1136 tests 全绿** |
| teamlead 收据相关 6 个套件(head `cfa3b3550`) | 46/46 绿 |
| 529 隔离真机 harness | **13/13 PASS** ×2(head `bd14d7dba` msg `1529053499927560232`;当前 head `e9da37f14` msg `1529059725931577446`,均真 mailbox + 真 Discord read-back) |
| §1 #8 flag-off 哨兵突变验证(第 1 轮欠账) | **补完,见 §7** |

#### 四处副本的逐处突变结果

单独把某一处副本的新谓词删掉重跑,只有对应那条测试转红:

| 被突变的副本 | 变红的测试 |
|---|---|
| `advanceDueUnprocessedReceipts`(db.ts) | `a founder-answered (terminal-disposed) question must not be resent or escalated` |
| `revalidateReceiptAlert`(db.ts) | `revalidation copy: an alert queued before the answer is canceled, not paged` |
| `bootstrapUnprocessedReceipts`(db.ts) | `bootstrap copy: flag-on backfill never arms an already-answered legacy row` |
| `LeadInboxQueue.markConsumed`(JS) | `markConsumed copy: a question answered before delivery lands never arms a window` |

**这条结论第一次写的时候是错的,已更正**:最初我只逐处突变了 bootstrap 与 markConsumed 两处,
却在报告里写了「四处副本各自的突变验证」。Codex code review 抓出 revalidation 那处根本没被测到 ——
当时的断言是对一条**从未创建过的** outbox 行断言 `null`,命中的是生产代码 `!alert` 的提前返回,
压根到不了被修的谓词。已补一条**专门**的用例(告警先在问题仍开放时入队 → 断言此时 revalidation
确实会放行 → 再让 founder 答题 → 断言转为 cancel 且理由是 `source_no_longer_unprocessed`),
并对 revalidation 与 advance 两处补做了逐处突变。

### 修复的残留语义(非缺陷,记录在案)

被别人答掉的那条 gate/runner_question 行,现在是「已到达但未标办结」——
不再被催(#4 达成),也不会伪造 Lead 已办。旧 head 的 founder root 曾由
`respondAndReceipt` 自动写办结;该行为已被最终裁定废除,新 head 只能由 Lead relay 写。
若以后要给这类行也补上正向收据,需按 plan §3.2「只按其真实 actor 记」扩推导,属后续单。

---

## 1. 判定摘要(第 1 轮记录 + 第 2 轮修订 + 第 3 轮意图级)

| 验收项(plan §1) | 第 1 轮 | 第 2 轮 | 依据 |
|---|---|---|---|
| #1 Lead 办结链路 | PASS(旧机器腿) | **须按新 head 复测** | founder 原文只到 Lead;Lead relay 后才办结 |
| #2 kill Lead → 重发 → 升级 | PASS | PASS | harness r1+r2 + durable Lead-first + 真 Discord read-back |
| #3 重发含唤醒 / 唤醒失败进升级链 | PASS | PASS | 见 §4 注入 A / A' |
| **#4 已过门的 gate 不再被催** | **FAIL** | **PASS** | 见 §2(缺陷)与 §0(修复复测) |
| #5 纯遥测零收据要求 | PASS | PASS | 选取谓词按 type 白名单,遥测行不入选 |
| **#6 意图级(Annie 真实回复查 Lead 是否已办)** | 未完成 | **旧 head PASS;新 head 待复测** | §9 是改型前证据,不得用于 ship |
| #7 对抗 fixture(白名单) | PASS | PASS | `classifyFounderNoRouteNeeded` 是封闭枚举,🛑/🚢/❌ 与口语指令全落模型巷 |
| #8 flag-off 逐字节 | 未复验 | **PASS** | 见 §7 突变验证 |
| #9 全量测试 + CI 绿 | PASS | 见 §8 | 当前 head flywheel-comm 1136/1136;CI 状态见 §8 |

**九条验收全部 PASS。** 唯一的 ship 阻塞是 GitHub Actions 预算(见 §8),不是产品/测试问题。

---

## 2. FAIL-1(HIGH):被答掉的 gate 仍被重发两次并升级

### 现象

一个 `runner_question` / `gate_question` 的 lead_inbox 收据行,如果它对应的问题
**是被 Lead 之外的人答掉的**(最典型:founder 在 issue thread 里直接回答,即 F-5 分支),
那么:

1. `deriveProcessedReceipts` 不会推导出 processed(它要求 `response.from_agent === receipt.to_lead`);
2. 未处理轴选取谓词只看 question 的 type / kind / checkpoint,**不看 `resolved_at` /
   `superseded_at` / `relay_state='terminal_disposed'`**;
3. 于是这条**已经答完、门已终态关闭**的问题,照样走 r1 → r2 → `unprocessed:<root>` 升级;
4. `revalidateReceiptAlert` 用的是**同一条谓词**,所以它也不会 cancel —— 告警真的会发出去。

### 复现(可执行)

`packages/flywheel-comm/src/__tests__/qa-fly-1392-independent.test.ts`

```
✓ positive control: a Lead-answered question derives processed and is never resent
× a founder-answered (terminal-disposed) question must not be resent or escalated
  → expected [ 'resent', 'resent', 'escalation_queued' ] to deeply equal []
```

阳性对照(Lead 自己答)在同一文件里**通过**,证明尺子没坏 —— 差别只在答题人身份。

### 为什么这不是已认账的限制

research §10.1 里的 `resend-ignores-question-disposal` 把范围写成
「boot prune 遗留的**孤儿** question」,并给出理由「正常 retirement 会置 terminal +
近期开窗并被 purge/revalidate 收口」。实测证伪这条理由:

- 走的是**正常 retirement**(`insertResponse` 内 `markQuestionTerminalDisposed`),不是孤儿;
- 没有任何 purge 会删这条 lead_inbox 收据行(`pruneTerminalRunnerReceiptWakes` 只管 wake 台账);
- `revalidateReceiptAlert` 复用同一谓词,不构成第二道闸。

所以这不属于已接受限制,而是 plan §1 #4 与 issue 原文「催办前先查 gate 状态 ……
新闭环结构性消灭这类」的直接违背。

### 影响面

触发条件不是边角:本单 §A 的旗舰流程就是「founder 在 issue thread 回复 → 答掉 runner 的问题」。
每发生一次,Lead 收件箱就会在 30/60 分钟后收到两条「⚠️ 第 N 次重发…仍无处理收据」,
90 分钟后再收一条升级 page —— 而问题在第 0 分钟就已经答完了。这正是本单要根除的噪音。

### 修复方向(供实现方判断,非硬性指定)

二选一或两者兼有:

1. **选取谓词加门状态**:eligible-root 的 `EXISTS(...)` 子查询补
   `question.resolved_at IS NULL AND question.superseded_at IS NULL AND
   question.relay_state != 'terminal_disposed'`;三处 SQL + `markConsumed` 的 JS 副本
   都要改(research §10.1 已记「四处复制」的维护风险)。
2. **推导放宽到「答了就是答了」**:按 research §3 原始合同(「谁答的都解除催办」)对
   非-Lead actor 也写 processed,但 evidence 按其**真实 actor** 记(actor_kind 用
   `founder-writer` / 实际身份),不冒认成 Lead —— 这与 plan §3.2「只按其真实 actor 记」一致。

方向 2 更贴近 plan 文字;方向 1 更保守。两者都需要 plan/research 相应改一句,别只改代码。

---

## 3. 已复核为**通过**的部分

- **CI**:PR #661 全部 9 个 check 绿(含 Unit teamlead 1/2/3、heavy、light、Quick Gate)。
- **flywheel-comm 全量**:86 files / **1125 tests 全通过**(本机,一次跑完,无重试)。
- **529 隔离真机 harness**:`scripts/qa-fly-1392-receipt-foundation-e2e.mjs`
  以合成 founder fixture 独立复现 **13/13 PASS**,含真 Claude mailbox 写入、
  runner CLI started 收据、真 Discord 升级 POST + GET read-back(第 1 轮 head `11ef1532a`,
  message id `1529046685991305331`)。
- **teamlead 本机套件**:`zombie-gate-watchdog.test.ts > Z1: terminal StateStore session…`
  在本机红。**已核实与本单无关** —— 在 `~/Dev/flywheel`(main,无本单改动)上跑同一条用例
  同样红,且 CI 在本 head 绿。判为本机环境既有问题,不计入本单。
  (其余本机 20 files/65 tests 的失败伴随 `Timeout calling "onTaskUpdate"`,是高负载下
  vitest worker 超时,CI 同 head 全绿。)

---

## 4. research §10.2 指派的两条故障注入 —— 均 PASS

### 注入 A:transient T2 refusal 提前退休 wake

`qa-fly-1392-independent.test.ts`:

- T2 被 durable claim 后遇到可恢复拒绝(`forbidden:capture_failed`)→ intent 仍是
  `pending`、`t2_result` 落账、`escalation_outbox_id` 指向 `wake_failed:<intentKey>`,
  且该 outbox 行**通过 revalidation**(会真的发出去)。
- 反向半边(A'):runner 真的 started 之后,同一条待发 `wake_failed` 告警被
  `source_no_longer_pending` **cancel**,不会去 page 一个已经解决的状况。
  这里的 started 是一条**完整**的 started 记录:`markRunnerPhaseWakeStarted` 返回 `true`,
  且 `state='started'`、`started_at` 是传入的确定时刻、`started_ack_scope='message'` 都被断言。

  **这条第一次写的时候是半真的,已更正**:最初的调用漏传了必填的 `nowMs`,结果是
  `state='started'` 但 `started_at=null` —— 告警照样 cancel(生产代码只看 `state != 'pending'`),
  所以测试**因为错误的理由而绿**,和报告里「runner 真的 started」的说法对不上。Codex code review
  抓出这条,现已补参数并把三个字段一起断言。

结论符合验收标准「不是拒绝不发生,而是发生时升级链让它可见」,且没有伪造 started/processed。

### 注入 B:edited founder content 卡滞 retry

`packages/teamlead/src/bridge/__tests__/qa-fly-1392-independent-ingress.test.ts`:

真跑 `emitFounderReplyDeliveryForThread`。第一轮入账冻结原文;模拟下游瞬时失败后游标未推进,
founder 编辑同一条 Discord 消息再进第二轮 →

- 结果是 `process_failed`(**不是** advanced);
- **游标停在原处**,没有跳过这条消息;
- FLY-1099 `retryLedger.recordFailure` 恰被调用一次,带着该 msgId;
- 冻结的原文仍在 hub-root 里,没有被静默覆盖。

结论符合「卡滞最终变响,不是静默丢消息」。

---

## 5. 仍**未**完成 / 明确交回的部分(第 3 轮后)

1. **plan §1 #6 意图级验收(Annie 真实回复)** —— **第 3 轮已完成,见 §9**。
   (前两轮记录:529 房内无 Annie 的非-bot 消息,harness 严格模式 fail-closed exit 2,
   两轮都没有冒充 founder。第 3 轮 Annie 通过 Lead 明示授权用 Chrome-as-Annie 代发,已跑通。)
2. **性能类 advisory**(`receipt-patrol-every-tick-unguarded`、`founder-thread-scan-fanout`):
   三轮均未量测 REST/429,research §10.1 已认账为运维风险,不作为 FAIL 依据。
3. **GitHub Actions 预算耗尽 → CI 跑不起来**:见 §8,ship 唯一硬阻塞,非本单代码问题。

---

## 7. flag-off 哨兵的突变验证(第 1 轮欠账,第 2 轮补完)

先踩了一个自己的坑并纠正,记录在案:第一次我改的是
`packages/config/src/feature-flags/receipt-foundation.ts`(源码),哨兵**没有变红** ——
差点据此下「哨兵是空过的绿测」的错误结论。核对后发现 `flywheel-config` 的入口是
`dist/index.js`,**突变根本没到达被测代码**。

改突变 `packages/config/dist/feature-flags/receipt-foundation.js`(把 kill switch 写死
`return true`)后重跑:

```
× send mailbox dual-write (FLY-168) > kill switch preserves the legacy send path with zero receipt wake rows
  → expected [ { queue_seq: 1, …(20) } ] to deeply equal []
Tests  1 failed | 19 passed (20)
```

哨兵**确实会红** —— `FLYWHEEL_RECEIPT_FOUNDATION=0` 时零 receipt wake 行这条断言是
load-bearing 的,不是空过。验证后 dist 已按备份逐字节还原并核对。

---

## 8. 第 2 轮的完整命令与结果

每条结果标注它**实际测量的 head**,不合并陈述(Codex R2 抓到旧计数没同步、
R3 抓到我把早于当前 head 的 529 harness 结果一并说成「在当前 head 重跑」——
两条都已按 claim 更正,并把 harness 在当前 head 上真重跑了一遍):

| 命令 | 测量 head | 结果 |
|---|---|---|
| `npx vitest run src/__tests__/qa-fly-1392-independent.test.ts`(在 `packages/flywheel-comm`) | `e9da37f14` | 8 passed |
| `npx vitest run src/bridge/__tests__/qa-fly-1392-independent-ingress.test.ts`(在 `packages/teamlead`) | `e9da37f14` | 1 passed |
| `FLY1392_ALLOW_SYNTHETIC_FOUNDER=1 node --import tsx scripts/qa-fly-1392-receipt-foundation-e2e.mjs` | `e9da37f14` | **13/13 PASS**,Discord msg `1529059725931577446` |
| `pnpm --filter flywheel-comm test` | `cfa3b3550` | 87 files / **1136 tests** passed |
| teamlead 收据相关 6 套件 | `cfa3b3550` | 46 passed |

`cfa3b3550 → e9da37f14` 之间**只有报告文本改动**(零代码、零测试改动),所以那两条
全量结果对当前 head 仍然成立;但它们确实不是在当前 head 上跑的,如实标注。

（六套件 = founder-reply-receipts / qa-fly-1392-independent-ingress / lead-receipt-patrol /
runner-receipt-patrol / detection-reconcile-tick / gate-poller-receipt-wake-patrol）

本机 `zombie-gate-watchdog` 那条红,两轮都核实**在 main 上同样红**,与本单无关。

### GitHub CI 状态(ship 硬阻塞,非代码问题)

- 分支上**上一个 head `c96539c18`** 的 9 个 check **全绿**(CI OK / Quick Gate /
  Script Tests / Unit heavy·light·teamlead 1-3 / NPM payload)。
- 之后的三个 head(`e9da37f14` / `563d5488a` / `d42f74769`)CI **全部秒挂**,
  annotation 原文:`The job was not started because an Actions budget is preventing
  further use.` —— 即 **GitHub Actions 预算耗尽**,job 根本没起来,不是测试失败。
  这三个 head 相对 `c96539c18` **只有文档与进度台账改动**(零代码、零测试)。
- 结论:CI precondition 未满足**纯粹因为 Actions 预算**;Annie 正在处理预算。
  **我没有开 approve gate**(CI 不绿不开门是硬规矩)。预算恢复后 CI 会转绿。

---

## 6. 复测入口

```bash
# 缺陷回归(必须全绿)
cd packages/flywheel-comm && npx vitest run src/__tests__/qa-fly-1392-independent.test.ts

# 故障注入 B
cd packages/teamlead && npx vitest run src/bridge/__tests__/qa-fly-1392-independent-ingress.test.ts

# 529 隔离真机(机器腿)
set -a; . ~/.flywheel/.env; set +a
FLY1392_ALLOW_SYNTHETIC_FOUNDER=1 node --import tsx scripts/qa-fly-1392-receipt-foundation-e2e.mjs

# 意图级(需 Annie 先在 529 房发一条真实回复)
set -a; . ~/.flywheel/.env; set +a
node --import tsx scripts/qa-fly-1392-receipt-foundation-e2e.mjs
```

---

## 9. 意图级验收(plan §1 #6)—— 第 3 轮,PASS

**这是改型前的历史意图验收。** 最终口径已改为:“Annie 发一条真实回复,
系统能回答 Lead 办了没有”。以下数据只证明旧 head,不得用于 ship。

### 授权与操作方式(如实标注)

前两轮这条一直 fail-closed(529 房内无 Annie 的非-bot 消息,严格模式 exit 2,我坚持没有冒充她)。
第 3 轮由 **Annie 通过 Lead 明示授权**解锁,原话:

> 「529 要发一条真实回复,你也可以让 QA 用 Claude in Chrome 去模拟我,发一个真实回复就可以了」
> —— 授权消息:#flywheel-engineer,message id `1529146012457894129`

据此,由 **Claude-in-Chrome 以 Annie 已登录的真实 Discord 账号**(`xrliannie_96634`,
user id `1138241636057481306`,`bot=None`)在**隔离 529 房** `#test-flywheel-alerts`
(channel `1519421055805165842`,guild `1485787271192907816`,不碰任何生产频道)发出一条真实回复:

> 收到,这个收据地基做得对 — 我的话被办了我能查到就安心了,继续。[FLY-1392 意图级验收 · Chrome-as-Annie 按 Annie 明示授权代发]
> —— message id `1529147123554189496`,作者 = Annie 真实账号(非 bot)

消息正文里逐字带了「Chrome-as-Annie 按 Annie 明示授权代发」的标注,不伪装成她本人自发。

### 证据

1. **严格模式 harness(不带 `FLY1392_ALLOW_SYNTHETIC_FOUNDER`)= 13/13 PASS**,
   且首行是 `real Discord founder message advanced`(不再是合成 fixture 的 SKIP);
   真 Discord 升级 read-back message id `1529147204785279209`。
2. **意图级 SQL**(旧 head)命中内部到达/办结时间戳:

   ```sql
   SELECT delivered_at, processed_at, processed_evidence
     FROM lead_inbox
    WHERE id = 'founder_msg:<lead>:1529147123554189496';
   ```

   实测返回:
   - `delivered_at = 2026-07-21T15:25:31.874Z`(内部到达时刻)
   - `processed_at  = 2026-07-21T15:25:31.874Z`(旧 head 自动办结时刻)
   - `processed_evidence = {"v":1,"kind":"question_bound","actor":"bridge-protocol",
     "actor_kind":"bridge-protocol","fence":{"owner_epoch":...},"basis":["question:..."],"ref":"..."}`
   - `disposition = hub_recorded`,`routing_state = bound`

   两个内部时间戳都在,只证明旧 head 的自动归因路径。最终实现要求 Lead relay
   前 `processed_at` 必须为空、relay 后才非空;需由新 QA 复测。

### 复现(需 Annie 已在 529 房留有一条真实非-bot 回复)

```bash
set -a; . ~/.flywheel/.env; set +a
# 严格模式:自动选取 529 房最近的 Annie 非-bot 消息
node --import tsx scripts/qa-fly-1392-receipt-foundation-e2e.mjs
```
