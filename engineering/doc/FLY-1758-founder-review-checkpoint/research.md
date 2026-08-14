# FLY-1758 产品线互动回合:founder_review checkpoint — 调研

Issue: FLY-1758 (https://linear.app/geoforge3d/issue/FLY-1758/产品线互动回合-阶段性产出必须先经-founder-review-才准继续-新-founder-review-checkpoint复用)
日期: 2026-08-13
基于: exploration.md

> 取证方式:三路并行代码审计(workflow 引擎 checkpoint / flywheel-comm respond·attribution / FLY-1404 合同·agent.md)+ 本人对全部承重行的抽查复核。所有 file:line 均为本分支(= origin/main @97dec19bd)实测。

## 1. checkpoint 是自由字符串,没有中心枚举

- `mailbox` 表的 `checkpoint` 列无 CHECK 约束(`packages/flywheel-comm/src/mailbox-schema.ts:59`);`insertQuestion` 的 `checkpoint?: string` 任意(`db.ts:1053`)。**新增 `founder_review` 零 schema 迁移。**
- 语义由 ~15 处散落的字符串比较实现。与本单直接相关的:

| 位点 | 现状 | 对 founder_review 的含义 |
|---|---|---|
| `packages/flywheel-comm/src/commands/respond.ts:20` | `GATED_CHECKPOINTS = new Set(["approve_to_ship"])` | Lead respond 拒绝的第一层 |
| `packages/flywheel-comm/src/db.ts:1704-1709` | `insertGuardedResponse` 硬拒 approve_to_ship/review_design/review_code("not Lead-routable")| **Lead 代答必须被拒的纵深层,本人抽查属实** |
| `packages/teamlead/src/bridge/gate-poller.ts:1556` | `if (cp !== "brainstorm" && cp !== "approve_to_ship") return; // v1 scope` | **founder 卡片白名单 —— 不改这行 founder 永远看不到回合,本人抽查属实** |
| `packages/teamlead/src/bridge/founder-thread-notifier.ts:33-36` | `FounderGateCheckpoint = "brainstorm" \| "approve_to_ship" \| "ship_ready"` | 卡片文案 union |
| `packages/teamlead/src/bridge/founder-reply-deliverer.ts:544-606` | 只有 `approve_to_ship` 进 `tryFounderShipApproval`;其余全落 `deliverAmbiguousToLead` | founder 的文字/✅ 变成 answer 的唯一入口,需并列新分支 |
| `packages/teamlead/src/bridge/checkpoint-park.ts:71-113` | `brainstorm/approve_to_ship → party:"founder"`;`question → party:"lead"` | 「球在谁手上」归属 |
| `packages/teamlead/src/bridge/review-gate-checkpoints.ts:18-27` | `REVIEW_GATE_CHECKPOINTS = {review_design, review_code}`,单一集合、所有退休路径继承保护 | **值得照抄的模式**;不进保护集会被 finalize/zombie-hygiene 退休 |
| `packages/edge-worker/src/Blueprint.ts:2356-2600` | checkpoint prompt 注入;`:2367-2372` generalized 执行只保留 `question`;`:2571-2600` 兜底文案硬写 "BLOCKS until your **Lead** responds" | 需显式 `founder_review` 分支 + generalized 放行 |

## 2. 病根的代码级印证

1. **产品线 produce 节点今天拿到的 founder HTML 合同 = 零。** `menus/shapes/{prd,design,prototype}.yaml` 的 produce 节点只有 `role: pm/designer/proto`,`workflow-menu.ts:306-312` 的 `nodeType()` fallthrough 把它们全编成 **`generic`**(本人抽查属实)→ `completion_route: "needs_review"`(`node-type-registry.ts:143`)→ `Blueprint.ts:1634-1637` 的 `isDesignNodeCompletion`(只认 `phase_design_complete`)为 false → FLY-1404 合同(`Blueprint.ts:825-858`,注入点 `:1878-1891`)**不注入**。FLY-1688 的「18 分钟直奔 ship」在结构上就是这么发生的。
2. **pm-executor.md 承诺的 FLY-605 十分钟兜底对它自己用的 checkpoint 是假的。** `pm-executor.md:119-122` 写 "If a gate sits unanswered ~10 min, FLY-605 posts the question + @founder";但产品 runner 的回合走 `question` checkpoint,而 `gate-poller.ts:1556` 对 `question` 直接 return —— **question 根本不在 v1 白名单里**。产品线的回合今天没有任何 founder 可见路径,除非 Lead 手工转。这正是 issue 实测「八月 founder 收 0 条」的机制成因。
3. **Lead 转达 founder 答复也拿不到 founder 归属。** `respond --source-thread` → `POST /api/founder-routing/runner-response`(`founder-routing-response-route.ts:88-235`)写入的 from_agent 是 **leadId**,`isTrustedApprovalAttribution` 判 false。今天不存在「question checkpoint 上的 founder 归属答复」这种东西。

## 3. founder 归属:唯一定义与防伪,直接复用

`packages/flywheel-comm/src/founder-attribution.ts`(全文 145 行已读):
- `isTrustedApprovalAttribution(from, founderId)`(:36-43):founder Discord id / `"bridge"` / `"bridge-founder-consent"` 三类;注释(:14-16)写死 Lead id / `founder-bridge-auto` 不算。
- `isReservedApprovalAttribution`(:64-68):两个 bridge 名 + 任何 17-20 位 snowflake 形状 —— caller 可控的 `--lead` 参数无法伪造这三类身份(FLY-945 Fix E)。
- `resolveFounderId`(:96-113):实时读 `~/.flywheel/.env` 的 `DISCORD_OWNER_USER_ID`;**未配置 = 判定整段跳过**(诚实边界)。
- kill-switch `FLYWHEEL_FOUNDER_ATTRIBUTION_GATE`(:126-144),默认 ON。

founder 侧写入的五条路径全部经单一原语 `writeGateResponseAndRunPostWrite`(`bridge/approval-signal/write-gate-response.ts:308-608`),但它 **:319-321 硬拒非 approve_to_ship**,且强绑 `awaiting_review` FSM + `pr_head_sha` —— **founder_review 不能复用它**,要用 `insertResponseIfGateOpen`(`db.ts:1604-1653`,自带 expectedOwner+expectedCheckpoint+TOCTOU 原子性)另起一个轻量 founder 写入方法。

## 4. respond 拒绝的现有形态与 founder_review 的差异

approve_to_ship 的拒绝是**四层**:L1 保留归属(respond.ts:45-51)→ L2 批准意图 `hasApprovalIntent`(:57-62,`lead_ack_rejected`)→ L3 无 Bridge fail-closed(:82-88)→ L4 db 层 not-Lead-routable(db.ts:1704-1710)。

**关键差异:L2 只拦「批准」,非批准的反馈会被放行走 Bridge founder-consent 路由。** founder_review 若照抄这套,Lead 仍能替 founder 写「打回意见」—— 中间版本照样绕过她,病只好一半。issue 命门要求的是**无条件拒**(通过和打回都只能出自 founder)。⇒ founder_review 需要一道独立的、无条件的 respond 拒绝(+ db 层 not-Lead-routable 加名),不复用 `GATED_CHECKPOINTS`+`hasApprovalIntent` 组合。

## 5. 非终局、可多次:结构上现成

- **一问一答是硬约束**:`mailbox_unique_response` 唯一索引(mailbox-schema.ts:108-109)+ 答后 `markQuestionTerminalDisposed`(db.ts:1585-1594)。⇒ **每一轮 = 一个新 question**,与 `gate question` 多次调用完全同构,零改动。
- **非终局照抄 `gate question`**:`gate.ts:192-244` 拿到答案 `return {status:"answered"}`,runner 继续跑;不进 ship FSM。Claude runner 阻塞轮询,Codex 走 `--no-block` + `check`(`Blueprint.ts:2545-2565`)。
- checkpoint 启用走 `.flywheel/config.yaml` 的 `checkpoints:` 块(`CheckpointsConfig = Record<string, CheckpointConfig>`,`packages/config/src/types.ts:181-204`),ConfigLoader 只校验形状不校验名字(`ConfigLoader.ts:217-272`)——**加 `founder_review` 不用改 loader**。timeout 有 4h 下限(`MIN_GATE_TIMEOUT_MS`)。

## 6. ship 前置的可选落点(engine 侧全景)

五个生产 seed 的 gate authority 全是 **`land`** 模式(`workflow-run-snapshot.ts:173-175`;`isWorkflowManifestLand` 优先)。ship 链:founder ✅ → `applyWorkflowSourceEvent` → land 激活(`StateStore.ts:31930-31975`)→ `land-executor.ts` → `merge-ship-gate.ts` 的 `computeAuthoritativeShipDecision` → **`evaluateShipEligibility`(`ship-eligibility.ts:389-437`)= `verifyApproval` AND `evaluateQaShipGate`**。可选落点:

| 落点 | 层 | 评估 |
|---|---|---|
| a. `resolveWorkflowGateEvidenceTx` 的 `ship_claims` predicate(`StateStore.ts:32249-32381`) | 引擎(最原生) | 需要 claim 钉死 git head;produce 分支上 progress.md ledger 持续 commit 会不断漂移 head → 头对齐约束在产品线不可用;且改 seed 编译产物(`workflow-menu.ts:403-406`),半径超「中等档」 |
| b. gate 进入 admission(`StateStore.ts:29967-29993`)/ gate-materializer 扣留 | 引擎 | 扣留 materialization 有 FLY-1731 族 strand 风险(卡住无人知) |
| c. **`complete.ts` 完成硬门**(照 FLY-1404 design-html gate 形状,`complete.ts:272-276/497-505`) | CLI 写侧 | **runner 自己的 complete 直接失败** —— 字面实现「不许把做完了当可以 ship」;approve_to_ship 卡根本不会铸出来;有 FLY-1404 现成形状 |
| d. **`verify-approval` 新增 3.6 步**(:526 归属门之后;reason 枚举 :83-104) | CLI 读侧 | 最终授权点兜底;land 与 runner_ship 两路都经 `evaluateShipEligibility` 继承;防绕过 complete 门的任何路径 |

**⚠️ execId vs issueId 雷**:verify-approval 现有查询是 per-execId(`:481` `question.from_agent !== execId → review_question_invalid`);产品线是多 phase session,founder_review 可能发生在另一个 execId 上。**「本 run 至少一次」必须按 issue_id 查**(sessions 表有 issue_id,`:379` 已 SELECT),否则 phase 切换即绕过。必须有跨 execId 的测试用例。

## 7. 交付面:FLY-1404/1508 合同的复用切分

- 合同工厂 `founderDesignHtmlDeliveryLines`(`Blueprint.ts:825-858`):§五节内容 + INTERACTIVE COMMENT LAYER(:842-847,FLY-1508)+ Mermaid/mmdc(:848-853,FLY-930)——这 ~20 行产品线**逐字复用**。
- **不能整段照抄的一行**::857 尾句明写 "This delivery does NOT wait for founder review and does not block successor implementation" —— 直接复用等于把「不许阻塞」注进要阻塞的流程。需拆成共享正文 + 可替换收尾。
- Lead 侧规则同款措辞:`packages/teamlead/lead-rules-base/department-lead-rules.md:284-297`("must produce + must deliver, not must receive approval";:291 明写不许把它变成 approval checkpoint)——**该节只覆盖 design 节点,不改**;产品线的阻塞合同是新增条目,不是改写 FLY-1404 本身。
- CLI 证据门:`complete.ts:497-505` + `design-html-evidence.ts:23-26`(只认 `doc/<ISSUE>*/**.html` 已 commit)——只验「HTML 存在且已提交」,没有 founder 已读概念。产品线阻塞版在同位置追加 founder_review 校验。
- 送达:runner ingest token 无投递权(`publish-report.ts:156-160`,必须 `--publish-only` 拿 URL);投递给 founder 的载体是 **founder_review 卡片本身带 hosted URL**(经 gate-poller→founder-thread-notifier 进 issue thread),不新造送达设施。

## 8. 关键先例与它的死亡:FLY-598 founder-ux gate(被 FLY-900 撤掉)

引擎审计把 FLY-598 识别为「非终局、founder-only、可多轮、server 核验」的最完整先例(`founder-ux.ts:43-59` 的 uxHash 轮次键;`founder-ux/verify.ts:60-145` 的 thread 回捞 authorId 核验;`stage-guard.ts` 的推进阻断)。**但它已于 2026-07-06 被 Annie 直令撤掉**(FLY-900:「能够把这个规定撤了吗,没必要」),现藏在 `FLYWHEEL_FOUNDER_UX_GATE_ENABLED` 默认 OFF 后面。必须吸取的三条:

1. **它挡错了地方**:挡的是工程 issue 的 implement 前签字,Annie 不要那个。FLY-1758 挡的是**产品线阶段性产出**,是她本人逐轮定稿要的 —— scope 必须严格限 prd/design/prototype,绝不外溢到工程流。
2. **fail-closed + 配置缺失 = 全线卡死事故**:当时 `FLYWHEEL_FOUNDER_USER_ID` 没配,签字写路由 503,所有 founder-facing issue 的 implement 被永久挡住。⇒ founder_review 必须在**开回合时就 fail-loud**(founder id 未配置 → 明确报错给 runner/Lead),绝不静默 fail-closed 卡死。
3. **双层执法互相脱节**(await-gate 与 stage-guard 各挡一层,撤一层解不了另一层)⇒ founder_review 的执法点必须共享同一个判定函数、同一份 CommDB 数据源。

代码模式上仍复用它验证过的两件事:轮次以 artifact 版本为键的思路、founder 身份 server 侧核验的思路(但 founder_review 用现成的 founder-reply-deliverer 摄入链,不复活 founder-ux 的独立路由)。

## 9. 其余边界事实

- **一图一 gate 限制属实**:`workflow-menu.ts:219-222`(本人抽查)+ `workflow-template.ts:1290-1318`(第二个 gate 的 expected=undefined → throw)。founder_review 做成 checkpoint(节点内部回合)即可,**零 YAML、零图结构改动**。
- generalized 执行的 checkpoint 注入(`Blueprint.ts:2367-2372`)现在剥掉 brainstorm/approve_to_ship 只留 question —— founder_review 需要按能力位显式放行,且**只对产品线节点**(工程 tpl_code 的 design/implement/qa 不得注入)。
- 三个 executor 文件(`.flywheel/agents/engineering/pm-executor.md` 365 行 / `designer-executor.md` 182 行 + `.bare/.matt` 变体 / `prototype-executor.md` 323 行)已有成形的「回合协议」——只是全部挂在 `question` checkpoint(收件人=Lead)上。designer 的 Step 0/Step 3 与 prototype 的 Step 3/3.5 引用 "the injected QUESTION GATE flow",改指 founder_review 即可;pm 的 `:119-122`(病根句)重写。
- 三个文件各有一条 "**No new Runner↔founder channel**"(pm:318-322 / designer:167 / prototype:292)——founder_review 复用 gate/relay 基座不算新通道,但措辞需同步,否则 runner 会读成禁止。
- feature-flags:已存在的 `founder_review_gate_exclude`(registry.ts:961-980)是 FLY-1314 的另一回事,**命名撞车,新增任何开关不得用这个名**。结合 Annie 近期「不加新 flag」的方向(FLY-1466),本单倾向**零新 env flag**:启用与否由 `.flywheel/config.yaml` 的 `checkpoints.founder_review.enabled` + 模板能力位共同决定(config 缺席 = 零行为变化,天然 byte-compat)。
- 回执模式现成:`founder-ack.ts:35-56`(bot 在她的消息上点 ✅ 已绑定 / 🕒 deferred / ❓ 未绑定)。
- 巡逻/退休名单需加名(否则回合被误退休):`db.ts:1381/1401/1426/4923` 的裸 SQL `IN ('approve_to_ship','review_design','review_code')` 清单、`question-admission.ts:242-277`、`zombie-gate-hygiene.ts:342`。

## 10. 结论(喂给 plan 的决定)

1. **回合通道**:新 checkpoint `founder_review`,拓扑 A(`to_agent = leadId`,复用 GatePoller→founder-thread-notifier 卡片 + founder-reply-deliverer 摄入),卡片 grace 走 ship 式短 grace(不是 brainstorm 的 10min)——收件人从结构上改回 founder。
2. **答复写入**:新 Bridge 分支 `tryFounderReviewResponse`(并列于 tryFounderShipApproval),✅ reaction = 通过;文字回复默认 = 打回意见(全文作为 feedback 交回 runner);仅精确 allowlist(「都可以了/可以了/通过/LGTM/approved」)判通过 —— 错判方向永远偏「多一轮」,不偏「放行」。v1 不上 Haiku 分类器。
3. **Lead 拒绝**:respond.ts 无条件拒(独立门,先于 authorizeLeadWrite)+ db.ts:1704 加名 + 裸 SQL 清单加名。
4. **阻塞语义两道门,共享同一判定**:主门 = `complete.ts` 产品线完成硬门(需 artifact 证据 + 末轮 founder_review 通过);兜底 = `verify-approval` 3.6 步(按 issue_id,防跨 execId 绕过),经 `evaluateShipEligibility` 同时覆盖 land 与 runner_ship。
5. **合同注入**:`founderDesignHtmlDeliveryLines` 拆共享正文 + 可替换收尾;新能力位(菜单编译时按 taskCategory ∈ {prd,design,prototype} 打在 produce 节点上)驱动注入与 runner env 标记(FLY-1643 的 env 控制面模式)。
6. **fail-loud 边界**(FLY-900 教训):founder id 未配置时开回合即报错;绝不静默卡死。
7. **诚实缺口不变**:HTML 页内留言无自动回传(FLY-298 Backlog);真实闭环 = 她「一键汇总复制」→ 回贴 thread → **该回复本身就是本轮 feedback answer**(founder 归属)→ runner 拿到全文改版。founder-facing 文案不得暗示已自动化。
