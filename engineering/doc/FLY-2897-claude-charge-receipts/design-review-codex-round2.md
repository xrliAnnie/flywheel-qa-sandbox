# Design Review — plan.md (Round 2)

Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 已经实质关闭 Round 1 的邮箱身份错绑问题，并把 gog 的三段数据边界、取消状态的保守仲裁、Pacific 时区换算和未来 `lastGood` 检查写清楚。实现与计划在这些点上基本一致；我只读运行了 6 个相关测试文件，共 160 项，全部通过，且未访问真实邮箱。

但仍有两个会影响核心账单结论的缺口。第一，`free` 的新旧比较使用收据腿的完成时间，而 `free` 实际来自收据腿启动时读取的 account-detail 快照；并行刷新可以把旧套餐状态盖上新时间戳。第二，`--max 41` 的第 41 行不是可靠的分页穷尽证明，且实现用邮件 `Date` 头推断 Gmail 未返回页的时间范围；这不能证明截断页后没有同周期收据。因此 v3 仍可能显示错误的“免费号”或把部分金额当作完整总额。

## What's Good (Keep)

- 消费侧现在用当前 `claudeEmails[name]` 与 `mailboxKey` 比对，并同时阻断 `facts`、`free`、`lastGood`、`receiptReadAt` 和 `sources.charge`；同名账号改绑邮箱后会 fail closed。对应 view 与 route 测试也覆盖了真实接线。
- `candidate_limit` / `search_truncated` 将“扫描预算耗尽”和“确实没有收据”分开；正文预算耗尽时不再直接写 `no_receipt`，方向正确。
- §6 已准确区分 Gmail API → gog、gog stdout → Bridge、Bridge → store/log 三道边界，也明确 `--select` 是本地输出投影。把 subprocess 内存残余风险交给 Lead/founder 显式确认是合适的产品授权收口。
- 不让较新的 detail `active` 清除取消邮件是合理的：cancel-at-period-end 在到期前仍可能是 active；只有 resume 邮件或更新收据才是明确的重订证据。计划已把这个有意的不对称写成可测试契约。
- scheduler 的两次偏移换算能得到真正的 Pacific 00:05；我另外核算了 2026 年春秋 DST 切换日，结果分别为 `08:05Z` 和 `07:05Z`。`lastGood.readAt` 也已纳入 future-skew 与 view 兜底检查。
- single-flight、硬/软上限、原子 0600 store、固定错误码日志和刷新腿故障隔离均延续现有架构，没有扩大 Bridge 主链路的故障域。

## Issues & Recommendations

1. **BLOCKER — `free` 仲裁比较的是派生结果的完成时间，不是套餐信息的观测时间。**

   - 问题：`claudeChargeTargets` 只把旧 detail store 投影成 `free: boolean`，丢掉了该 tier 的 `observedAt`；observer 完成后再把当前时间写进 `charge.readAt`。view 随后用 `detailObservedAt > charge.readAt` 判断哪边更新。`charge.readAt` 只证明“何时完成这次收据腿”，不能证明“何时观察到 free/paid tier”。
   - 可复现时序：旧 detail 是 free；按需刷新在 `account-quota-refresh.ts` 中并行启动 detail 与 charge 两腿；charge 从旧文件构造 `free: true` 并跳过 gog，新 detail 同轮观察到 paid；charge 随后写入更晚的 `readAt`。页面会把旧 free 当成较新事实，仍显示“免费号，无扣费”。反向的 old paid → new free 在 charge 读邮箱较慢时也会被较晚的 charge `readAt` 压住。切号路径同样在 `switch-refresh-trigger.ts` 中并行两腿。detail 探测失败并沿用旧 tier 时，daily charge 还会把旧 free 重新盖上当天时间戳。
   - 为什么重要：这正是 Round 1 #4 指出的“并行刷新固化旧 free”；v3 的 isolated view 测试只手工构造了时间戳，没有覆盖时间戳的来源，因此没有真正关闭问题。
   - 建议修复：不要用 charge 完成时间为 tier 排序。最小方案是把用于跳过 gog 的 detail `observedAt`（以及该轮 detail 是否成功）随 target/reading 传递，free 仲裁只比较 tier 自身的观测时间；或者让页面以当前有效 account-detail tier 为 free/paid 的权威来源，charge store 不再把 `free` 当成独立新事实。按需刷新和切号刷新还可在 fresh detail 写入后再构造 charge targets，但仍需避免 daily scheduler 把失败后沿用的旧 tier 刷新成“今天的 free”。增加两条 orchestration 级测试：old free → 同轮 fresh paid，以及 old paid → 同轮 fresh free；两种腿的完成顺序都要覆盖。

2. **BLOCKER — 元数据页的“已穷尽/已越过周期下界”证明仍不成立。**

   - 问题一：`gog@a92bd63` 的 search envelope 本来提供 `nextPageToken`，但 `--results-only` 将它丢弃。请求 `--max 41` 后只以数组长度是否为 41 判断截断，把 API 的最大返回数当成了必须填满的页大小；返回少于 41 行但仍带 continuation token 的合法响应会被误判为 exhaustive，重新产生虚假的 `no_receipt`。
   - 问题二：找到 L 后，代码以首 40 行中任意消息的最小 `Date` 头（甚至在精确 From/Subject 分类前）或已排序 receipt 的 `Date` 头越过 floor，推断未返回页也在 floor 之前。gog 先通过 Gmail list 取得 id，再单独读取并格式化邮件 `Date` 头；分页顺序并没有按这个头字段建立的契约。一个模糊命中的旧 `Date` 头就能让 `oldestMs < floor`，即使 continuation page 仍有本期补差收据，当前实现也会保留部分 `amountCents`。
   - 为什么重要：这是 Round 1 #2 的剩余部分。新原因码解决了显式的 6-body/41-row 用尽分支，但“完整金额”的证明仍可被不相关元数据或分页形状绕过。
   - 建议修复：保留并验证 search envelope 的 `nextPageToken`，以 token 而不是 sentinel 行数作为是否穷尽的依据。只要 token 非空，就不能用当前页的 `Date` 头证明后续页已越过 floor：若不做有界翻页，找到 L 时应令 `amountCents = null`，没找到 L 时应为 `search_truncated`；若要保留完整金额，则继续有界翻页，直到以 Gmail 明确定义的排序键证明越界。同步补测试：少于 41 行但 token 非空；首屏含一个旧 Date 的模糊命中、后页仍有同周期收据；两者都不得产出 `no_receipt` 或完整金额。

3. **NIT — `receiptCount` 在不完整扫描时不是计划所称的“同周期收据张数”。**

   - 当前测试已固定“预算在本期内耗尽”时 `amountCents: null, receiptCount: 2`，即使还存在第三张同周期收据；但 schema 注释把它定义成同周期总张数。
   - 建议把字段明确改名/注释为 `observedReceiptCount`，或在扫描不完整时让它可空/配套 `periodComplete`。虽然当前页面不展示该字段，但持久化 facts 不应让后续消费者误当成总数。

## Verdict

**CHANGES REQUESTED**。Round 1 的邮箱绑定、隐私边界、取消仲裁解释和时区问题可以关闭；批准前仍需让 free/paid 仲裁使用真实的 tier 观测时间，并让分页穷尽与周期完整性建立在 `nextPageToken` 和可靠排序契约上。否则同一次并行刷新仍会固化旧套餐状态，截断搜索也仍可能把部分金额冒充总额。
