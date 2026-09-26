# Design Review — plan.md (Round 3)

Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

v4 已正确解决 Round 2 的三个问题：收据状态域不再承载 `free`，页面只用当前 account-detail 套餐判断免费；搜索恢复 gog envelope 并按 `nextPageToken` 有界翻页；扫描不完整时金额与收据张数都置空。相关 store、observer、view、接线和测试总体与计划一致。我只读运行了 6 个相关测试文件，共 164 项，全部通过；未访问真实邮箱，工作树保持干净。

还剩一个会破坏分页 fail-closed 语义的阻断点：当前实现把缺失的 `nextPageToken` 当成空 token（已穷尽），并静默跳过不可能由正常 gog 产生的无效消息行；跨页相同 message id 也没有去重。前两种情况可把 malformed 输出变成 `no_receipt`，后一种可把同一张收据重复计数、重复加金额。v4 应把这些形状写进完整性契约并补测试。

## What's Good (Keep)

- 删除 `free` status、移除 observer 对 detail store 的依赖，并让 view 在 founder 手填确认之后直接读取当前 `subscriptionTier`，彻底消除了“旧 tier + 新 charge 完成时间”的错误时间戳来源。
- 旧 `free` store 会被共享 validator 拒绝；页面免费判断不依赖该 store，因此升级窗口不会把旧收据状态误当成套餐事实。
- 搜索按 token 最多翻 3 页，三页后仍有 token 就在取正文前整号 `search_truncated`；未看全时连取消事件也不下结论，这比只把金额置空更完整。
- `candidate_limit` 仍准确区分正文预算耗尽；检索已穷尽后，只有正文预算在周期边界内耗尽才把 `amountCents` / `receiptCount` 同时置空。
- §6 已在表格中如实披露恢复 envelope 后 Bridge 会短暂看到 message id、threadId、labels 和 page token；store、日志及异常仍保持闭合字段与白名单码。
- 官方 Gmail `users.messages.list` 也把 `maxResults` 定义为最大返回数，并把 `nextPageToken` 定义为取得下一页的 token；v4 改用 token 而不是行数判断分页，方向正确。[Gmail API reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)

## Issues & Recommendations

1. **BLOCKER — 分页聚合器尚未对“穷尽证据”和 message identity 完整地 fail closed。**

   - 问题一：计划说穷尽与否只看 envelope 的 `nextPageToken`，上游 `gog@a92bd63` 在空页和非空页都会显式输出该键；但实现只在该字段存在时校验。`{"messages":[]}` 会被当成 `token = ""`，最终写成 `no_receipt`，而不是 `malformed`。这正好绕过了 v4 用 token 取代行数猜测的核心保证。
   - 问题二：正常 gog 的每个 search item 必有 API message id；当前代码对非对象、缺 id 或非法 id 的行直接 `continue`。这些不是允许的 fuzzy-match 邮件内容，而是 stdout schema 损坏。若唯一的订阅收据行因此被跳过，仍会得到 `no_receipt`。
   - 问题三：三次独立 list 调用的结果直接 append，没有按 message id 去重。若分页期间邮箱变化、上游重叠页或测试 runner 返回重复 id，同一张收据会被取正文两次，`receiptCount` 与 `amountCents` 都会重复增加；重复的非订阅收据还会提前耗尽 6-body budget。
   - 为什么重要：这三种情况都把“不能证明完整”转成了确定的无收据或金额事实，仍违反 exploration 的“不猜”和本轮的 fail-closed 目标。
   - 建议修复：每页必须要求 `nextPageToken` 是字符串（空串表示末页；缺失/其他类型均 `malformed`）；非对象或无合法 id 的 item 也应 `malformed`，仅允许 Date 解析失败、From/Subject 精确过滤失败的真实邮件被丢弃；跨页维护 `seenMessageIds`，相同 id 只处理一次（若同 id 的安全字段冲突，可直接 `malformed`）。新增三条测试：缺 token 的 envelope、缺/非法 id 的 item、第二页重复第一页面的收据；它们分别不得产出 `no_receipt` 或重复金额。

2. **SHOULD — §6 的最终确认文字应显式覆盖 v4 新增的 Bridge 侧字段。**

   - 表格已经正确写出 `id/threadId/labels/nextPageToken` 会进入 Bridge，但紧随其后的“残余风险”段仍只说 fuzzy match 的发件人、主题、日期进入 Bridge。founder 先前批准的字段清单并不包含这些标识符与 labels。
   - 建议把 PR 中待确认的内容明确写成：模糊命中邮件的 `id/threadId/labels/from/subject/date` 以及 page token 会短暂进入 Bridge 内存，均不落盘、不进日志；将 Lead/founder 对这个精确边界的确认列为部署前置条件。这样表格与授权请求不会给出两个不同范围。

3. **NIT — 页面优先级文字与实现不一致。**

   - 用户说明和实现都是 `manual canceled → current detail free → mailbox mismatch`，但 §5 编号列表仍写成 `manual canceled → mailbox mismatch → free`。当前账号同时 free 且邮箱刚改绑时，两者会显示不同文案。
   - 建议采用实现顺序并更新 §5：free 是独立的当前 detail 事实，不需要旧邮箱收据；同时补一条 free + mailbox mismatch 的组合测试。

4. **NIT — store validator 没有编码 `receiptCount: null` 的关系约束。**

   - schema 注释说 count 仅在扫描不完整时为 null，observer 也会同时写 `amountCents: null`；但 validator 仍接受 `receiptCount: null, amountCents: 12345`。
   - 建议至少要求 `receiptCount === null` 时 `amountCents === null`，并补写前自检测试。`amountCents === null` 且 count 为数字仍应合法，因为完整扫描也可能遇到缺失 Amount paid。

## Verdict

**CHANGES REQUESTED**。Round 2 的 free 仲裁、token 翻页方向和 nullable count 均已关闭；批准前需补齐 #1，让“缺失 token / 结构损坏 / 跨页重复”不能产生确定的 `no_receipt`、张数或金额。#2 应同步把 founder 待确认的瞬时数据范围写全；#3–#4 是小型契约一致性修正。
