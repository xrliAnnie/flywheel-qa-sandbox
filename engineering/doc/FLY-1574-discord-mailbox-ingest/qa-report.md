# FLY-1574 Discord 收编 mailbox — 独立 QA 报告(第 1 轮)

Issue: FLY-1574 (https://linear.app/geoforge3d/issue/FLY-1574/消息层重构-e-批次2-discord-收编不再直推统一走-mailbox)
日期: 2026-08-10
基于: plan.md(R9)+ design-correction.md

**验证 head**: `7ff8c68ad24223db8abcc4ddb48c9586d55c7749`(开工时与出裁定前各核一次,未移动)
**PR**: 主仓 xrliAnnie/flywheel #797(DRAFT)· 插件仓 xrliAnnie/claude-plugins-official #18(DRAFT,head `5bf4045e`)

## 裁定:**FAIL**

在这一版 head 上确认 **4 条阻断级缺陷**,其中 2 条直接命中 issue 自己的验收标准。
另有 2 条中等级。全部为我独立复现,不是转述评审意见。

---

## 前置事实:这一版 head 是实现者自己声明「未到可 QA 状态」的版本

PR #797 正文原话:

> Codex code review R1: APPROVED at `7ff8c68a`; delta re-review required after the must-fix lap below
> **Must-fix in the next lap before QA on the new head:** `transport-stall-alert-hooks-never-wired` /
> `codex-adapter-errors-all-nonexhausting` / `begin-chat-receipt-archived-no-longer-fails-loud` /
> `discord-body-xml-escaped-in-delivery-content`

我没有拿这段当结论。下面 4 条我逐条独立复现取证;结论与它一致,但证据是我自己跑出来的。

---

## B1(阻断)founder 的原话被转义后送进 Lead 上下文 — 命中验收 5

**判据来源**:issue 验收 5「Discord 里的正常对话体验不变」。

### 旧流基线(生产真实形态,非推测)

从生产 Lead transcript 里捞出的真实 founder 入站块
(`~/.claude/projects/-Users-xiaorongli--flywheel-lead-workspace-flywheel-eng-lead/20f3110b-….jsonl`):

```
<channel source="plugin:discord:discord" chat_id="1516209714097291335" message_id="1536457143665037383"
 user="xrliannie_96634" user_id="1138241636057481306" ts="2026-08-10T19:32:09.043Z"
 receipt_id="chat:mufasa-lead:1536457143665037383">
OK，那那个 Claude 根本没有在干活啊，你可以去看他在干什么。
…
</channel>
```

正文**逐字原样**,零转义。这就是 plan §1a 要求的 golden fixture 形态锚。

### 新流实测(跑本 head 编译产物 `dist/discord-chat-ingest.js` 的真函数)

`renderDiscordChatContent()` 对正文无条件跑五实体转义
(`packages/flywheel-comm/src/discord-chat-ingest.ts:23-33, 55`)。实测输出:

| founder 打的 | Lead 实际读到 |
| -- | -- |
| `the new flow doesn't work.` | `the new flow doesn&apos;t work.` |
| `说明 "为什么" & 怎么避免` | `说明 &quot;为什么&quot; &amp; 怎么避免` |
| `rg "carrier='external'" && echo a<b>c` | `rg &quot;carrier=&apos;external&apos;&quot; &amp;&amp; echo a&lt;b&gt;c` |

**为什么是阻断**:英文句子里的撇号、中文引号、`&`、以及她粘贴的命令行,是她每天消息的常态。
第三行尤其严重 —— 她粘一条命令让 Lead 去跑,Lead 拿到的是**跑不了的**字符串。

**这条转义确实送到模型眼前,不是内部字段**:`lead-inbox-loop.ts:362,371` 两处
`row.delivery_content ?? row.content` 直接进 `modelPayload`。

**修的方向(重要,别改反)**:plan §1a 要求「正文中伪造 `</channel>` 不可能被读成结构」——
所以**不能**简单删掉转义。缺陷是**无条件五实体全转义**,把普通散文和命令一起腌了。
正确形态 = 只中和会破结构的序列,普通文本(`'` `"` `&`)保持逐字。

**测试反而把缺陷锁死了**:`discord-chat-ingest.test.ts:67`
`expect(row.delivery_content).toContain("&lt;/channel&gt;")` —— 断言的是转义后的样子。
plan §1a 明写形态锚必须是**真实旧链路捕获的 golden fixture**;这一步没做,所以整组测试
14/14 全绿却完全测不出这个洞(空过绿测)。

**附带**:新渲染发 `source="discord"`,生产实际是 `source="plugin:discord:discord"`。同属形态漂移。

---

## B2(阻断)Codex 侧任何投递失败都永不耗尽 + 告警钩子在生产根本没接线

这是两个改动叠在一起形成的复合故障,单看任一处都不致命,合起来 = **静默无限重试**。

### B2-a 适配器把所有失败都归成「Lead 级不可用」

`lead-delivery-adapter.ts`:`submitCodexLeadInboxBatch` 的 catch **无差别**包成
`LeadDeliveryUnavailableError("lead", …)`。

`lead-inbox-loop.ts`:`nonExhausting = leadUnavailable || discord` →
`maxAttempts: Number.MAX_SAFE_INTEGER`。

于是:① Codex 侧几乎任何 submit 失败都判成 lead-scope 不可用;② 且所有 Discord 行本来就无条件非耗尽。
一条真·毒行(非 route_parse、非 membership_conflict —— 那两类另有 `quarantineDiscord` 兜住)
会**永远重试**,不进 DEAD、不进 quarantine、不放行队头。
plan §1g 只允许 **transport unavailable** 非耗尽,并明确要求第 (c) 类先告警再 quarantine。
这正是 plan 自己命名要防的 poison-row claim wedge。

### B2-b 告警钩子在唯一生产接线点没传

`onModelTransportStall` / `onModelTransportRecovered` 全仓引用:

```
src/bridge/lead-inbox-loop.ts        # 定义 + 调用点
src/bridge/__tests__/…test.ts:450    # 只有测试传了
```

唯一生产构造点 `lead-inbox-runtime.ts:143 new LeadInboxLoop({…})` **没有传这两个回调**。
即 §1g 设计的 stall 告警在生产是死代码。

**合起来的后果**:Codex Lead socket 一挂 → 行永不耗尽 → 且一条告警都不发 →
founder 的消息卡在队里,系统对外**完全安静**。
本单存在的理由就是「founder 消息零丢失 / 03:57 事故」,这个组合把事故形态原样复刻了一遍。

---

## B3(阻断)priority 违反已批准设计,倒转同会话顺序

plan §1b 明写 **priority 统一为 1**,§7.9 复述「Discord priority 统一 1 以保留同会话 seq」。

实现两处都是 `priority: founder ? 0 : 1`
(`discord-chat-ingest.ts:72, 90`)。

claim 排序是 `ORDER BY priority, seq`(`mailbox-queue.ts:729,737,760,775,814,840,879`)。

所以同一会话里:别人(或另一个 Lead)先发的 priority 1 消息还在队里,founder 后发的 priority 0
会**插到它前面**送达 → Lead 看到的对话顺序是倒的。这正是 plan 统一 priority 想避免的。

测试同样把它锁死了:`discord-chat-ingest.test.ts` 断言 founder 行
`toMatchObject({ from_agent: "founder", priority: 0 })`。

PR 正文把这条放进「recorded for later triage」。但它是**对已批准设计的偏离**,
且影响 founder 每天那条链路 —— 按 QA 口径它不是可延后项,要么改回 1,要么先拿到 Lead/founder
对改设计的显式批准。

---

## B4(阻断)archived 车道静默吞消息,不留任何证据

`beginChatReceipt` 原本命中 archived 会硬抛
(`chat receipt was already archived: …`),现在改成返回 `{ lane: 'archived' }` 静默成功。

plan §0b 表里「begin + archived → 跳过」本身是设计内的,**问题在证据面**:
插件拿到成功 verdict 就删 intent,而 archived 既不产生 `chat:` inbox 行、也不产生任何结构化告警。
plan §5 第 2 条要求每个 ingress id 必须有 **inbox 行 或 结构化证据**,二者必居其一。
这条路径两样都没有 = 一条 founder 消息可以无声消失且对账脚本查不出来。

---

## M1(中)硬检查脚本算了 DEAD 却不卡 DEAD

`scripts/audit-discord-mailbox-ingest.sh` 查出 `dead_rows` 并打印,但退出判据是
`bad_rows || external_rows || duplicate_rows || missing_ingress` —— **不含 `dead_rows`**。
plan §3.2 第 4 条要求「Discord DEAD 必须有 undeliverable 告警证据」。
现在脚本对 DEAD 行只报不拦,自己的合同没兑现。

## M2(中)`source` 属性值与生产不一致

见 B1 末尾:`source="discord"` vs 生产 `source="plugin:discord:discord"`。
同源于「golden fixture 没真抓」。

---

## 我跑了什么 / 没跑什么(honest boundary)

**跑了**:
- 本 head 编译产物的**真函数** `renderDiscordChatContent` 对 3 组真实 founder 句式的实测输出(B1 铁证);
- 生产 Lead transcript 里真实旧流入站块的提取,作为旧流基线(非推测、非合成 fixture);
- 全仓 grep 确认 stall 钩子在唯一生产构造点未接线(B2-b);
- 源码 + claim SQL 排序确认 priority 倒序机制(B3);
- 定向单测:`discord-chat-ingest.test.ts` + `chat-receipt.test.ts` **14/14 全绿** ——
  这恰恰是本报告的一个发现:绿测锁死了 B1 与 B3 的缺陷形态。

**没跑,以及为什么**:
- **FLY-529 QA Room 的真 Discord N-to-N 这一轮没跑**。本单是 Discord-capable,529 N-to-N 是我
  PASS 的硬前置,不是可选项。这一轮跳过的唯一理由是:head 上已确认 4 条阻断缺陷(含 founder
  可见的内容损坏),修复必然改渲染与投递路径,现在跑出来的房内证据到下一版即作废。
  **修复 head 到位后,我会在出任何 PASS 之前先跑完 529 N-to-N**(Q1–Q10 全表 + ON/OFF/ON 回切),
  这一条不会被省。
- FLY-1573(D 单,批次/租约)PR #798 仍是 DRAFT 未合 → issue 验收 2「60 秒内 3 条合成一次收到」
  这一版**结构上不可能验**;plan §3.1 Q2 已把「D 未合则如实记录批次形态」写进预案。
- 插件仓 PR #18 我只核到 ON 路径存在(`chat-receipt-runtime.ts` +386),没有逐行验 ——
  因为主仓 head 已判 FAIL,插件侧留到修复轮一并验。

## 复验入口(修复后我按这个跑)

1. B1:拿本报告 3 组句式重跑真函数,输出必须逐字等于输入;并把 golden fixture 换成本报告第一节
   那个真实生产块。
2. B2:`grep -rn "onModelTransportStall" packages/teamlead/src/bridge/lead-inbox-runtime.ts`
   必须命中;毒行注入后必须在有限次内进 quarantine 且发出告警。
3. B3:`priority` 必须为 1(或出示改设计的显式批准)。
4. B4:archived 分支必须留下可对账的结构化证据。
5. M1:审计脚本退出判据补 `dead_rows`。
6. 然后才是 FLY-529 N-to-N 全表 + 生产验收环(§3.2 第 7 条 ON→OFF→ON 行为实测)。
