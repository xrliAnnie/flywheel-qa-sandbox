# FLY-1392 捕获(纯事实清单):实现现状 · founder 裁定原话 · 真机证据 · 覆盖边界
Issue: FLY-1392 (URL 不可得,只写 issue 号)
日期: 2026-07-21
整理者: QA(Opus)· 用途: 交 Fable 设计者做 v2 设计的**事实输入**

> **本文档是纯事实清单,零设计提案。** 由 QA 整理「现有代码里什么在跑 / 被今天 founder
> 裁定废除了什么 / founder 裁定原话 / 三轮真机证据 / 我 grep 核实过的覆盖边界」。
> **不含任何方案倾向、建议、留删改判断** —— 那些归设计者。设计由 1392 designer 用 Fable 做。

---

## 1. 现有代码事实(逐项,零评价)

### 1a. 现在代码里在跑什么(截至分支 head `9a0621f7f`)

| 项 | 现状 | 锚点 |
|---|---|---|
| founder 消息路由 | `receiptsEnabled` 时早返回:记 hub-root(delivered)+ 原文转发 Lead,不代答/不建 wake | `founder-reply-deliverer.ts:581` |
| founder→Lead 中转 | append lead_event + dispatch 给 Lead 会话 | `gate-poller.ts:4054` `makeAmbiguousHandoff` |
| Lead 办结动作 | `route-founder-reply` 写 response + processed_at + wake intent(唯一写办结的路径) | `db.ts:2008` `routeFounderReply` |
| founder hub-root 入账 | 每条 founder 消息一行,delivered | `db.ts:1837` `enqueueFounderHubRoot` |
| 未处理轴 | 到期重发 r1/r2 → 升级 | `db.ts:3324` `advanceDueUnprocessedReceipts` |
| 办结推导 | 从 response 副作用推 processed(已答门不催) | `db.ts:3152` `deriveProcessedReceipts` |
| 队列顺序 | 单消费者,`ORDER BY priority, seq` | `lead-inbox-queue.ts:586` |
| 唤醒台账 | `runner_phase_wakes` + T1/T2/T3 梯 | `runner-receipt-patrol.ts` |
| 告警出口 | `receipt_alert_outbox` 两阶段、id 幂等恰一次 | `db.ts`(receipt_alert_outbox) |
| 逃生阀 | `FLYWHEEL_RECEIPT_FOUNDATION` 默认 `true`;`=0` 时 Bridge 启动即发 severe 告警、每小时重复 | `config/.../receipt-foundation.ts`;`design-correction.md §5` |
| 真机 harness | founder→Lead-relay→handle E2E(copy-model) | `scripts/qa-fly-1392-receipt-foundation-e2e.mjs` |

### 1b. 被今天 founder 裁定废除的(事实:裁定废除,非我建议)

- 「已送达 / 已处理」作为**两个对外收据层级**的叙事(裁定:对外只留一层「Lead 办了没有」);
- 按消息类型的 **evidence 合同表**(裁定:降为内部数据卫生,不作对外概念);
- **founder F-2/F-3/F-5 的 `bridge-protocol` 自动对号直转**(已在 copy-model head 删除);
- 「歧义才交 Lead / 协议层就是 Lead 枢纽」的表述。
- （裁定还要求覆盖变 category-agnostic —— 见 §4 的现状事实。)

---

## 2. Founder 裁定原话(2026-07-21,issue thread,逐字)

> **消息 id(Lead 在场记录补齐,lead-instruction 68ebe4a6-65b8-4432-83b7-716b8b46698e)**:
> 照抄 claude-code 模型 = `1529180997403410454`;收据只做一层防漏 = `1529181179960365238`;
> category-agnostic/到账处理与消息种类分隔 = `1529211733363785768`;
> A 路径确认 = `1529214547016155176` 与 `1529215670045249727`;Opus 不做设计 = `1529216092730294382`。
> (裁定 5「地基先做对」出自 issue 描述,非 Discord 消息;裁定 4「generic 默认」未在 Lead 清单单列,
> 内容属 category-agnostic 裁定同流,不另行指认 id。)

1. **完全照抄 Claude Code 拓扑**(msg `1529180997403410454`):
   > 「为什么中间会出现所谓『把我的话直接传给 teammate』这么一条处理线呢?包括它的控制面是永远过 Lead,然后什么权限请求,就是这些永远过 Team Lead……我们需要的是完全照抄他们的模型,而不是发明一种新的东西出来。」
2. **一层收据,目的=防漏**(msg `1529181179960365238`):
   > 「我不知道他们有没有做这么一套收据系统。如果没有做的话,我们只需要做一层收据系统,确保 Lead 不会因为底下有太多消息而漏掉处理,仅此而已。剩下的所有东西都要完全和他们一样:只要有信息进来,就直接转给 Lead 让他来处理,而不是让 Bridge 自己去处理。」
