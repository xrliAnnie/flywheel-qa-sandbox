# Design Review — plan.md (Round 4)
Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮严格只复核授权的两项。Round 3 的 retry-counter 问题已经解决：pending 身份和 attempts 绑定、覆盖时归零、同 ID/重启后续计、ack 清空，测试和 §10 三键列表也一致。

新增 §6.5 的目标与 fail-open 方向正确，但当前合同尚不能保证页面始终“如实”：状态更新没有绑定具体切号事件，旧轮可回写覆盖新轮且重启后 `running` 会永久冒充进行中；单个 `bridgeRefresh` 与单个 Codex `observedAt` 也无法表达实际的分路/分数据源结果，会漏标旧的 Codex subscription 读数或误标成功分路。文件边界与 HTML 转义还需写成可实施的明确合同。因此 verdict 为 CHANGES REQUESTED。

## What's Good (Keep)

- §6.2 现用 `pendingSweepRequest: {requestId, attempts}` 把计数绑定请求；新 ID 覆盖重置、同 ID 延续、任意 ack 清空 pending，正面闭合了 Round 3 反例（§6.2:153–157）。
- §6.4 已覆盖“A 失败两轮后被 B 覆盖”和“A 失败一轮后 daemon 重启续计”，并保留 ack 后不再强制处理、闸门不计次等边界（§6.4:188–189）。§10 的新增键和回滚删除列表均已改为 `pendingSweepRequest`（§10:253–255）。
- §6.5 选择独立、持久、限长的本地状态文件，给出 0600/0700、原子覆盖、严格 schema，并明确坏文件不能拖垮页面。这是满足重启后仍可识别旧读数、且不给页面增加刷新等待依赖的正确基础。
- 行级规则已区分 Claude usage 与 card/detail，并排除持久化 `unavailable` 账号；现有 `QuotaCell.observedAt` 也为更精确的来源级标注提供了现成数据（`account-quota-view.ts:39–47`）。

## Issues & Recommendations (numbered: issue, why, fix)

1. **状态文件没有切号事件身份和条件更新规则，旧刷新轮可污染最新状态；重启后的 `running` 也不再真实。**

   **Why:** §6.1 明确允许“进行中再来请求”并尾随一轮，而且 sweep/Bridge 两路独立结束（§6.1:123–126）；§6.5 却只有 `{vendor, generation, switchObservedAt}`，只说两路结束后更新同一个“最近切号”文件（§6.5:172–178）。场景 A：切号 A 写 `running`，切号 B 覆盖文件，随后 A 的异步 completion 回来；没有 event identity + conditional update，A 可以把 B 标成 `ok`/`failed`，两个分路的 read-modify-write 也可能互相覆盖。原子 rename 只防 torn write，不防 stale writer。场景 B：Bridge 在写入 `running` 后退出，重启不会恢复原 Promise；持久文件仍让横幅永久显示“进行中”，并非“如实”。

   **Fix:** schema 增加不可变 `switchId: UUID`（也可定义 `{vendor,generation,switchObservedAt}` 为完整 identity，但 UUID 更直接），所有 lane completion 经同一串行 writer 做 `updateIfCurrent(switchId, patch)`；当前文件不是该 ID 时丢弃旧 completion。Bridge 启动时读取状态：若当前事件仍为 `running`，要么重新排入一次全量刷新，要么原子改为 `failed`/`interrupted`（固定原因码和时间），不能继续显示“进行中”。补测试：A 后来被 B 覆盖、A 晚完成不得改 B；两 lane 交错完成不丢字段；写 `running` 后模拟进程重启，页面显示“中断/失败”或恢复执行，而不是永久进行中。

