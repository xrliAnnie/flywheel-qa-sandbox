# FLY-2597 thread title「要你答」+ 固定页同源 — 实施计划
Issue: FLY-2597 (https://linear.app/geoforge3d/issue/FLY-2597/founder-视图单一真相-thread-title-加要你答状态founder-需回复时机器点亮founder-回帖即熄-epic)
日期: 2026-09-15
基于: research.md

**Status**: revision-3-review-pending; prior approved(Gemini API-key 独立评审 R1 → CHANGES REQUESTED 四条已全部吸收;Codex R1 撞额度未跑;Lead leadAcceptance 收口,见 §11)
**Lead 裁定**(ask `1183f4e8`,2026-09-15):三条默认全部照办;追加「founderAsk 标记可审计(谁、何时、哪条消息),点亮/熄灭各写一条事件」。

## 0. 一句话

在既有标题轮转机器里加一个跨阶段徽章 `🔔要你答`,由一个新的纯派生模块 `founder-attention` 决定亮不亮;Epic 固定页「⚡ 现在要你看」改为调同一个派生模块;Lead 标记走 `POST /api/chat-threads/send` 的可选字段落进 Bridge 自己的 `founder_ask` 表;founder 回帖由既有 founder-reply-deliverer 的判定点熄灭。

## 1. 范围

做:
1. 标题新状态词「要你答」(点亮三条件、熄灭两条件、待批优先)。
2. 固定页「现在要你看」= 标题带 待批/要你答 的 thread 列表,同源派生;Epic 级计数不动。页面因此跟随既有标题的 QA/review hold 抑制,held ship 不再单独出现在此列表;ship 授权、title 待批语义及 Layer-2 节奏保持原样。
3. 通用:所有项目/Lead 生效;规则文件加负向规则、不新增手写进展要求。
4. 可审计:标记表 + 点亮/熄灭事件。

不做(见 exploration §6):不改「待批」语义与轮转节奏;不引入人工维护的第二份状态;Lead 不 PATCH thread 名;不动 Raya summary 机制;不动 Linear `founder_named` 语义;`isQaHeld/isReviewHeld` 只继续压 ship。

## 2. 架构总览

```mermaid
flowchart LR
  subgraph facts[事实源(已有)]
    H[StateStore\nworkflow_gate_holder]
    M[CommDB mailbox\nfounder_review / brainstorm 未答]
    A[StateStore founder_ask(新)]
  end
  R[founder-attention-facts.ts\nreadFounderAttentionFacts()] --> P[founder-attention.ts\nfounderAttentionLevel()]
  H --> R
  M --> R
  A --> R
  P --> T[issue-display-refresher\n标题 🔔 ⏳待批 / 🔔要你答]
  P --> E[attention-sources.ts\nEpic 页「现在要你看」]
  S[POST /api/chat-threads/send\n+ founderAsk] -->|先写行再发帖| A
  D[founder-reply-deliverer\nisFounder 判定点] -->|settle| A
  L[Lead respond 答掉关联问题] -.->|isQuestionPending=false| R
```

不变量:**标题与页面对同一 issue 在同一时刻读到的 `level` 相同**,因为两者调用同一函数、同一 SQL、同一 kind 表;不存在第二份状态。

## 3. 数据模型

### 3.1 `FOUNDER_ATTENTION_KINDS`(`packages/teamlead/src/bridge/founder-attention.ts`)

| kind | 来源 | level |
|---|---|---|
| `ship` | holder,authority ∈ {land, runner_ship} | ship(`🔔 ⏳待批`) |
| `founder_gate` | holder authority=engine_terminal(Lead 裁定归 待批) | ship |
| `legacy_founder_gate` | mailbox checkpoint ∈ {founder_review, brainstorm},无 holder | answer |
| `founder_ask` | founder_ask 表有效行 | answer(`🔔要你答`) |

页面 registry(`ATTENTION_V1.kinds`)新增 `legacy_founder_gate`(文案沿用「在等你按一下」)与 `founder_ask`(kind「Lead 在等你一个决定」,action「去 thread 里回一句」);优先级 ship 0 / founder_gate 1 / legacy_founder_gate 2 / founder_ask 3 / question 4(保留不产生)/ founder_named 5。`isFounderAttention(source) = founderAttentionLevel([kind]) !== null`。

> 注:今天 mailbox 的 founder_review/brainstorm 已被 CommDB 标成 `founder_gate`;为不改变 holder 档语义,读取器把「无 holder 的 mailbox 门」重标为 `legacy_founder_gate`。若评审认为两个 kind 名太重,可退回单一 `founder_gate` + 用 provenance 表名判档;默认按本表。

### 3.2 `founder_ask` 表(StateStore,见 research §3.1 的 DDL)

稳定标识:`ask_id`(uuid v4)。页面一句话沿用 Linear issue title,由既有 escapeHtml 渲染;`excerpt`(Lead 文本前 120 码点)仅作持久审计,不冒充 Linear 来源的 title。retention 片段 `scripts/lib/fly-2006-retention-tables/teamlead/founder_ask.json` → `protectedCurrentOrReference`。

有效谓词(唯一定义,导出为 `isFounderAskLive(row, isQuestionPending)`):`settled_at IS NULL && (question_id == null || isQuestionPending(question_id))`。

### 3.3 审计事件(`session_events`,`store.insertEvent`,source `bridge.founder-ask`)

| event_type | 何时 | payload |
|---|---|---|
| `founder_ask_lit` | send 路由写行成功且 Discord 首块发出后 | `{askId, leadId, issueId, threadId, messageId, questionId?, askedAt}` |
| `founder_ask_settled` | settle 成功(任一 settled_by) | `{askId, settledBy, settledMessageId?, settledAt}` |

`execution_id` = 该 issue 最新 session 的 exec(send 路由已有 `getSessionByIssue`),无 session 时用 `lead:<leadId>`。`event_id` = `founder_ask_lit:<askId>` / `founder_ask_settled:<askId>`(幂等)。

## 4. 变更清单(按 chunk,每个 chunk 先红后绿)

### C1 徽章语法(`stage-utils.ts`)
- 新常量 `NEEDS_ANSWER_EMOJI = "🔔"`,`NEEDS_ANSWER_WORD = "要你答"`,`needsAnswerBadge(withWord)`;注册进 `ALL_STATUS_EMOJI`/`EMOJI_TO_WORDS`。
- 守卫(Gemini R1 #2):`splitPrimaryStatusEmoji` 对 🔔 **只有紧跟着解析出词 `要你答` 才视为受管**,否则返回 undefined 让 `splitStatusEmoji` 原样保留;既有用例 `packages/teamlead/src/__tests__/stage-status-emoji.test.ts:114`(`🔔 literal title` 不变)必须继续绿。
- 测试 `stage-utils-badge.test.ts`:剥/重盖幂等;与 `🔔 ⏳待批` 互不干扰;手写 🔔 保留;emoji-only 模式(withWord=false)下 🔔要你答 退化为 🔔 → 与注意层冲突 ⇒ **emoji-only 模式不渲染要你答,保持原 stage**(文档化)。

### C2 纯派生(`founder-attention.ts` + `issue-display.ts`)
- `founderAttentionLevel(kinds)`;`IssueTitleBadge` 加 `{kind:"needs_answer"}`;`deriveFounderGateTitleState(args & {founderAttention})`:blocked > 已批(无)> ship / 原 approve 判定 > answer > 原逻辑;completed 终态 > answer(惰性)。
- 测试 `issue-display.test.ts` 矩阵:ship 覆盖 answer;blocked 覆盖两者;approved_to_ship 不亮;completed 不亮 answer;仅 answer → needs_answer。

### C3 表与账(`StateStore.ts` + retention 片段)
- DDL(与 `lead_note` 同迁移段);方法:`insertFounderAsk`、`backfillFounderAskMessage`、`settleFounderAsk(askId, by, msgId?)`、`settleFounderAsksByThread({threadId, beforeMs, messageId})`(幂等,只结 `asked_at < beforeMs` 的)、`listOpenFounderAsks(project, issueId?)`。每次 settle 内写 `founder_ask_settled` 事件(同一事务)。
- retention 登记(Gemini R1 #3):同一提交新增 `scripts/lib/fly-2006-retention-tables/teamlead/founder_ask.json` = `{"database":"teamlead","table":"founder_ask","classification":"protectedCurrentOrReference"}`;否则 `fly-2413-retention-registry.test.ts` 报 `schema_unclassified:teamlead:founder_ask`。
- 测试:`__tests__/founder-ask-store.test.ts`(内存库);`fly-2413-retention-registry.test.ts` 因新片段保持绿。

### C4 事实读取器与页面源(`founder-attention-facts.ts`、`attention-sources.ts`、`flywheel-comm db.ts`)
- `readFounderAttentionFacts(deps, {projectName, issueId?})`:三段 SQL 下沉;`attention-sources.ts` 的 gates/questions 段改为调它,再拼 Linear 段与 thread 绑定(founder_ask 行自带 thread_id/channel_id,作为 authoritative channel)。
- `assertAttention` 计数不变量(Gemini R1 #1):statestore 来源一律归「gates」桶,校验要求 `reads.gates.count === statestore 来源条数`;因此 `attention-sources.ts` 里 `reads.gates` 的 count **必须 = holder 事实数 + 有效 founder_ask 数**,否则页面生成抛 `/attention_sources/gates: invalid attention.v1 value`。`attention-sources.test.ts` 加一条「holder 1 + ask 1 → gates.count 2 且 assertAttention 通过」。
- `listAttentionQuestions()` 删 `@founder` 正则;非门 ask 一律 `lead_question`。
- 测试:新 `founder-attention-facts.test.ts`(内存 StateStore + 临时 CommDB);`attention-sources.test.ts` 改为经共享读取器;`db.attention.test.ts` 改期望。

### C5 标题接线(`issue-display-refresher.ts`)
- deps 加 `readFounderAttention?`(默认真读取器,含 CommDB 只读句柄、busy_timeout 5s、失败→显式 unavailable 并 warn,绝不把失败伪装成空事实;refresher 保留当前标题,记 deferred,不写指纹);`founderAttention = founderAttentionLevel(facts.kinds ∪ (isWorkflowApprovalGateCurrent ? ["ship"] : []))`——保留现有 DAG 判定作为 ship 的一个来源(字节兼容)。
- 渲染:`needs_answer` → `stampStageEmojiResult(ctx, thread, "", withWord, needsAnswerBadge(withWord))`;holds 只压 ship。
- 测试(`issue-display-refresher.test.ts`):条件 1(注入 legacy_founder_gate)/ 条件 2(founder_ask + questionId pending)/ 条件 3(founder_ask 无 questionId)各一条 → `🔔要你答`;founder 回帖 settle → 回原 stage;关联问题被答(isQuestionPending=false)→ 回原 stage;ship + ask → `🔔 ⏳待批`;blocked + ask → `🔴受阻`;读取器抛错 → 不亮且指纹不写(deferred);`issueStatusWordEnabled=false`(emoji-only)+ ask → 保持原 stage 徽章、不渲染 🔔(Gemini R1 advisory)。

### C6 写入面(`tools.ts` send 路由 + 新 withdraw 路由)
- body `founderAsk?: { questionId?: string }`:类型/多余键/格式校验 → 400;需要 `replyByIssueEnabled`(既有门)。
- 顺序:解析 issue → `insertFounderAsk`(message_id 空)→ 发帖 → 首块成功 `backfillFounderAskMessage` + `founder_ask_lit` 事件 + 两个 refresh 触发;首块失败 → `settleFounderAsk(id,"send_failed")`,沿用既有 502 信封;分块中途失败 → 行保留(消息已在 thread 里)。响应加 `founderAskId`。
- `POST /api/chat-threads/founder-ask/withdraw {askId, leadId, projectName}`(Gemini R1 #4:与 send 同一套门——`TEAMLEAD_API_TOKEN` 鉴权、`chatThreadsEnabled && replyByIssueEnabled` 双 flag 否则 404、`validateChatThreadParams` 校验 project/lead)→ 校验 ask 归属该 project/lead → `settleFounderAsk(id,"lead_withdrawn")` → 触发 refresh;404/403/409(已结)。
- 测试(`chat-thread-routes.test.ts`):先写行后 POST(mock fetch 顺序断言);回填 message_id;事件写入;发帖失败 → send_failed 且不点亮;字段校验;withdraw 三种错误码;无 founderAsk 的 send 字节兼容(既有用例不变)。

### C7 熄灭钩子(`founder-reply-deliverer.ts` + `gate-poller.ts`)
- `FounderReplyDeliverDeps.onFounderThreadMessage?`;在 `ingestDiscordChat` 成功后调用;抛错 → `brokeOn={stage:"founder_ask_settle_failed"}`,走既有 retryLedger/dead-letter。
- GatePoller 注入:`settleFounderAsksByThread` + `issueDisplayRefresher.enqueue(issueId)` + `epicPageRefresher.requestRefresh(project,"founder_attention")`。
- GatePoller relay:把 founder_review/brainstorm `gate_question` 交给 Lead 时 `enqueue(issueId)`(条件 1 的即时触发;sweep 兜底)。
- 测试(`founder-reply-deliverer.test.ts`):founder 消息触发钩子并带正确 ms;bot/非 founder 不触发;钩子抛错 → `process_failed` + pinned + ledger 记录;早于 ask 的 founder 消息不结(靠 `beforeMs`)。

### C8 页面(`epic-page/*`)
- `REFRESH_REASONS` 加 `founder_attention`;`renderAttention` 行序 ship → answer,行内 `u-kind` 文案来自 registry;`attentionAudience` 用共享 kind 表。
- 测试:`attention.test.ts`(新 kind 优先级/受众)、`attention-render.test.ts`(顺序、`founder_ask` 一句话 escape)、新 `founder-attention-sync.test.ts`:伪造 founder_ask + legacy 门 → refresher 标题 `🔔要你答` **且** `readAttentionSources` founder 受众含该 issue;settle 后两边同时清空;再伪造 ship holder → 两边同时变 待批。

### C9 规则与文档
- `department-lead-rules.md` Runner Question Handling:加「需要 founder 决定时,send 带 `founderAsk:{questionId}`;自己能答的不标;误标用 withdraw」;新增小节「Founder attention 由机器派生」:进度/待办不手写进 Epic 页或 thread 标题;不手改 thread 名;lead-note 仅可选判断。
- `runner-patrol-rules.md §0.10` 加一句同义。`cos-lead-rules.md` 不改(cos 不持 issue thread)。`legacy-token-savings/` 副本:bundle 在 token-savings 模式下会替换加载(`lead-rules-bundle.sh:48-51`),**同步同一段**,否则 Codex Lead 读不到。
- `engineering/doc/milestones/FLY-2597.md` 由 ship 时新建;本单不写 CLAUDE.md 表格。

### C10 交付与 QA 交接
- 单 PR、按 chunk 提交;PR body 列消费者 sweep(本单不删 CLI 子命令,写「不适用」)。
- 真机路径见 research §6.2;QA 报告四栏分列。

## 5. 触发与时序保证

| 变化 | 即时触发 | 兜底 |
|---|---|---|
| Lead send+founderAsk | enqueue + epic refresh | sweep ≤ 1 轮转周期 |
| legacy founder 门开 | GatePoller relay 时 enqueue | sweep |
| founder 回帖 | deliverer 钩子 | 下一 pass 重试(cursor 钉住) |
| Lead respond 答掉关联问题 | 无 Bridge 事件 | sweep(验收「下一周期消失」满足) |
| ship 门开/答 | 既有触发,不改 | 既有 |

Discord 改名预算:每个 ask 最多 2 次改名(亮/熄),经每 thread 合并写队列;与 2/10min 限额相容。

## 6. 迁移与回滚

- 迁移:`CREATE TABLE IF NOT EXISTS`,无数据回填;retention 片段同 PR。
- 前向兼容:无 `founderAsk` 的 send 字节不变;无 founder_ask 行的项目派生结果与今天一致(除去掉 `@founder` 正则:此前被正则点进「现在要你看」的 runner ask 将改列 Lead 面板——Lead 已裁定)。
- 回滚:revert PR;表与事件保留(retention 保护类,不删);标题上残留的 `🔔要你答` 由旧代码的 `splitStatusEmoji` 无法识别 → 下一次重盖会把它当 base 前缀 ⇒ **回滚前先跑一次一次性脚本把所有含 `🔔要你答` 的 thread 名剥掉**(实现附 `scripts/fly-2597-strip-needs-answer.mjs`,只读列出 + `--apply`),写进 PR 回滚说明。

## 7. 负向守卫

- 边界校验:`founderAsk` 严格对象(仅 `questionId`);`questionId` 格式白名单;`excerpt` 截断;`askId` uuid 校验;withdraw 校验 project/lead 归属。
- 鉴权:两个路由都在既有 `TEAMLEAD_API_TOKEN` 与 `chatThreadsEnabled && replyByIssueEnabled` 门后;alert 频道 `isGatedAlertChannel` 继续 403。
- 渲染:页面 `excerpt` 经 `escapeHtml`;标题只拼常量徽章,不拼 Lead 文本。
- SQL 全部参数化;CommDB 只读句柄读事实;派生失败不写指纹、不抛进触发方。
- 不用文本猜测:点亮判据只有 holder 行、mailbox checkpoint 列、founder_ask 行三种结构化事实。

## 8. 验收映射

| issue 验收 | 测试/证据 |
|---|---|
| 三种点亮条件各一条测试 | C5 三条 + C4 读取器真 SQL |
| founder 回帖熄灭 | C7 钩子 + C5 settle 后标题回落 |
| 待批覆盖要你答 | C2 矩阵 + C5 ship+ask |
| 固定页只来自同一状态源(伪造→两边同步) | C8 `founder-attention-sync.test.ts` |
| 真机:标记后一周期内出现、回帖后下一周期消失 | QA 529 slot,两个测试 bot,REST 读回 + 页面 md 快照 |
| 规则:不新增手写进展要求 | C9 diff 审阅 |
| 可审计 | C3/C6 事件 + `founder_ask` 行(谁/何时/哪条消息) |

## 9. 风险与已知限制

- 已由 Lead 回复 91b7097e 更正:open founder_ask 的 thread 纳入既有有界回帖扫描,包括无 session Epic;不存在仅能 withdraw 的例外。
- issueStatusWordEnabled 当前恒为 true;emoji-only 仅测纯函数,不是可切换生产形态。若未来恢复开关,须重新设计退回 stage 的行为。
- Lead `respond` 后依赖 sweep 熄灭(最长一个轮转周期),满足验收但非即时。
- 去掉 `@founder` 正则会让此前靠它露面的 runner ask 从 founder 列表消失——需要 Lead 主动标记,规则 C9 承接。

## 10. 实施顺序

C1 → C2 → C3 → C4 → C5 → C8(同源测试)→ C6 → C7 → C9 → C10。每步 `pnpm --filter flywheel-teamlead test -- <file>`(注意 filter 包名必须真名,核 Tests 条数不看退出码)+ 全套 `pnpm test:packages:run` 一次。

## 11. 评审记录

| 轮 | 评审者 | 结果 | 处置 |
|---|---|---|---|
| R1 | Codex(companion,xhigh) | 未跑:当前登录号撞 usage limit(至 2026-09-22 08:16),未写反馈 | 报 Lead(ask `d5196c55`),裁定按 FLY-2560 形态 |
| R1 | Gemini API-key(gemini-cli 0.59,隔离 HOME) | CHANGES REQUESTED,4 条 + 1 advisory | 全部吸收:#1→C4 gates 计数不变量;#2→C1 🔔 守卫显式化并引用既有用例;#3→C3 retention 片段;#4→C6 withdraw 门禁;advisory(emoji-only 模式不渲染要你答需入测试矩阵)→C5 测试矩阵加一条 |
| 收口 | Lead leadAcceptance(instructionId `d5196c55-c224-43eb-806f-5b88fc5a2260`) | effective APPROVED | `design-review.json` 带 `leadAcceptance{instructionId, codexFinalVerdict:"not_run_usage_limit", residue}`;实现 PR 的代码评审须重看本计划 |

原文:`gemini-review-round1.md`(同文件夹)。


## 12. 恢复后的设计复核修正 (2026-09-16, R2 待审)

本节覆盖前文中相冲突的旧约定。R1 effective CHANGES_REQUESTED: question `ed90c2d0-34c7-40c7-b90e-f85d4a45aaba`, request `b4c045b2-ca47-42c2-b2dc-72284ba2a4f4`。原文见 design-review-resume-r1.json。保持原任务范围及 design-correction.md 的 C11。

### 两项 blocking findings

1. `attention-item-key-regex-crashes-epic-page`: 显式将 `ask:<ask_id>` 纳入 attention.v1 未解析 item key 的校验词表,不是伪装成 holder。身份缺失仍以 missing cell 表达,保留来源计数及审计,不让整页失败。C4/C8 必测「open ask + metadata upstream_error/timeout → generateAttentionEpicPage 与 HTML 渲染成功,显示资料不完整,不生成错误 Discord 链接」。不升级 v2,但正式承认并测试这一项 v1 词表扩充。
2. `founder-ask-on-terminal-issue-never-clears`: 两张脸共用的不只是原始来源,还包括 effective attention 的可见性判定。从同一 issue identity 读取当前 session/phase/issue-conclusion/holds,复用 deriveFounderGateTitleState 的优先级。blocked、completed、已批准状态不能保留 answer;ship/原 approve 优先,QA/review hold 继续维持原 ship 行为。页面 founder 列表只接收这个 shared effective result,不能直接把所有 open 行都列上。no-session 不等于 terminal:Lead-owned Epic 上合法 open ask 可亮;标题用该 ask 的 project/lead/thread binding 定位,不能因 getSessionByIssue miss 返回。既有 Layer-2 候选轮转纳入这类 open ask issue,节奏/预算不变。founder 回帖扫描同样合并 open ask 身份,沿用预算/游标。必测 running→blocked/completed/approved 两张脸同步灭、无 session Epic 同步亮/回帖灭。历史 ask 行保留审计,不需人手 withdraw 才能从 founder 页面消失。

### 已接受的边界修正

- Lead 回复 `91b7097e-96e5-4d5a-a94e-def26f781baa` 已确认:持久化 legacy founder gate 的回复确认。使用 project+canonical issue 的 founder_attention_reply 水位(附 thread/message/time),重放只能前移;只抑制早于该真实 founder 消息的 legacy 提醒,绝不写 gate answer/ship authority。同一个事务记录水位并 settle founder_ask;新开的问题晚于水位仍亮。注册 retention 片段,补重开/旧消息重放/新 gate 测试。
- `founder-ask-excerpt-has-no-attention-v1-slot`: 页面沿用 Linear 标题作为一句话,excerpt 仅审计;不新增 fact/item 自由文本字段,不把 excerpt 填进 provenance=Linear 的 title。
- `facts-reader-failure-contract-self-contradictory`: 读取器提供显式 availability(来源 cells 的 missing 加总或 tagged result)。标题 unavailable 保持原状、不 PATCH、不写成功指纹;页面标读失败,不能把未知呈现为已清空。句柄 finally 关闭。
- `question-answered-settle-writes-no-audit-event`: 纯判定发现关联问题已不 pending 时不显示;GatePoller 的有界维护路径幂等 settle(question_answered) 并写既有 settled 事件。只读页面/标题 reader 不额外承担写入副作用。此收敛流程必须在一个轮转周期内完成,补 answered→audit/replay 测试。
- `founder-ask-issue-id-join-key-mislabeled-as-linear-uuid`: founder_ask.issue_id 保存 send 路由最终 resolvedIssueId(与 sessions.issue_id 同键,通常 identifier),不直接存请求体裸 UUID。页面 metadata 根据 uuid/identifier 双别名归一;reply 水位用同一 canonical key。C6 补 UUID 输入→identifier session→title/page 同亮测试。
- `founder-ask-thread-id-stale-after-404-recovery`: 首块 404 recovery 后,与首块 message_id 一起原子回填实际 thread_id。回填前 message_id=null 的行不算 live;回填必须先通过 ask 所属 project/lead/issue 及未回填冲突检查。founder 回帖到实际 thread 才 settle。补旧 thread 404→新 thread 成功→reply settles 与中途失败测试。
- `plan-precedence-text-drops-legacy-approve-badge-below-answer`: 已改 C2 文字,保持既有 approve 分支优先。
- `emoji-only-known-limitation-targets-dead-branch`: 不伪造生产开关;仅纯函数测试 needsAnswerBadge(false),不额外造配置。
- `gates-read-cell-provenance-no-longer-matches-its-count`: gates read provenance 的 key 明列 tables=workflow_gate_holder,founder_ask;每个候选保留自身准确 provenance。count 是有效 StateStore 候选数,并用 holder 1 + ask 1 的完整页面校验验证。

Implementation 原有 C1-C3 已在本地提交;C4 当前为未交付工作稿。本次新 verdict 前不继续生产接线。R2 approved 后按 C4→C5/C8→C6/C7→C9/C11→C10 继续;最终 code review 仍严格绑定单一最终 head,评审期间不推送。


## 13. R3: 无 session 标题清除与 R2 边界澄清 (2026-09-16)

R2 question `cf7a0895-3b5f-4ba6-a437-5ccb823244dc` / request `70ed6df7-f0ed-4509-b69b-c73da1528080` 的 effective verdict 为 CHANGES_REQUESTED。原文见 design-review-resume-r2.json。本节覆盖 C5/C7/C9 与 §6 中不完整的描述。

- **HIGH `no-session-title-has-no-extinguish-branch`**: 在无 session 分支明确区分「显示 needs_answer」与「清除 attention」;当 shared attention 为 null 且无 stage 可恢复时,必须调用 `stampStatusBadgeResult(titleCtx, threadId, null)`。不能用空 stage 调 `stampStageEmojiResult`,也不能把未调用 writer 当作 noop 成功。调用既有 coalescing writer 只剥受管前缀,保留 Discord 读回的 base title。
- 无 session 的 titleCtx 不伪造 Session:从持久 founder_ask 最近一行(包含 settled 行)以及 canonical chat_threads binding 取 project/lead/issue/channel/thread,再从当前项目配置解析同一 Lead 的 token。issueIdentifier 使用 canonical identifier(可证明时填写);issueTitle、routeSummary 不填写;modelMarker 保持 undefined 以保留既有 marker。Face B/C 无 session 时跳过,只做 Face A。绑定冲突/缺失/读取失败返回 deferred,不写成功指纹。
- 清除不能依赖 open ask 的存在:materialize/backfill/settle 时将对应 chat_threads display fingerprint 标为待重算,并 enqueue。Layer-1 的候选读涵盖「有持久 ask 历史但无 session 且 fingerprint 待重算」的 thread,从最近的 ask(包含 settled)恢复定位。一次 PATCH 失败/进程重启不会丢掉清除义务;仅 writer 返回 changed/noop 才持久化成功 fingerprint 并退出待重算集合。Layer-2 仍只以既有 activeLimit/candidateLimit 轮转活的 asks 与活 session,不把全部 settled 历史永远塞进活跃轮转。
- 必测 C5/C7:无 session Epic send+ask → writer 收到 🔔要你答;founder reply settle → writer 收到 null → REST mock 读回 base title;页面同时移除;第二次刷新没有重复 PATCH;清除 writer deferred 后重启→仍能从 settled ask + dirty thread 重试清除。模型 marker 与 issue title 必须保持原值。
- **MEDIUM `legacy-gate-watermark-has-no-re-raise-contract`**: 依 founder 明确要求,任意真实 founder 回帖都熄灭该时刻之前的非 ship 提醒,不猜回复内容。gate 本身、runner waiting_founder 状态与既有 dwell/patrol 都不改变。C9 明确 Lead 责任:发现 gate 仍未答且确需 founder 决定时,使用新的 send+founderAsk(关联原 questionId)重新提出;禁止自动抹水位或周期性无条件重亮。测试「无关 founder 回复→旧提醒灭但 gate pending 与 waiting_founder 不变→Lead 新显式 ask→两张脸再亮」。
- **MEDIUM `effective-attention-silently-changes-ship-lane-on-page`**: 明确选择页面服从现有 title 结果。这是 user 指定「只列当前带状态的 thread」所要求的页面行为收窄,不修改 ship 权限或 title 原有待批语义。§6 前向迁移补充:原页面在 QA/review hold 期间单独列出的 ship 来源,现在从 founder 待你看块移除;解除 hold 后与 title 同时出现。回滚后恢复旧页面列出行为。补 `qaHeld/reviewHeld + ship holder → title/page 同时无 founder attention;解除 hold → 同时待批` 测试。无需修改 holder、gate 或 ship writer。
