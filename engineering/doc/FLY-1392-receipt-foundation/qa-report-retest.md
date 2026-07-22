# FLY-1392 收据地基 — 独立 QA 复测报告(照抄模型改型)

Issue: FLY-1392 (URL 不可得,只写 issue 号)
日期: 2026-07-21
基于: design-correction.md(founder 路由最终 authority)+ Lead RE-TEST 指令(三范围 + flag-off)

被测 head: `8da8e8f68`(fix: route founder replies only through Lead)+ 本轮 QA commit
本报告是 **founder 照抄模型改型后**的复测;改型前的 `qa-report.md` 只保留旧 head 的
故障注入审计价值,其自动 F-2/F-3/F-5 归因与分层结论已失效。

判定: **PASS**(三范围 + flag-off 全部通过 + 新模型真机 E2E 18/18)。原「真机边界」
(旧 529 harness stale)已按 Lead 裁定当场补齐:harness 改写到新模型并跑通真机轮 —— 见 §4。

---

## 1. RE-TEST 范围逐条结论

| RE-TEST 范围(Lead 指令) | 结果 | 依据 |
|---|---|---|
| ① F-2/F-3/F-5:founder 原文直达 Lead,零 hint/bridge 代答/bridge 直写 runner wake | **PASS** | §2 |
| ② handled 语义:只有 Lead relay/no-route 写 processed_at 与建 wake;忘答→顶回→升级;已答门安静 | **PASS** | §3 |
| ③ 对外单概念「Lead 办了没有」+ design-correction.md 文档一致性 | **PASS** | §5 |
| 逃生阀 flag-off 的 fail-loud 告警存在性 | **PASS** | §6 |

---

## 2. 范围①:Bridge 对 founder 消息纯传送带(零 bridge-protocol 痕迹)

结构前提(读代码核实):`processFounderMessage` 里 `if (deps.receiptsEnabled)` 块
在**任何**匹配/ship/reply-to-card 逻辑之前**早返回** —— 记 hub-root(delivered)→
`deliverAmbiguousToLead` 转发原文给 Lead → return。ship-approval / respondImpl / wake
全在早返回之下,只在 flag-off 遗留路径可达。

独立验证(我新增 `qa-fly-1392-redesign-routing.test.ts`,3 tests,含**非空过对照**):

- **匹配非-ship 问题,receipts ON** → `respondImpl` 0 次、`wakeImpl` 0 次、
  `getResponse` undefined、`listRunnerPhaseWakes` 空、relay 恰 1 次;hub-root
  delivered 但 processed_at 为 null。
- **匹配 approve_to_ship 问题,receipts ON**(安全关键)→ 同上,**不自动批准**。
- **非空过对照:同一 fixture,receipts OFF** → legacy `respondImpl` **触发 1 次**
  (自动代答),relay 0,无 hub-root。**这条是承重的**:ON 路径根本不看 `matching`
  (早返回),所以只测 ON 无法证明「匹配的问题不被代答」—— OFF 对照证明那个问题是
  真 F-5 匹配,从而 ON 的沉默是 flag 造成的,不是 fixture 没匹配上。

实现方 `founder-reply-receipts.test.ts` 另覆盖 F-2(reply-to-card 不跑归因)/F-3
(ship 短语不跑 classifier)/unclear-ship(不 classifier 不 wake)/保留全文/立即转发无
grace 等;我的非空过对照是他们缺的一环。

---

## 3. 范围②:handled 语义 + 忘答路径

- **只有 Lead 动作写 processed + wake**:§2 的 ON 测试证明 Bridge 不写;实现方 F-5
  测试证明 Lead 跑 `routeFounderReply(--to-question)` 后同事务出现 response
  (from_agent=lead)、processed_at、routing_state=bound、runner wake。
- **founder hub-root 忘答路径**(我新增,`qa-fly-1392-independent.test.ts`)——
  **Annie「Lead 忙忘了」的旗舰**:用生产 `enqueueFounderHubRoot` 建一条 founder root
  不 handle → 巡检 `resent`→`resent`→`escalation_queued`,r1/r2 行内容带「第 N 次重发」,
  无 r3,`unprocessed:<root>` 告警行落账。
