# FLY-1392 收据地基 v2(category-agnostic)— 独立 QA 报告

Issue: FLY-1392 (URL 不可得,只写 issue 号)
日期: 2026-07-21
基于: design-v2.md(回炉后唯一 authority)+ Lead v2 全量 QA 开工令(lead-instruction 25cab318)

被测 head: `500389f1`(feat: implement category-agnostic foundation v2)+ 本轮 QA commit `1cf4070a`
判定: **PASS**(四维度 + 9 条能力级验收 + R6 三 gate + 5 条非阻塞 advisory 复核 + 真机 18/18)

---

## 0. 结论摘要(Lead 工单四维度)

| 维度 | 结果 | 依据 |
|---|---|---|
| ① category-agnostic 收据全表 | **PASS** | §1 —— 我的非空过对比 + 实现方 capability(四 lane 无类型规则) |
| ② R6 三切片硬 gate | **PASS** | §2 —— crash seam ×3 + legacy migration + child-id 幂等,52 tests 绿 |
| ③ 5 条 code-review advisory 复核 | **PASS(非阻塞)** | §3 —— 逐条按摘要复核,均不击穿灵魂不变式 |
| ④ 真机能力级 E2E(丢消息→标记→重发→升级) | **PASS** | §4 —— harness 更新到 v2,strict 18/18,真 Discord msg `1529291964086747176` |

宪法级(design §4/§7.8)另单独确认:**Bridge 无条件纯传送带,legacy 代答机器已从代码删除**(§5)。

---

## 1. 维度①:category-agnostic(默认覆盖 + 唯一窄豁免)

我新增独立测试 `qa-fly-1392-v2-independent.test.ts`(3 条,含实现方缺的**非空过**):

- **非空过对比(一次 run)**:一个从没听过的新类型(默认)**被追**到 T3;**同一个新类型**带 `internal_mirror` 豁免**不被追**。若追办是空过的(全追或全不追),这两条必有一条挂 —— 所以它同时证「默认覆盖」+「豁免才是抑制原因」。
- 实现方 capability 测试补充:founder/runner 提问/报告/progress 四 lane 走同一断言组、无类型规则;虚构 `future_widget_v99` 被追 + dry-run 落档。

**结论**:每条真投 Lead 的消息默认有收据、被追;唯一逃生口是窄 `internal_mirror`。Annie 裁定 #3/#4 成立。

## 2. 维度②:R6 三切片硬 gate

`receipt-unprocessed-state-machine.test.ts`(v2,734 行)+ 我复跑确认:

- **三 crash seam**(`:227` "keeps resend child accounting atomic across all three R6 crash seams"):receipt 后 CAS 前 / CAS 后窗前 / 全后,`delivered_rounds` 与最终 T3 精确;
- **legacy migration fixture**(`:309` "migrates legacy reminder fixtures from durable delivery evidence only"):只按 durable delivery evidence 回填 `delivered_rounds`,未投递轮不计;
- **child-id 幂等记账**:同 child id 重放 `delivered_rounds` 不重复计数(CAS 幂等键=child id)。

R6+v2 receipt 套件 **7 files / 52 tests 全绿**。

## 3. 维度③:5 条 code-review advisory 逐条复核(非阻塞)

均来自 v2 code review(已 APPROVED),非阻塞。我按 Lead 摘要逐条复核,**核心判据 = 是否击穿灵魂不变式(消息 durable 记录 / 无静默丢 / 无代答)**:

| advisory | 复核 |
|---|---|
| external episode-stamp coupling | generation-scoped id(`@<episode>`)使旧 generation 行 supersede 而非复活;不击穿(孤儿不追、不重复) |
| 时区渲染 retry 分歧 | resend child 以 generation-scoped **id** 为幂等键,**不靠内容哈希**;内容时区分歧不产生重复行(规避 FLY-218/220);不击穿 |
| default-on 须 capability+dry-run+rollback 门控 | 这是**部署前置**(design §8 S5:flip 不得在 S4 全 gate 前部署),非代码 bug;dry-run 机器(`reconcileReceiptActivation` dryRun)已在;与本单 gate 被按住一致 |
| delivery-processed 审计顺序 | handle = 单 comm.db 事务(response+终态+evidence+wake intent 原子),事务内顺序不产生可观察半态;不击穿 |
| hub-root retry 过严 | v2 founder 单行 producer(caller-supplied deliveryId)+ generation-scoped id;不复用旧 strict-content-equality 卡滞路径;不击穿 |

