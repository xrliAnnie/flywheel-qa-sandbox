# Design Review — plan.md (Round 1)

Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案总体可落地，且 v2 已正确吸收上一轮的大部分关键意见：现有 FLY-2830 基线确实提供了共享 single-flight、协作式 abort ceiling、切号后的独立 `allSettled` 腿、页面读取测试缝和 GatePoller 调度点；已安装的 `gog` 也确认为 v0.10.0 / `a92bd63`，计划里的 search/get 命令、分钟级 UTC 日期、退出码和 dotted `--select` 返回键均有源码依据。

但仍有两个会产生错误账单结论的阻断缺口：持久化读数在页面消费时没有重新绑定当前邮箱身份；正文扫描达到 6 封或元数据页被截断时，计划仍会断言 `no_receipt` 或展示不完整的“同周期总额”。另有隐私边界描述与 gog 实际行为不一致，以及新旧订阅状态只做单向仲裁的问题。修正这些契约后无需改变总体架构。

## What's Good (Keep)

- 保持 Bridge 单进程所有权，复用 `account-quota-refresh.ts`、`switch-refresh-trigger.ts` 和 GatePoller，不新增 timer/daemon；三个触发入口共用一个收据 single-flight，方向正确。
- `accounts` 读失败整轮不写、observer 硬上限后不落盘、各腿 `allSettled` 隔离，能避免空 store 覆盖和 Bridge 主刷新链被单个邮箱失败拖垮。
- 两阶段读取、`execFile` 无 shell、固定 query、消息 ID/邮箱校验、From 整串锚定和主题锚定都合理；失败原因和日志内容均收敛到白名单码。
- 独立 closed-shape store、读写共用 validator、写前自检、0600 原子替换，以及正文/stderr 不入 store/日志，符合最小持久化原则。
- 页面把收据读取时间从 `sources` 中拆出，同时仍让 `sources.charge` 只承担切号标记，解决了已取消/不可用/缺号行没有 `sources` 的基线冲突。
- TDD 顺序覆盖了解析、存储、observer、scheduler、三条刷新路径、view/page 和端到端渲染；真实邮箱验收与破坏授权的失败测试也分开处理，边界清楚。

## Issues & Recommendations

1. **BLOCKER — `mailboxKey` 只保护 `lastGood`，没有保护页面当前采用的 `facts` / `free` 状态。**

   - 问题：计划把 store 以账号 `name` 关联页面，并只规定“邮箱换了就丢弃 `lastGood`”。`account-quota-view.ts` 已经能拿到当前 `claudeEmails`，但计划没有要求在消费任何持久化 reading 前比较当前邮箱 digest 与 `reading.mailboxKey`。因此同名 profile 改绑邮箱后，旧邮箱的扣费日、金额、取消状态或 `free` 状态仍会显示到新身份上，直到一次新 observer 成功写盘。
   - 证据：现有手填订阅已通过 identity key 做消费侧绑定；相反，本方案只在 observer 构造下一份 store 时检查 mailbox key。`quota-guard identity-set` 会直接改 `identity.email`，但不增加 switch generation，所以不能依赖 FLY-2830 的切号触发立即清掉窗口；失败的下一轮也不应让旧身份事实继续可见。
   - 为什么重要：这是跨账号事实错绑，不只是“读数稍旧”。旧邮箱的取消/金额会被归到另一个当前账号，违反页面事实的身份完整性，也削弱 `mailboxKey` 本来要提供的保护。
   - 建议修复：把邮箱 canonicalization + digest 提成共享纯函数；在 view（或读取 store 后的投影层）要求当前邮箱与 `mailboxKey` 匹配后，才允许使用当前 `facts`、`free`、`lastGood`、`receiptReadAt` 和 `sources.charge`。不匹配时按“邮箱已变更，待重读”或从未读到处理，且切号标记保持未刷新。补测试：不运行/运行失败的 observer 前先改同名账号邮箱，旧事实绝不能渲染。

2. **BLOCKER — 有界扫描耗尽被误报为“没有收据”，并可能把部分金额当成同周期总额。**

   - 问题：计划只取前 40 条元数据、最多读取 6 封 receipt body，但 `no_receipt` 没有“已穷尽候选”前提。非订阅 extra-usage/API-credit 收据与订阅收据共享同一个 sender/subject，必须读正文后才能区分。只要最新订阅收据前面有 6 封这类收据，就会在没有检查 L 的情况下返回 `no_receipt`。若前几封后找到了 L，但预算已耗尽，较早的同周期升级补差收据也可能没读到，页面却仍把已读子集之和展示成“同周期 Amount paid 之和”。search 的 `nextPageToken` 也没有截断语义。
   - 证据：research 和现有代码都承认 extra usage/prepaid 是真实产品形状，真实 business/shopping 又确有同周期两张升级收据。并行实现的测试已经把“8 封 extra receipt，只读 6 封，结果 `no_receipt`”固定下来，直接证明当前计划会把预算耗尽和邮箱确实没有收据混为一谈。
   - 为什么重要：这违反 exploration 的硬约束“读不到就写真实原因，不猜”，并会同时影响核心扣费日和金额可信度。
   - 建议修复：为候选/分页预算耗尽定义明确的 fail-closed 状态或原因（如 `candidate_limit` / `search_truncated`），沿用合格的 `lastGood`，绝不能写 `no_receipt`；或者做有界分页直到找到 L 且越过本周期边界。找到 L 后若无法证明同周期候选已完整扫描，金额应为 `null`（或增加显式 incomplete 字段），不能展示部分和。补三类测试：6 个 non-subscription 候选后才出现 L；L 后预算耗尽且仍有同周期第二张；返回非空 `nextPageToken`。