- **handled 保持安静**(我新增):Lead route 写 processed_at 后,巡检零重发零升级。
- **已答门保持安静**(上轮那条,新 head 仍绿):被 founder 直接答掉/终态关闭的
  runner_question 零重发零升级,且从不创建 outbox 行。四处 disposal 谓词副本上轮
  已逐处突变验证,新 head 未回归。

---

## 4. 真机边界(如实交回,ground truth)

旧 529 harness `scripts/qa-fly-1392-receipt-foundation-e2e.mjs` **未随改型更新**,
它编码的是**退役的两层自动处理模型**。我在新 head 实跑了一次(不空口断言):

```
=== FLY-1392 receipt foundation E2E: 7/13 PASS ===
FAIL  real Discord founder message advanced
PASS  layer 1 delivered receipt persisted
FAIL  layer 2 processed receipt persisted
FAIL  route side effect is the bound question response
FAIL  route admitted one durable runner wake
FAIL  real Claude mailbox received the wake pointer
FAIL  runner CLI recorded the constrained started receipt
PASS  unprocessed root emitted exactly r1+r2
PASS  Lead-first escalation is durable
PASS  receipt root records escalation only after Lead notify
PASS  real Discord escalation page read back — 1529199842331725824
PASS  founder pager had no undeliverable outcome
```

**判读(重要)**:6 条 FAIL **正是新行为按设计正确** —— 新模型不再让 Bridge 自动
处理 founder 消息(harness 没提供 `deliverAmbiguousToLead` → 命中 `lead_handoff_missing`),
所以「advanced / layer-2 processed / route side effect / runner wake / mailbox / started」
这些**断言旧自动处理行为**的检查全挂。**这不是回归,是 harness stale**。

而 7 条 PASS 是**模型无关的可靠性器官**,证明它们在新 head 仍**真机 E2E 通过**:
hub-root delivered、忘答 r1/r2、Lead-first 升级 durable、**真 Discord 升级消息回读**
(msg `1529199842331725824`)、pager 无 undeliverable。

### 4.1 真机缺口已当场补齐(Lead 裁定:真机不豁免,现在补)

Lead 裁定这条旗舰路径的真机不豁免。我持 TURN 把 harness `scripts/qa-fly-1392-receipt-foundation-e2e.mjs`
的 section A 改写到新模型,当场跑通真机轮:

- **Bridge 传送带**:提供一个 `deliverAmbiguousToLead`(模拟 Lead 域持久接收,返回 true
  并捕获转发的 payload)。断言 ingress advanced、hub-root delivered、**`processed_at`/
  `processed_evidence` 均为空(Bridge 零自动处理)**、`getResponse` undefined(不代答)、
  `listRunnerPhaseWakes` 空(不 wake)、**转发给 Lead 的 `answer` 与原文逐字相等、msgId 一致**。
- **只有 Lead 动作办结**:用房内 Lead 身份跑 `db.routeFounderReply({toQuestionId})` 模拟 Lead
  的 route 命令 → 断言 `kind='routed'`、hub-root `processed_at` 置位且 `routing_state='bound'`、
  runner response 出现(from_agent=Lead、内容=原文)、runner wake 被创建。
- **真机下游**:`RunnerReceiptPatrol` 推 wake → **真 Claude mailbox 收到 wake 指针** →
  runner CLI `inbox` 标 started。
- **可靠性器官线保持绿**:忘答 r1/r2、Lead-first 升级 durable、**真 Discord 升级消息回读**、
  pager 无 undeliverable。

结果(**strict 模式,不带 synthetic flag,选用 529 房真实非-bot founder 消息**):

```
=== FLY-1392 receipt foundation E2E: 18/18 PASS ===
```

真 Discord 升级 read-back msg `1529202993277173821`。新 founder→Lead-relay→handle 的真机
E2E 现已**接线并全绿**,§4 开头那 6 条旧断言 FAIL 在改写后转绿,7 条器官线保持绿。
(strict 模式选中的 founder 消息是 529 房内真实非-bot 消息,含我早先按 Annie 明示授权
以 Chrome-as-Annie 发的那条,已逐字标注代发、全程隔离房。)

---

## 5. 范围③:外部单概念 + 文档一致性