**结论**:5 条均为非阻塞边角,不击穿灵魂。**default-on flip 是真实部署前置**(需 capability+dry-run+rollback 门,勿在 QA/founder 双绿前翻默认)—— 与 Lead 按住 gate 一致。5 条的逐条**书面处置未在分支文档**(在 code review 输出),建议归档进 design-v2 已知限制,便于后续追溯。

## 4. 维度④:真机能力级 E2E(harness 更新到 v2)

design §7.3 明示「旧 18/18 不作数」。我把 529 harness 更新到 v2 语义:
- markConsumed 用 priority 窗口(`receiptWindowsMs`);
- 加 `reconcileReceiptActivation` 拿 episode,resend child 用 generation-scoped id `<root>#r<n>@<episode>`;
- **故障注入循环**:每轮 resend child 先被投递(claim+markConsumed → `delivered_rounds++`)才进下一轮 —— 这是 v2「round 只在 child 真投递后生效」合同。

**结果(strict 模式,不带 synthetic flag,真 529 房非-bot founder 消息)= 18/18 PASS**:
- founder 消息 → Bridge 纯传送带(记 canonical 行 + 原文逐字转 Lead,零处理);
- 只有 Lead route 动作写办结 + response + wake;真 Claude mailbox 收 wake → runner started;
- **丢消息→标记→重发 r1/r2(generation-scoped)→ Lead-first 升级 durable → 真 Discord 升级 read-back `1529291964086747176`**。

synthetic 与 strict 双模式均 18/18。

## 5. 宪法级(design §4/§7.8):Bridge 无条件纯传送带

代码核实:`founder-reply-deliverer.ts` 的 `processFounderMessage`(442-503)已**无 flag 分支、无 classifier、无 ship-approval、无 respondImpl/wakeImpl legacy 路径** —— 只剩「记 canonical 行 → 转发 Lead → return」。注释:「the chase flag only controls patrol; it cannot change this transport topology.」**legacy 代答机器整个删除**,flag-off 无代答代码可回退。Annie 裁定 #1 结构性成立。

DB 层承重墙(我的突变测试 + 实现方 schema 测试双证):
- **§7.5 豁免只剩 internal_mirror**:`CHECK(receipt_exempt_reason IS NULL OR = 'internal_mirror')` —— 裸 SQL 插 `'telemetry'` 被 DB 拒;
- **§7.4 终态 at-most-one + paired-null**:trigger 拒 both-terminal / 半写 processed / 半写 disposed;
- 豁免审计 append-only(trigger 拒 UPDATE/DELETE);priority 必填 0-3。

## 6. 测试与全量(head `500389f1`)

- flywheel-comm 全量:**89 files / 1142 tests PASS**;
- R6+v2 receipt 套件:7 files / 52 PASS;
- teamlead 跨部门(ExternalReceiptSaga/CodexDiscordGateway/LeadInputRouter)+ deliverer:6 files / 77 PASS;
- 我的独立:v2-independent 3 PASS;
- 真机 harness:strict 18/18(真 Discord msg `1529291964086747176`);
- 实现方对我上一轮 OFF-control 的改动已核实为**正确 v2 适配**(flag-off 现仍 relay 不代答,是更强属性),非削弱。

## 7. 复测入口

```bash
# 独立非空过 + 承重墙
cd packages/flywheel-comm && npx vitest run src/__tests__/qa-fly-1392-v2-independent.test.ts
# R6 gate + v2 receipt
cd packages/flywheel-comm && npx vitest run \
  src/__tests__/receipt-unprocessed-state-machine.test.ts \
  src/__tests__/receipt-foundation-uow.test.ts \
  src/__tests__/receipt-foundation-schema.test.ts \
  src/__tests__/receipt-foundation-v2-capability.test.ts
# 真机能力级(丢消息→重发→升级,真 Discord)
set -a; . ~/.flywheel/.env; set +a
node --import tsx scripts/qa-fly-1392-receipt-foundation-e2e.mjs
```