3. **SHOULD — §6 对 gog 数据边界的描述不准确，需按进程边界如实写明并决定是否需要更窄的投影。**

   - 问题：计划称 metadata search 的模糊命中“最多只有发件人/主题/日期进内存”，并称 get 的 `--select` “只取正文与两个头”。`gog@a92bd63` 实际上让 search JSON 含 `id`、`threadId`、`labels`、`nextPageToken`；它还会读取 label 映射。对 get，`--select` 是 `outfmt.WriteJSON` 前的本地输出变换：`gmail_get.go` 先以 `format=full` 取得 message、构造 headers/body/attachments payload，之后才筛成 dotted keys。它限制的是 stdout/Bridge 进程看到的字段，不是 Gmail API 或 gog 子进程读取的字段。
   - 为什么重要：founder 的授权边界明确列了允许提取的字段。当前持久化和日志仍然是安全的，但方案对短暂内存暴露的陈述不真实，不能据此完成隐私 sign-off。
   - 建议修复：在计划中区分 Gmail API → gog 子进程、gog stdout → Bridge、Bridge → store/log 三个边界；明确 message ID 是临时定位符。若现有授权只约束落盘/日志，应记录接受的残余风险。若也约束 subprocess 内存，则需给 gog 增加不取 label/attachment metadata 的窄读取能力。至少让 search stdout 使用字段投影（同时保留/替代截断检测），并对 stdout 不含 threadId/labels 增测试；不要把 `--select` 描述成远端字段投影。

4. **SHOULD — 邮件与 OAuth 明细的状态合并是单向的，`free` 判定也可能被并行刷新固化为旧状态。**

   - 问题：§5 允许较新的 OAuth `canceled` 覆盖收据 `ok`，但不允许较新的 OAuth `active` 清掉更早的取消邮件。如果 resume 邮件迟到、模板变化或落在截断外，页面会在明细已经重新确认 active 后仍显示已取消。类似地，持久化的 `free` 无条件高于当前明细；而按需刷新和切号刷新把 detail 腿与 charge 腿并行启动，charge target 可能刚好读取上一版 tier，导致 free↔paid 变化至少延迟到下一轮收据读取。
   - 为什么重要：计划已经选择“按观测时间合并两个来源”，但目前只对一种方向应用该原则，因此会把较旧的邮件/派生状态置于较新的当前账号状态之上。
   - 建议修复：定义统一的 latest-known-state 仲裁：只有带有效 `detailObservedAt` 的明确 active/canceled/tier 才参与，并与 receipt/cancel/resume 的最新时间比较；较新的 active 应能清掉较旧 cancel，较新的 paid/free tier 应能使旧 `free` 失效。或者明确说明为何要故意 fail-closed 为 canceled，并让页面显示“来源冲突”而不是确定结论。补 cancel mail → newer active detail、old free → newer paid detail，以及 detail/charge 并行刷新时序测试。

5. **NIT — 调度验收应钉住真正的 Pacific calendar 运算，并把 `lastGood.readAt` 纳入时钟回拨检查。**

   - 问题：计划写的是 `periodEnd` 次日 00:05 America/Los_Angeles，但测试表只说“三条规则”，没有要求 PST/PDT 各一例。并行实现目前用固定 08:05 UTC，夏令时会在 01:05 PDT 才运行。另一个遗漏是 future-skew 只检查 `generatedAt` 和当前 `readAt`；时钟回拨后新一轮失败、沿用一个未来的 `lastGood.readAt` 时，48 小时兜底可能被错误延长。
   - 建议修复：在计划中明确用时区日历转换而非固定 UTC 小时，并新增冬/夏各一例；future-skew 校验和 view 的 48 小时判断同时覆盖 `lastGood.readAt`，未来读数不参与兜底。

## Verdict

**CHANGES REQUESTED**。总体架构、gog 基本调用和安全写盘路径可以保留；批准前必须先补齐 #1 的消费侧邮箱身份绑定，以及 #2 的候选预算/分页耗尽语义，避免跨账号错绑、虚假的 `no_receipt` 和部分金额冒充总额。#3–#4 应在同一版计划中明确，以便隐私授权和状态仲裁可验收；#5 可作为实现验收收口。
