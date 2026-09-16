# FLY-2597 thread title「要你答」+ 固定页同源 — 调研
Issue: FLY-2597 (https://linear.app/geoforge3d/issue/FLY-2597/founder-视图单一真相-thread-title-加要你答状态founder-需回复时机器点亮founder-回帖即熄-epic)
日期: 2026-09-15
基于: exploration.md

本篇逐条回答 exploration §7 的六个问题,每条都附实核出处(基于 main `5ad7b9853`)。

## 1. 徽章语法:`🔔要你答` 能否与 `🔔 ⏳待批` 共存

**能,但要加一条守卫。**

- `splitStatusEmoji(name)`(`stage-utils.ts`)先走「注意层」分支:仅当 `name` 以 🔔 开头**且紧跟空白**再跟一个已知主徽章时,才把 🔔 视作受管前缀;否则退到 `splitPrimaryStatusEmoji(name)`,后者遍历 `ALL_STATUS_EMOJI` 做前缀匹配并按 `EMOJI_TO_WORDS[emoji]`(最长优先)剥词。
- 把 `🔔` + 词 `要你答` 注册进 `ALL_STATUS_EMOJI` / `EMOJI_TO_WORDS` 后:
  - `🔔 ⏳待批 [F] [FLY-1] t` → 注意层命中(有空白)→ `{attentionEmoji:🔔, emoji:⏳, word:待批, base:"[F] [FLY-1] t"}`,不变。
  - `🔔要你答 [F] [FLY-1] t` → 注意层不命中(无空白)→ 主层命中 🔔 + 词 要你答 → base 正确。
- **回归风险**:代码注释明确保证「人工写的 `🔔 literal title` 保持原样」。注册 🔔 后,主层会把裸 🔔(无词)也剥掉。守卫:主层对 🔔 **必须匹配到词才算受管**(emoji-only 的 🔔 不是徽章)。在 `stage-utils-badge.test.ts` 加两条:`🔔要你答` 剥/重盖幂等;`🔔 手写标题` 原样保留。
- 备选 `🙋要你答`/`❓要你答` 可完全绕开 🔔 语法,但打破「🔔 = founder 注意」的既有词汇;否决,守卫足够。
- 长度:`🔔要你答` 3 字词,与 `⏳待批`/`🔴受阻` 同量级,Discord 100 字上限无压力(FLY-560 已验)。

## 2. `attention.v1` 能否接纳新源,还是升 v2

**不升 v2;新源以 statestore 表进入既有「gates」桶。**

- `assertAttention()`(`attention.ts`)对 `attention_sources` 的键集是精确匹配(`gates/questions/founder_review/identity_reads/identity/budget`),加第四个读数格 = 改 schema 与所有 fixture。
- 桶归属按 provenance.kind 派生:`linear→founder_review`、`commdb→questions`、其余(statestore)→`gates`;`gates.count` 必须等于 statestore 来源条数。⇒ `founder_ask` 行以 `{kind:"statestore", table:"founder_ask", key:{ask_id}}` 进入,`reads.gates.count` 计入即可通过校验(`holder`/`mailbox` 的专项检查只对 `workflow_gate_holder`/`mailbox` 两张表生效,不波及新表)。
- `registry(kind)` 对未知 kind 给 `unknownAction` + 优先级 4;必须把 `founder_ask` 加进 `ATTENTION_V1.kinds`(kind 文案「Lead 在等你一个决定」,action「去 thread 里回一句」,priority 介于 founder_gate(1) 与 question(2) 之间 → 重排为 ship 0 / founder_gate 1 / founder_ask 2 / question 3 / founder_named 4)。`attention.test.ts` 有按优先级选主源的用例,需同步。
- `isFounderAttention()`(`attention-presentation.ts`)是页面 founder 受众的唯一开关;它与标题的 level 判定必须读同一张 kind 表(见 §5 的 `FOUNDER_ATTENTION_KINDS`)。
- `@founder` 正则在 `flywheel-comm/src/db.ts::listAttentionQuestions()`(第 4120 行附近)——删除后所有非门 ask 归 `lead_question`;`db.attention.test.ts` 第 82/115/181/195 行的期望要改。`question` 这个 kind 保留在 registry(不再产生,避免旧页面校验抖动)。

## 3. Lead 标记表:结构、retention、「已答」判据

### 3.1 表(StateStore,建在 `lead_note` 旁,同一迁移段)

```sql
CREATE TABLE IF NOT EXISTS founder_ask (
  ask_id        TEXT PRIMARY KEY,            -- uuid
  project_name  TEXT NOT NULL,
  issue_id      TEXT NOT NULL,               -- Linear uuid(send 路由已解析)
  channel_id    TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  lead_id       TEXT NOT NULL,
  message_id    TEXT,                        -- Lead 那条 Discord 消息 id,发帖后回填
  question_id   TEXT,                        -- 关联的 runner 问题(CommDB mailbox.id),可空
  excerpt       TEXT NOT NULL,               -- Lead 文本前 120 码点(页面一句话)
  asked_at      TEXT NOT NULL,               -- ISO
  settled_at    TEXT,
  settled_by    TEXT CHECK (settled_by IS NULL OR settled_by IN
                  ('founder_reply','question_answered','lead_withdrawn','send_failed')),
  settled_message_id TEXT
);
CREATE INDEX IF NOT EXISTS founder_ask_open ON founder_ask(project_name, issue_id) WHERE settled_at IS NULL;
```

- 「有效」谓词(纯函数,两张脸共用):`settled_at IS NULL AND (question_id IS NULL OR commDb.isQuestionPending(question_id))`。`isQuestionPending()`(`db.ts:2005`)= 存在、type=question、无 response 子行、未 terminal_disposed —— 与 `getPendingQuestions` 同一谓词,点查。⇒ Lead 用 `flywheel-comm respond` 答了 runner 问题,标记自动失效,无需写回。
- **retention**:FLY-2413 起每张新表必须有 `scripts/lib/fly-2006-retention-tables/teamlead/<table>.json` 片段,否则 `fly-2413-retention-registry.test.ts` 报 `schema_unclassified:teamlead:founder_ask` 直接红。照 `lead_note.json` 写 `classification: "protectedCurrentOrReference"`(实现时核对 classification 词表)。
- 已结束的 issue:派生时若 issue 已终态(`deriveIssueTitleBadge` 给 completed/blocked),标记视为惰性,不改写;thread `archived_at` 分支已提前返回。不做后台清扫。

### 3.2 写入路径:`POST /api/chat-threads/send` 可选字段

```ts
founderAsk?: { questionId?: string }   // 出现即表示「这条在等 founder 决定」
```

- 校验:`questionId` 若给,须匹配 mailbox id 形状(uuid 或 `rstop-`… 之外的现有 id 格式,按 `^[A-Za-z0-9._:-]{8,64}$` 保守校验);非对象 / 多余键 → 400。
- 顺序:**先写行(message_id 为空)→ 发 Discord → 回填 message_id**;Discord 首块失败 → 行置 `settled_by='send_failed'`(不点亮),响应仍是既有 502 信封。这样任何可能已经发出去的消息都有对应的持久标记,不会「发了但没记」。
- 成功后:`issueDisplayRefresher.enqueue(issueId)` + `epicPageRefresher.requestRefresh(project, "founder_attention")`。
- 撤回:`POST /api/chat-threads/founder-ask/withdraw {askId}`(Lead 误标时用,`settled_by='lead_withdrawn'`)。CLI 不新增子命令,Lead 直接 curl(与 send 同鉴权 `TEAMLEAD_API_TOKEN`)。

## 4. 熄灭钩子:挂在 founder-reply-deliverer 的 founder 判定点

- 唯一判定点:`emitFounderReplyDeliveryForThread()` 第 440 行 `isFounder = author.id === ctx.ownerUserId && !bot`;紧接着 `ingestDiscordChat()` 把消息持久化进 CommDB。
- 钩子位置:`ingestDiscordChat` 成功之后、grace 判断之前,调 `deps.onFounderThreadMessage?.({ projectName, issueId, threadId, messageId, tsMs })`。GatePoller 注入的实现 = `store.settleFounderAsksByThread({threadId, messageId, at, before: tsMs})`(幂等:`UPDATE … WHERE thread_id=? AND settled_at IS NULL AND asked_at < ?`)+ 两个 refresh 触发。
- 失败语义:与本文件既有「processed-through」纪律一致——settle 抛错 → `brokeOn = {stage:"founder_ask_settle_failed"}` → cursor 钉住,下个 sub-cadence 重试,走既有 `retryLedger` 有界重试 + dead-letter。不能静默吞:否则 Lead 标记会「永远亮着」而没有任何账。
- 覆盖面:该 pass 为**每个有 thread 的非终态 session** 建任务(有 pending question 的每 pass 必扫;其余按预算轮扫,`FOUNDER_REPLY_SCAN_BUDGET_PER_PASS`),所以 Lead 标记的 thread 一定在扫描集合里(标记的 issue 有 session 才有 thread)。若 issue 已无非终态 session(极端:Lead 在收尾后问),thread 不在集合 → 标记不会被 founder 回帖熄灭;边界写明,靠撤回接口兜底。
- 熄灭必须只熄 founder 回帖**之后**才问的那些标记之前的:比较 `asked_at < founder 消息时间`(snowflake→ms),避免 founder 早先的回帖熄掉之后才发出的问题。

## 5. 同源:一个纯模块 + 一个事实读取器,两张脸都调

### 5.1 纯模块 `packages/teamlead/src/bridge/founder-attention.ts`

```ts
export const FOUNDER_ATTENTION_KINDS = {
  ship:   ["ship"] as const,                       // ⏳待批
  answer: ["founder_gate", "founder_ask"] as const, // 🔔要你答(founder_gate = legacy mailbox founder_review/brainstorm)
};
export type FounderAttentionLevel = "ship" | "answer" | null;
export function founderAttentionLevel(kinds: readonly string[]): FounderAttentionLevel;
// 待批 > 要你答;engine_terminal holder 归 ship(决策 2 默认)。
```

- `isFounderAttention(source)` 改为 `founderAttentionLevel([kind]) !== null`;页面「现在要你看」= `attentionAudience(page, true)`,排序先 ship 后 answer。
- `deriveFounderGateTitleState()` 签名从 `founderGateActive: boolean` 改为 `founderAttention: FounderAttentionLevel`,内部:blocked 优先;`approved_to_ship` 已批 → 无;ship → `{stage:approve, attention:true}`(与今天字节一致);answer → `{kind:"needs_answer"}` 新 badge;null → 原逻辑。refresher 里 `qaHeld/isReviewHeld` 只压 ship(与今天一致),不压 answer。

### 5.2 事实读取器 `founder-attention-facts.ts`(I/O)

- `readFounderAttentionFacts(deps, { projectName, issueId? })` → `Map<issueId, FounderAttentionFact[]>`,来源三段,与 `attention-sources.ts` 今天的三段一一对应但**下沉为共享函数**:
  1. `store.listAttentionGateFacts(project)`(已含 `r.issue_id`)→ kind ship/founder_gate;
  2. CommDB `listAttentionQuestions()` 中 checkpoint ∈ {founder_review, brainstorm} 且 `classifyAttentionMailboxGate()==='legacy'` 的 → kind founder_gate,issue 由 `resolveAttentionQuestionIdentity()`;
  3. `store.listOpenFounderAsks(project, issueId?)` + `commDb.isQuestionPending()` → kind founder_ask。
- 页面:`readAttentionSources()` 改为调它取 1/2/3 段,再拼 Linear 的 `founder_named` 与元数据(Linear 段留在页面侧,标题不需要)。标题:refresher 调它取单 issue。**同一函数、同一 SQL、同一 kind 表** —— 这就是「同源」的可测定义。
- refresher 的注入点:`IssueDisplayRefresherDeps` 加 `readFounderAttention?: (project, issueId) => FounderAttentionFact[]`(默认走真读取器,测试可注入),与现有 `readParkProbe` 同一模式。

### 5.3 触发

- 点亮:send 路由(条件 2/3)直接 enqueue;legacy 门(条件 1)在 GatePoller relay `gate_question` 到 Lead 时对 founder_review/brainstorm enqueue 一次;兜底 Layer-2 sweep(≤ 一个轮转周期,默认 3 分钟 × ceil(活跃 issue/10))。
- 熄灭:§4 钩子 enqueue;Lead `respond` 答掉关联问题时无 Bridge 事件 → 靠 sweep 兜底(可接受:验收只要求「下一周期消失」)。
- Epic 页:新增 `REFRESH_REASONS` 值 `founder_attention`(`model.ts`,`EventRefreshReason` 自动包含)。

## 6. 测试夹具与真机验证路径

### 6.1 单测(全部已有夹具可复用)

| 目标 | 文件 | 夹具 |
|---|---|---|
| 徽章语法 §1 | `bridge/__tests__/stage-utils-badge.test.ts` | 纯函数 |
| level→badge 矩阵(待批>要你答,受阻>两者,已批不亮) | `bridge/__tests__/issue-display.test.ts` | 纯函数 |
| 条件 1(legacy founder_review 门)/ 条件 2(send+questionId)/ 条件 3(send 无 questionId)各一条;founder 回帖熄灭;答掉关联问题熄灭 | `bridge/__tests__/issue-display-refresher.test.ts` | `StateStore.create(":memory:")` + `seedSession` + 注入 `readFounderAttention`;现有 `seedWorkflowRunAt(store,"founder_gate")` 覆盖 ship 优先用例 |
| 事实读取器真 SQL | 新 `bridge/__tests__/founder-attention-facts.test.ts` | 内存 StateStore + 临时目录 CommDB(`new CommDB(path)`,同 `db.attention.test.ts` 做法) |
| send 路由:先写行后发帖、回填 message_id、发帖失败置 send_failed、字段校验 | `bridge/__tests__/chat-thread-routes.test.ts` | 现有 `createTestServer` + `discordFetch` mock |
| 熄灭钩子:founder 消息触发、非 founder 不触发、settle 失败钉 cursor | `bridge/__tests__/founder-reply-deliverer.test.ts` | 现有 fetch mock |
| **同源**:伪造一条 founder_ask → refresher 标题 = `🔔要你答` 且 `readAttentionSources` founder 受众含该 issue;settle 后两边同时清空 | 新 `bridge/__tests__/founder-attention-sync.test.ts` | 上两者合并 |
| 页面受众与优先级 | `epic-page/__tests__/attention.test.ts`、`attention-render.test.ts` | `candidate(n, "founder_ask", "statestore", "founder_ask")` |
| CommDB 去正则 | `flywheel-comm/src/__tests__/db.attention.test.ts` | 改期望 |

### 6.2 真机(QA 节点执行,设计只定路径)

- 529 台架 slot(`scripts/qa-529-generalized-e2e.mjs` 家族)自带 Bridge + slot Lead + 测试频道。slot Bridge 的 `DISCORD_OWNER_USER_ID` 指向**测试 bot 身份 B**,绝不用 founder 本人账号(团队红线,见 memory `feedback_never_act_as_the_founder_identity_use_two_test_bots`)。
- 步骤:slot Lead 用 `POST /api/chat-threads/send` + `founderAsk` 发一条 → 等一个轮转周期 → REST `GET /channels/{thread}` 读 `name` 含 `🔔要你答` → bot B 在 thread 回一句 → 下一周期读回不含 → 同时 `flywheel-comm epic-page show --format md` 两次快照对照「现在要你看」进出。
- 证据分列:单测 / exact-head CI / title 变化 REST 读回 / 固定页渲染;未执行项如实写「未执行」。

## 7. 数字与限额(供计划引用)

| 项 | 值 | 出处 |
|---|---|---|
| Layer-2 sweep 周期 | 60 tick × 3s = 3 min | `gate-poller.ts:1488` |
| 每次 sweep 活跃 issue 数 | 10(候选比对 50) | `issue-display-refresher.ts:runSweep` |
| Discord 改名限额 | 2 次 / 10 min / thread | FLY-560 注释 |
| Epic 页刷新去抖 | 5 s | `EPIC_PAGE_REFRESH_DEBOUNCE_MS` |
| founder 回帖扫描 | 每 pass 全部带 pending 的 thread + 预算内轮扫 | `gate-poller.ts:2556-2580` |
| mailbox 攻读上限 | 1000 行/项目 | `listAttentionQuestions` |

## 8. 决策落定(默认,Lead ask `1183f4e8` 未回前按此)

1. 规则:不动 `summary-inflow.md`;在 `department-lead-rules.md`(Runner Question Handling 节)加 founderAsk 用法与负向规则;`runner-patrol-rules.md §0.10` 加一句「待你看由机器派生,不手写」。`legacy-token-savings/` 副本不动(bundle 是否装载它在实现时 grep `lead-rules-bundle.sh` 确认并记录)。
2. engine_terminal 门:归 ship 档,标题继续 `🔔 ⏳待批`。
3. `@founder` 正则:删除。