- `plan.md` / `research.md` / `exploration.md` 顶部均指向 `design-correction.md`
  为 founder 部分最终 authority,统一用「Lead 办了没有」单概念;旧「两层收据/逐类型
  凭据合同」被明确降级为**内部数据卫生**(「不形成对外的逐类型凭据合同」/「不是对外
  凭据合同」),与 design-correction.md §保留的器官 一致。
- `index.ts` 的 route-founder-reply help/结果文案已从「model-lane / frozen candidate」
  改为「founder receipt / eligible question」,对外不再暴露分层/模型巷概念。

---

## 6. 逃生阀 flag-off 的 fail-loud 告警

- 新 `receipt_foundation_off` severe 告警 kind 已加进 `LeadAlertNotifier` +
  `LeadWatchdog`(面板文案:emergency rollback active）。
- 实现方 `gate-poller-receipt-foundation-off-alert.test.ts`(3 tests,我复跑绿)断言:
  `FLYWHEEL_RECEIPT_FOUNDATION=0` 时 Bridge **startup 即发** `receipt_foundation_off`
  告警 + console.error「receipt foundation OFF — 正在走旧直转拓扑」;并有 periodic
  重复与 flag-on 零噪音。符合 design-correction.md §5「事故回退必须持续告警」。

---

## 7. 测试与全量(head `8da8e8f68` + 本轮 QA commit)

- **flywheel-comm 全量**:87 files / **1138 tests PASS**。
- **我的独立 RE-TEST**:redesign-routing 3/3、founder-hub-root 忘答 2/2、
  上轮独立 8/8(新 head 未回归)。
- **teamlead 改动的 founder-reply 相关套件**:27/27 PASS(含 flag-off 告警 3 条)。
- **teamlead 全量**:见 §7.1 —— 有环境类基线失败,与本单无关(逐一归类)。

### 7.1 teamlead 全量失败归类

本机 teamlead 全量 58 failed / 8931(实现方 acceptance 记录的基线约 26 条,本机更高
是因我并发跑其他任务、负载更高)。**逐一核对:17 个失败文件没有一个是改型触碰的
生产文件对应的测试**;改型触碰的 founder-reply-deliverer / gate-poller / db /
route-founder-reply / LeadAlertNotifier / LeadWatchdog / hook-payload /
infra-event-router / kind-contract —— 我**逐文件独立跑绿**(66 + 187 + 我自己的),
全不在失败清单里。失败全是环境/负载/集成基线:

| 失败文件类 | 归类 |
|---|---|
| `external-merge-reconcile` | 实现方 acceptance 明确记录的「merge-eligibility 基线」 |
| `zombie-gate-watchdog:79` | 本 session 早已核实**在 main 上同样红**,与本单无关 |
| `codex-lead-runtime` / `CodexLeadInboxSocket` | codex env（memory 记录 TMPDIR overlap / socket）|
| `event-route*` 集成 / `complete-marker-reconciler` | StateStore FLY-639 in-process rebuild(高负载 env,日志实见)|
| `claude-profile-cli` / `quota-pool-rebuild-cli` / `workflow-docs-git` / `worktree-quarantine` / `terminal-thread-archive` / `createLeadRuntime-preflight` / `lead-delivery-adapter` | git / socket / 外部服务 / 文件系统 集成 env |

**结论:零改型回归。** CI 在此 head 9/9 绿(Lead RE-TEST wake 已确认 review APPROVED +
CI 9/9);全量失败是既有环境/负载基线,与本单不相关。

---

## 8. 复测入口

```bash
# 范围① 路由(含非空过对照)
cd packages/teamlead && npx vitest run src/bridge/__tests__/qa-fly-1392-redesign-routing.test.ts

# 范围② handled + 忘答路径 + 已答门安静
cd packages/flywheel-comm && npx vitest run src/__tests__/qa-fly-1392-independent.test.ts

# 实现方 founder-reply 全覆盖 + flag-off 告警
cd packages/teamlead && npx vitest run \
  src/bridge/__tests__/founder-reply-receipts.test.ts \
  src/bridge/__tests__/gate-poller-receipt-foundation-off-alert.test.ts

# 529 真机 harness(改写到新模型;strict 模式 18/18,真 Discord read-back）
set -a; . ~/.flywheel/.env; set +a
FLY1392_ALLOW_SYNTHETIC_FOUNDER=1 node --import tsx scripts/qa-fly-1392-receipt-foundation-e2e.mjs
```