2. **`bridgeRefresh` 和 Codex 单一 `observedAt` 的粒度不足，会静默显示某些 pre-switch 数据，也会把成功分路误报为失败。**

   **Why:** §7 已要求组合刷新返回 `{codex, claude}` 分路结果；当前 `createAccountQuotaRefresh` 也确实分别执行 Codex 与 Claude detail（`account-quota-refresh.ts:141–163`）。§6.5 却只持久化一个 `bridgeRefresh.state/code`，失败时统一标“Codex 各格、Claude 卡读于”（§6.5:175–181）。例如 Claude detail 失败而 Codex 成功，会把 Codex 误标失败。反方向更严重：Codex quota 与 Codex subscription 不是同一时间源；现有 view 的 `nextCharge` 使用 `subscription.observedAt`（`account-quota-view.ts:651–700`），且 subscription 失败目前被 Codex quota refresh 捕获为 warning、整轮仍成功（`account-quota-refresh.ts:88–112`）。按 §6.5 只比较账号的 Codex `observedAt`，quota 更新后旧 subscription/next-charge 可以无标注继续显示，直接违反 Lead 的“不得静默显示切号前读数”。`QuotaCell` 本来就逐格保存 `observedAt`，包括 Claude card 的 `detailObservedAt` 与 Codex subscription 时间；现规则没有利用这一事实。另一个缺口是 `observedAt=null` 不满足“早于”，所以切号后的从未读到项也不会得到切号标注。最后，`sweepRequest.state="requested"` 只证明请求已写，并不证明 Claude usage sweep 完成；此时横幅写“重读：已完成”会夸大状态。

   **Fix:** 把状态和页面 freshness 按实际数据源拆开，至少表达 `codexQuota`、`codexSubscription`、`claudeDetails` 三个 Bridge outcome，Claude usage 保持独立的 sweep-request 状态；§7 的分路结果应直接喂给这些字段。页面对预期由本次刷新更新的 machine-backed channel 使用它自己的已校验 `observedAt` 判定，`null` 视为“切号后尚未读到”，manual/不受刷新管理的字段不套该规则。对应 lane 失败时只给该 channel 标“刷新失败”；仍在跑或只 requested 时标“尚未刷新”。如果页面不读取 quota-monitor completion，就把横幅明确写成“Bridge 卡/订阅重读已完成；Claude 用量重读已请求”，不能称整个重读已完成。补 partial-outcome、Codex quota 新但 subscription 旧、null timestamp、sweep 仅 requested 的测试。

3. **§6.5 尚未把状态文件验证、转义和页面 fail-open 边界写到可安全实现的程度。**

   **Why:** schema 把 `code`/`wake` 写成无界 `string`，没有规定 generation、ISO 时间、未知键、symlink/非普通文件的校验；§8 的转义承诺只点名现有 store 字符串，没有覆盖新状态文件。当前页面 renderer 是纯函数，所有动态 HTML 都显式走私有 `escapeHtml`（`account-quota-page.ts:210–216, 235–267, 354–369`），路由先构造 view 再调用 renderer（`plugin.ts:2143–2159`）。若按“`account-quota-page.ts` 读文件”直接加入 I/O，不但破坏现有纯边界，任何遗漏的 read/parse catch 都会被外层 route catch 变成整页 503；若直接插入 status code，又会引入 stored HTML injection。

   **Fix:** 新建纯 reader/writer 边界：reader 先 `lstat` 且只接受普通文件、读取前检查 ≤4 KiB、拒绝未知键，要求 generation 为非负安全整数、时间为 canonical ISO、state/wake 为闭集、code 为限长安全原因码；writer 用 0700 父目录、0600 临时文件、fsync + rename、失败清理临时文件。由 `plugin.ts` 路由 best-effort 读取并捕获所有 missing/permission/parse 错误，得到 `SwitchRefreshStatus | null` 后作为可选参数传给 view/page renderer；renderer 不等待刷新，也不自行做 I/O，所以状态文件不可用时页面仍正常。所有 status 派生文本即使已校验也必须经过现有 `escapeHtml`。补 symlink、超大文件、未知键、非法时间/枚举、读取抛错仍出正常页面，以及含 `<script>` 的 code 被拒绝或转义的测试。

## Advisory

无。本轮未复核或重开 W1–W4、W6–W8 的其他设计。

## Verdict

CHANGES REQUESTED

Round 3 唯一阻断项已经关闭。§6.5 需补齐 event-scoped/重启状态机、按实际数据源判 freshness，以及明确的 fail-open reader 与 HTML 转义合同，之后才能保证 Lead 要求的“每次切号全量刷新，旧数绝不静默”。
