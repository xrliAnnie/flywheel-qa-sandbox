# FLY-1847 founder review 意见回传与 verdict 误判 — 调研

Issue: FLY-1847 (https://linear.app/geoforge3d/issue/FLY-1847/founder-ux-互动-review-页的意见回传是手动复制粘贴-已实际发生她写了一整轮我们没收到而她不知道)
日期: 2026-08-18
基于: exploration.md

> 2026-08-19 founder 终审裁决：下文是决策前的现状取证，旧的“页面 marker 自动打回”、❌ reaction、自然语言三态分类方案均已废弃。最终协议只认卡锚定动作：卡上 ✅，或 reply-to 卡固定文本 `approve` / `look good to me` 批准；reply-to 卡显式 `打回` 或 `design:` / `implement:` / `qa:` 前缀打回；普通 thread 发言一律交给 Lead，不进入机器 verdict。实施以 `plan.md` 为准。

本文是代码事实清单:每条带 `文件:行号`,均在本分支 head(`2df1fd06b` 之后的 flywheel-FLY-1847)上逐字核实过。行号会过期,重定位用 `git log -S "<引文>"`。

## 1. founder_review 通道全链(实例 1/2/3/5/7 的路径)

### 1.1 round 的打开

- Runner 侧:`flywheel-comm gate founder_review --hosted-url <url> --artifact <path>...`(`packages/flywheel-comm/src/index.ts:1993-2010`)。要求当前 workflow activation;artifact 由 `inspectCommittedFounderReviewArtifacts` 从 git 提交内容算 digest。
- question content = JSON `{version:1, round, runId, artifactDigest, hostedUrl, paths}`(`founder-review.ts:313` `parseFounderReviewQuestionContent`)。
- Bridge 把卡投进 issue thread:`founder-thread-notifier.ts:144-158`(自相矛盾文案的所在,逐字见 §4)。

### 1.2 founder 回应的两条腿

**腿 A — 文字**(`founder-reply-deliverer.ts:529-733` `processFounderMessage`,founder_review 分支在 :585-613):
- 触发条件:founder 在 thread 里发消息,且(a)是对 review 卡的 Discord reply(`getFounderReviewCardBindingByMessage`),或(b)`founderReviewGates.length === 1`(当前恰一个开着的 round,**普通 thread 消息也算**,注释:"The review page's one-click summary is pasted as a plain thread message")。
- 分类:`founder-review-response.ts:26` `classifyFounderReviewReply` —— NFKC + trim + lowercase + 去尾部 `。.!！` 后,**整串精确 ∈ {都可以了, 可以了, 通过, lgtm, approved}** → `{passed:true}`;**else → `{passed:false, feedback: 原文}`**;原文 trim 后为空(如 attachment-only 消息,`msg.content ?? ""`)→ `{passed:false}` **无 feedback** —— 实例 1-3 的 113 字节回执形状。
- 写入:`writeTrustedFounderReviewResponse`(同文件 :49)→ `db.insertFounderReviewResponseIfGateOpen`(`flywheel-comm/src/db.ts:1798`)→ `insertResponseIfGateOpen`(:1749)**同一事务写 response + `markQuestionTerminalDisposed`** —— 写入即关门。stale round / binding 不符 / 门已关 → `written:false`,消息**落到 §1.3 的 Lead 兜底**。
- 写入成功后 `return {ok:true}` —— **没有任何 in-thread 回执**。她不知道这句话被记成了什么。

**腿 B — ✅ reaction**(`gate-poller.ts:3088` → `tryFounderReviewReactionResponse`,`founder-review-response.ts:126`):
- GatePoller 按间隔轮询 review 卡消息上的 ✅(`FOUNDER_CONFIRM_EMOJI = "✅"`,`founder-confirmation.ts:22`);确认 founder id 在 reactors 里 → `passed:true` 写入。
- `checkReactionConfirmation` 接受 `emoji` 覆盖参数(`founder-confirmation.ts:128-131`)—— **❌ 腿是零新机制的对称复用**。

### 1.3 第三态的既有落点

`founder-reply-deliverer.ts:705-722`:没有被任何 gate 写入吞掉的 founder 消息 → `deliverAmbiguousToLead`(带 issueId/threadId/msgId/原文),注释逐字:"Bridge is a transport only. It records delivery, forwards the original message to Lead, and stops. Lead's later guarded response is the sole action allowed to write a runner response."
⇒ 三态化的「neither」分支**不需要新通道**:founder_review 腿判不出显式信号时直接**不写**,消息自然落进这条既有 Lead 转达路。

### 1.4 verdict 的消费与硬门

- `founder-review.ts:376` `resolveFounderReviewVerdict`:取本 run 未 superseded 的最新 round;response 缺失/归属不可信/digest 不符/`passed:false` → `not_passed(各 reason)`。
- `commands/complete.ts:139` `founderReviewCompletionBlockReason`:route ∈ {needs_review, no_code} 且 verdict 非 passed → 拒绝文案 "publish the current interactive HTML, open a new founder_review round, and wait for founder pass";`complete.ts:367-375` 两个拒绝分支都 `process.exit(1)`。
  - ⚠️ 实例 5 报「exit code = 0」:**本 head 不复现**(FLY-1758 #839 于 2026-08-14 合入,拒绝即 exit 1)。exit-0 观察的归因不进本单(可能是生产旧 dist 或观察方式),标注给 Lead。
- round 换代:开新 round → 旧 round `supersededAt` 置位(family 机制);`writeTrustedFounderReviewResponse` 的 `stale_round` 守卫(`founder-review-response.ts:85-101`)只允许写最新 round。**已关门的 round 无法再写;恢复 = runner 开新 round = founder 再操作一次** —— 这就是「每次误判必然消耗 founder 一次额外操作」的机制根源。

## 2. ship 卡通道(实例 4 的路径)

- **写入边界是二分的**:`approval-signal/write-gate-response.ts:498` `const approved = isApproval(args.answer)`;非 approve 的一切 answer → payload `{approved:false, feedback: founderFeedbackVerbatim(answer)}`(:534-536, :564-566)→ CommDB `insertFounderApprovalResponseWithSource`(`db.ts:1939`)在同一事务写 response + `workflow_source_event(kind='founder_feedback')`(:1990-1993:**`approved!==true` 一律 `founder_feedback`**)。
- 下游:`founder-approval-projector.ts` 搬运 source event → `StateStore.applyWorkflowSourceEvent`(:38388 起)→ `commitWorkflowTransitionTx(outcome:'founder_feedback_kickback')`(:38610)→ FLY-1772 返工机器(作废旧卡、返工、新卡)。
- 上游有多个 caller 会把 founder 文本作为 answer 送进这个写入边界:
  - 直连腿:`founder-ship-approval-handler.ts` —— 有 LLM strict 分类器(`founder-ship-approval-classifier.ts:83-90`,approve/reject/**unclear fail-closed**,"a status question" 明文该判 unclear;`text-approval-source.ts:8` "unclear → WAKE-only");reject 时 :564 构造 `{approved:false, feedback}`。
  - Lead relay 腿:`founder-consent/gate-response-router.ts` —— Lead 经 wrapper 把 founder 原文作为 answer 写入;`hasApprovalIntent` 只拦 Lead 代**批准**(:260),不拦非批准文本。
  - **⚠️ 更正(stopgap 交叉审 M-6,推翻本节初稿的「relay 腿必然铸 kickback」)**:生产默认 `DECISION_MODE=off` 下,relay 的 actor(leadId)过不了 `isTrustedApprovalAttribution`(`founder-attribution.ts:37-43`),`write-gate-response.ts:499-510` 的 trusted 两分支都不触发,answer 走 plain `insertResponse`(:584-592)——**不铸 `workflow_source_event`、不铸 kickback**(`db.ts:1990-1993` 只在 trusted 写入器内运行)。off-mode 下 relay 腿的真实失效形态是「**门被吞、什么都没铸、run 卡死**」;只有 enforce-mode(actor `bridge-founder-consent`)才铸 source event。
- 卡片文案教的就是二分:`gate-materializer.ts:191` "打回:直接回复意见即可;可用 design:/implement:/qa: … 起头指定返工对象"。**没有「提问/讨论」出口。**
- ⇒ 实例 4 的结构结论:trusted/enforce 路径的写入边界(`isApproval` else feedback)是二分的,卡片契约也是二分的;off-mode relay 则是静默吞门。初稿时实例 4 实走哪条腿**未定**,因此把生产 CommDB 的 `workflow_source_event.classification`(`dashboard_founder_action`/`founder_consent_enforce`/`founder_direct_signal`)核对列为 plan Chunk 5 的 design-freeze 硬门;该门现已由下一条取证解除。修法仍覆盖两条真实路径:trusted 铸造要求显式信号;off-mode 拒写 `neutral_not_written` 兼修静默吞门。
- **2026-08-19 实施取证结论:**只读查询生产 `/Users/xiaorongli/.flywheel/comm/flywheel/comm.db` 的 `workflow_source_event`,FLY-1833 对应行是 `kind=founder_feedback`,`classification=founder_direct_signal`,`msg_id=1539111227295535115`,`approved=0`,feedback 与 founder 三个问题逐字一致。实例 4 因此确定走 **founder 直连 trusted 路径**,不是 Lead relay;Chunk 5 design-freeze 硬门已解除。off-mode relay 的 `neutral_not_written` 仍作为独立静默吞门修复保留。

## 3. 页面契约与托管约束

- 页面契约源头:`packages/edge-worker/src/Blueprint.ts:869-909` —— INTERACTIVE COMMENT LAYER(逐节 textarea + localStorage 自动保存 + 底部汇总卡 + 一键复制)与 HONEST COMMENT RETURN("comments typed on the page do not automatically reach the runner… Never tell her the page auto-syncs comments")。**汇总输出格式由每张页面自己的 inline script 生成,当前无统一 marker** —— 分类器无法机器识别「这是页面汇总粘贴」。
- 同契约的第二份拷贝在 flywheel-skills repo 的 `founder-html-delivery` skill(FLY-216 迁移)——改 Blueprint 契约时需同步(独立 repo,follow-up PR)。
- 托管:`reports-route.ts` stage → `deployFilesToVercel`(纯静态文件部署,无 serverless function);CSP `default-src 'none'; script-src 'nonce-…'; style-src 'unsafe-inline'; img-src data:`(`report-registry.ts:66`)。**页面发不出 fetch/XHR**(connect-src 落回 default-src 'none');Bridge 在住宅机上公网不可达。⇒「页面自动回传」最少需要:reports 域上的接收 function + 存储 + Bridge 轮询 + 防伪(页面 URL token 是唯一 secret)+ CSP 放宽 —— 一整块新 infra,exploration §3 已 rejected-for-now。
- 附:CSP 的 `form-action` 指令不落回 `default-src`,静态 `<form>` POST 理论可行 —— 但接收端与存储的缺口同上,不改变结论。

## 4. 卡片文案现状(逐字)

`founder-thread-notifier.ts:154-155`:

> 请在互动页面逐处留言。页面留言完成后，点「一键汇总复制」，把汇总贴回本 thread（页面留言目前不会自动同步给 runner）。
> 直接回复这条卡片 = 打回并把原文交给 runner；只有明确回复「都可以了 / 可以了 / 通过 / LGTM / approved」或点 ✅ 才算本轮通过。

第一段教的动作(贴回 thread)会被第二段的规则(直接回复 = 打回)判成打回 —— 系统在主动制造误判。此外 in-thread 无任何回执,founder 侧对「这句话被记成了什么」零可见。

## 5. 可复用的既有形态(实施对齐用)

| 需求 | 既有形态 | 位置 |
|------|---------|------|
| ❌ reaction 腿 | `checkReactionConfirmation({emoji})` | `founder-confirmation.ts:122-131` |
| in-thread 一行回执 | ship 路径「已存着」notice(truth-in-time 纪律:unclear 绝不回「已存着」) | `deferred-approval.ts:225`,`founder-ship-approval-handler.ts:454` |
| founder 消息上点 ✅ 作确认 | approve_to_ship 卡承诺 "批准绑定后我会在你的消息上点 ✅ 确认" | `founder-thread-notifier.ts:129` |
| neutral 不动状态 | 分类器 unclear → WAKE-only | `text-approval-source.ts:8`,`founder-ship-approval-handler.ts:384-386` |
| 三态分类枚举 | `ApprovalIntent = approve/reject/neutral` | `approval-intent.ts:3` |
| 消息转 Lead | `deliverAmbiguousToLead` | `founder-reply-deliverer.ts:705-722` |

## 6. 会过期的结论(as-of 2026-08-18,重核命令附)

| 结论 | as-of 依据 | 重核 |
|------|-----------|------|
| founder_review 分类是「白名单 else 打回」二元 | `founder-review-response.ts:26-46` | `grep -n "classifyFounderReviewReply" -A 20 packages/teamlead/src/bridge/founder-review-response.ts` |
| 写入即关门(response+terminal_disposed 同事务) | `db.ts:1749-1795` | `git log -S "markQuestionTerminalDisposed(input.questionId)" packages/flywheel-comm/src/db.ts` |
| 恰一个开 round 时普通 thread 消息也被当 verdict | `founder-reply-deliverer.ts:593-597` | `grep -n "founderReviewGates.length === 1" packages/teamlead/src/bridge/founder-reply-deliverer.ts` |
| complete 拒绝时 exit 1(非 0) | `complete.ts:367-375`,FLY-1758 #839 (2026-08-14) | `grep -n "process.exit(1)" packages/flywheel-comm/src/commands/complete.ts` |
| ship 写入边界二分(`isApproval` else feedback) | `write-gate-response.ts:498,534,564` | `grep -n "isApproval(args.answer)" packages/teamlead/src/bridge/approval-signal/write-gate-response.ts` |
| 报告页 CSP 无 connect-src、托管纯静态 | `report-registry.ts:66`,`reports-route.ts:49` | `grep -n "default-src 'none'" packages/teamlead/src/bridge/report-registry.ts` |
| 页面汇总输出无机器 marker | `Blueprint.ts:869-909` | `grep -n "一键汇总复制" packages/edge-worker/src/Blueprint.ts` |
| 卡片文案自相矛盾两段 | `founder-thread-notifier.ts:154-155` | `grep -n "一键汇总复制" packages/teamlead/src/bridge/founder-thread-notifier.ts` |
| 实例 4 走 founder 直连 trusted 路径(`classification=founder_direct_signal`),已于 2026-08-19 只读取证 | §2(含 M-6 更正与实施取证) | Chunk 5 同时守住 trusted source-event 铸造与 off-mode relay 静默吞门 |