3. **message category agnostic(核心)**(msg `1529211733363785768`):
   > 「不管是谁发的 message,传到 Lead 这里,都是要处理、都是要有收据的。不能说有的 message 有,有的 message 没有;或者有的种类的 message 有,有的种类的 message 没有。你这个东西必须是一个 message category agnostic 的。不管是谁发来的 message,我们都要做这个到账的处理。」
4. **默认朝覆盖,防新类型漏**:
   > 「不能说我们今天把这几个 category 的消息都确定可以报账了,过两天加了一个新的 message 种类,它又不能报账了,这样子是不行的。你尽量把这个东西做成 generic 的。」
5. **地基先做对**(原始 1392 框架,issue 描述):
   > 「所以通用解法是收据机制……把凭据这一部分做好之后是我们的根基,必须是先来做清楚,然后我们之后的 issue 才可以去做。」
6. **QA(Opus)不做设计**(模型纪律;msg `1529216092730294382`):
   > 「我不希望 1392 用 QA 来做设计,因为他的 QA 是 Opus,我们不会用 Opus 来做设计。如果要做设计的话,一定要让 1392 的 designer 来做设计,让他用 Fable 来做设计。」

---

## 3. 三轮真机证据索引(head / 测试名 / 结果)

| 轮 | head | 测试 | 结果 |
|---|---|---|---|
| R1(旧两层模型) | `11ef1532a` → `bd14d7dba` | `qa-fly-1392-receipt-foundation-e2e.mjs`(旧断言) | 隔离 529 真机 13/13;R1 抓出 HIGH「被别人答掉的门仍被催」,`bd14d7dba` 修复(四处 disposal 谓词逐处突变验证)。真 Discord msg `1529053499927560232` / `1529059725931577446` |
| 意图级 | `bd14d7dba` 系 | 同 harness strict + 意图级 SQL | Annie 真实回复(Chrome-as-Annie 授权代发,msg `1529147123554189496`)→ 一条 SQL 查到两层收据;真 Discord read-back |
| R2(照抄模型 / copy-Claude-Code) | `8da8e8f68` → `9a0621f7f` | `qa-fly-1392-redesign-routing.test.ts`(3)+ `qa-fly-1392-independent.test.ts`(10)+ 改写后 harness | 单测全绿;**harness strict 18/18**(真 founder 消息 + 真 mailbox + 真 Discord msg `1529202993277173821`);逐字断言 Bridge 纯传送带(转发 answer 与原文相等)+ 只有 Lead route 写办结 |

补充事实:R2 相对 R1 只改路由/收据语义(copy-model),flywheel-comm 全量 1138 tests 绿;teamlead 改型触碰文件的测试独立跑绿(66 + 187 + QA 的 3+10);CI 在 `9a0621f7f` 9/9 绿;codex review approved。

---

## 4. 覆盖边界(grep 级事实:哪些 lane 进账本、哪些不进)

| lane | 现状事实 | 依据 |
|---|---|---|
| founder 消息(`founder_reply` / `founder_reply_ambiguous`) | 进 `lead_inbox`,有 delivered + 可被推 processed + 未处理轴追办 | `enqueueFounderHubRoot`(`db.ts:1837`) |
| runner 提问(`runner_question` / `gate_question`) | 进 `lead_inbox`;「办了」= response 行存在(`deriveProcessedReceipts` 要求 `from_agent = to_lead`) | `db.ts:3152` |
| runner 唤醒工单 | 进 `runner_phase_wakes`;started = runner 第一个 CLI 动作 | `runner_phase_wakes` |
| 报告类(`session_completed` / `qa_result` / `codex_review_result` / DONE / `ask --report`) | 进 `lead_inbox` 记 delivered,但 **`research §3` 明写「不要求 processed,delivered 即终态(P2)」→ 不追办** | `research.md §3`;`ask.ts:18`(copied to lead_inbox) |
| 纯遥测(`progress`) | delivered 即终态,永不追 | `research.md §3` P3 |
| **其他 Lead 跨部门 / roundtable 消息** | **不进 `lead_inbox`**,经 Discord plugin 直达 Lead,无收据行 | grep 事实:`roundtable`/`cross-dept` 无 `enqueue`/`lead_inbox` 命中 |
| 新增消息类型的默认 | **默认不进入办结巡检**(`research §3`:「新类型默认不进入办结巡检」,fail-safe 朝不催办) | `research.md §3` |

（以上是当前**现状事实**,不含「应该怎么改」的判断 —— category-agnostic 目标的设计由 Fable 设计者做。）
