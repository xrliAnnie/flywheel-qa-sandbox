# FLY-2430 Lead 返工署名收窄 — 调研
Issue: FLY-2430 (https://linear.app/geoforge3d/issue/FLY-2430/批准通路缩小-现有-rework-端点已能让-lead-替-founder-提返工-只修它的署名feedback-记成-lead-提交)
日期: 2026-09-07
基于: exploration.md

## 1. 入口与身份来源

`runs-route.ts` 已把 `leadId` 作为可选字段传给 founder-consent evaluator，但真正写 request 时只传 `principal:"master"`。master bearer 证明调用者持有管理 token，不是可展示的语义作者。

为保持新 run 的现有三字段请求兼容，同时让 legacy run 的失败可恢复，actor resolution 采用：

1. body 明确提供非空 `leadId` 时用它；
2. 否则用 `workflow_run.selected_by`；
3. actor 必须存在于该 run 的 `project_name` 对应 `ProjectEntry.leads[].agentId`；
4. 在 roster 校验前显式调用 `isReservedApprovalAttribution`，拒绝 `bridge`、`bridge-founder-consent` 与 17–20 位 snowflake；
5. 缺失、reserved 或非 roster actor 都在 collect-quiescence / `openOperatorRework` 前返回 typed 4xx，证明无 durable write。

`selected_by` 是 nullable，且历史库存在 NULL；字面量 `unassigned` 也不是 actor，必须拒绝。缺失时返回 `LEAD_ATTRIBUTION_REQUIRED`，并在 `doc/engineer/implementation/turn-manual-handoff-runbook.md` 的 rework 恢复项明确要求补 `leadId`。reserved 返回 `LEAD_ATTRIBUTION_RESERVED`，非 roster 返回 `LEAD_ATTRIBUTION_NOT_CONFIGURED`。因此兼容性边界是：已绑定 configured `selected_by` 的现有三字段调用不变；未绑定的 legacy run 通过显式 `leadId` 恢复，不再匿名写入。

这不是密码学上的 per-Lead token。现有 endpoint 仍由 loopback + master token 保护；本单只让该受保护调用面落下真实的 Lead 语义署名，不扩大认证系统。

## 2. Founder quote 捕获

现有 `fetchDiscordMessageFromChannel` 已验证 response id、author id 与 timestamp，但 DTO 丢弃 `content`。它只有 rework route 两个读取调用点，因此可以在共享 helper 中把 Discord `content:string` 纳入成功 DTO；“合法”只要求类型为 string，空字符串是 embed/attachment/sticker-only 消息以及 Message Content 不可见时的合法返回，必须作为显式空 quote 保留，不能改成 5xx。测试 fixture 同步补正文与空字符串对照。

有 `founderMessageRef` 时继续沿用全部现有防错条件：

- 当前 run 必须恰有一个 founder gate holder；
- holder 必须绑定 card；
- 用当前 gate bot token 读取引用消息；
- 引用作者必须等于 canonical founder id；
- 读取当前 card，引用必须在同一 channel/thread，且时间不早于 card/holder；
- 保存 `{message_id: referenced.message.id, text: referenced.message.content}`，不 trim、不改写正文。

没有引用时保存 JSON `null`，而不是省略字段。`lead_feedback` 仍按现有 API 规则 trim，最大 4000 字；这两种文本从进入 StateStore 起不再共用同一个 `feedback` 字段。

## 3. Durable schema

现表：

```sql
workflow_rework_request(
  authority CHECK IN ('qa','founder','engine'),
  authority_context_json,
  authority_context_digest,
  founder_feedback_verbatim,
  ...
)
```

新表增量：

```sql
authority CHECK IN ('qa','founder','engine','lead')
actor_id TEXT
founder_quote_json TEXT
lead_feedback TEXT
```

并增加 conditional CHECK：`authority='lead'` 时 actor 非空、`founder_quote_json` 是合法 JSON 且只允许 `null` 或同时含非空 `message_id`/string `text` 的 object、`lead_feedback` 非空、`founder_feedback_verbatim IS NULL`；非 lead 旧行允许三个新列为 NULL。写入层同时把 `authority_context_json` 固定为：

```json
{
  "authority": "lead",
  "actor": "flywheel-eng-lead",
  "founder_quote": {"message_id":"...","text":"逐字原话"},
  "lead_feedback": "Lead 给实现体的指令",
  "sourceEventId": "...",
  "sourceNodeId": "...",
  "sourceAttempt": 1,
  "targetNodeId": "implement",
  "targetAttempt": 2,
  "baseRevision": "...",
  "baseRevisionSource": {}
}
```

旧库通过现有 rebuild 迁移模式复制原列，新列填 NULL；两次启动幂等，`foreign_key_check` 保持零新增 violation。迁移 sentinel 必须从只检查 `"'engine'"` 改为同时检查 `"'lead'"` 与三个新列，否则 production engine-era schema 会被错误跳过。测试 fixture 从已经包含 `engine`、但尚无 `lead`/新列的 schema 起步，而不是只测 pre-engine schema。历史误署名行不自动改写。

## 4. Source event 与 replay

不新增 kind。现有 source uid `operator_rework:<runId>:<clientRequestId>` 和 `operator_rework_requested` 保持，以免扩展 coordinator/resume kind registry。

新 `operator_rework_requested` receipt 与 `rework_requested` payload 都明确使用：

- `authority:"lead"`
- `actor:<lead id>`
- `founder_quote:<object|null>`
- `lead_feedback:<string>`

为保持跨部署 replay，source receipt 暂时保留 legacy alias `feedback=<lead_feedback>` 与 `principal:"master"`，但任何展示/engine consumer 都不得读取它们；新 receipt 同时带上述四个权威字段。replay 遇到新 shape 时比较 target、actor、quote、Lead feedback、escalation ack 与 founder quote evidence digest；遇到 pre-deploy shape 时只沿旧 `feedback`/`principal`/evidence comparator 接受原请求的无写 replay，绝不把历史 row 伪升级为 Lead attribution。

operator rework 的 gate supersession、claim revocation、route、delivery、verification path、TURN 与新卡生成逻辑保持原样。

### 4.1 Chained verification writer

`openOperatorRework` 不是唯一会写 Lead authority 的位置。正常验证路径在 implement 完成后，`recordWorkflowTransition` 会从 active parent request 继承 authority，并为下一验证节点新建 child `workflow_rework_request`。当 parent 改为 `lead` 后，child 必须同时逐字段继承 parent 的 `actor_id`、`founder_quote_json`、`lead_feedback`，并把同一结构写进 child authority context；否则新 CHECK 会中断主路径。继承只允许在 `chainedRework && activeRequest.authority === 'lead'`，字段缺失/不一致时 transaction fail-closed，不从 legacy alias 或文本猜测。

## 5. 两种 Runner 消费面

### 5.1 复用旧 actor（phase wake）

Coordinator 已发送：

```json
{"requestId":"...","authority":"lead","authorityContext":{...},"target":{...}}
```

`renderWorkflowReworkWakeContent` 增加只读 formatter：当 request/authority context 是合法 lead shape 时，在 JSON 前明确输出 `Rework submitted by lead:<actor>. Lead feedback and founder quote are separate in Rework context.`。JSON 本身保留结构化字段供 runner/replay 使用。

### 5.2 新 replacement actor

Dispatcher 当前只产生 `replacementContext.founderFeedback`，最后拼接固定标题 `Founder feedback for this revision`。改为 authority-aware render：

- founder request：保持现有 founder-verbatim 标题与文本逐字行为；
- lead request：从 request 的 `actor_id`、`lead_feedback`、`founder_quote_json` 读取并交叉验证 authority context 后，渲染：
  - `Rework submitted by lead:<id>`
  - `Lead feedback:` + Lead 文本
  - `Founder quote (message <id>):` + 原话，或 `Founder quote: none (Lead submitted independently)`；
- QA/engine 与普通 dispatch 不变。

由 request 分列读取而不是从 `founder_feedback_verbatim` 猜测，避免相同文本再次冒充 founder。

## 6. TDD 与阴性对照

第一批失败测试放在真实写入/route 位点：

1. `StateStore.workflow-rework.test.ts`：operator open 预期 authority lead、三分列、payload、replay conflict、`founder_feedback_verbatim:null`；迁移两次启动保留旧行并支持 lead schema。
2. `runs-route.founder-message-ref.test.ts`：actor 从显式/selected_by 解析，quote 捕获逐字或空 content；reserved、snowflake、非 roster、`unassigned`、无 actor 全部拒绝且 `openOperatorRework` 未调用。
3. `workflow-engine-dispatcher.test.ts`：真实 replacement request 的 agent content 明示 lead，Lead feedback 与 founder quote 分段；无 quote 显式显示 none；原 founder request 的旧标题仍通过。
4. `workflow-rework-wake-copy.test.ts`：lead context 明示 `lead:<id>`，字段仍分列。
5. `StateStore.workflow-rework.test.ts`：真实 operator open → delivery active → implement transition → chained QA request，断言 child 继承 Lead attribution 且路径继续。
6. `StateStore.workflow-rework.test.ts` 阴性：Lead feedback 为 `approve`/approval JSON 时 event 集仍无 `founder_approval`；23:05 缩小范围不授权新增内容分类器，因此该文本仍会作为普通 rework 指令接受，而不是满足旧版“拒绝”判据。
6. 现有 FLY-2427 `respond` / healthy holder tests 继续证明 Lead response gate 被拒；本实现不触碰这些文件。

## 7. 风险与控制

| 风险 | 控制 |
|---|---|
| actor 取错 run/项目 | 先读 run，再按 `run.project_name` 的 frozen router projects roster 校验 |
| body 冒充 founder/Bridge | `isReservedApprovalAttribution` + roster 双拒绝 |
| quote 正文在 helper 丢失 | 成功 DTO 必须含 string content（允许空），route 逐字传递 |
| lead request 仍被 founder consumer 读取 | lead 行强制 `founder_feedback_verbatim IS NULL`；dispatcher 按 authority 分支 |
| 同 request id 换 actor/文本 | replay 比对完整 provenance shape |
| migration 破坏外键/immutable triggers | 沿现有 rebuild + boot 后 trigger install；双启动 + FK executable test |
| chained request 丢失 Lead provenance | child request 只从已校验 parent Lead columns 继承；真实 active-path transition test |
| 范围回弹成新通路/同卡 | event kind、gate supersession、card lifecycle 均不改 |

## 8. Design review R1 收敛

- HIGH `chained-rework-inherits-lead-authority`：接受；增加 §4.1 writer、继承规则与真实 chained transition test。
- migration sentinel：接受；从 engine-era fixture 起步并显式修改 early-return 判据。
- legacy actor：接受；明确三个错误码、拒绝 `unassigned`、更新应急 runbook，显式 `leadId` 是 legacy escape hatch。
- legacy receipt replay：接受；保留旧 aliases，仅为 pre-deploy idempotent replay 使用。
- Discord empty content：接受；只拒绝非 string，空 string 显式保存，不依赖“必有非空 Message Content”假设。
- authority readers / test paths：接受；补全 sweep、lead route-revision negative 与准确路径。
- approval-shaped feedback：按 23:05 范围裁定明确记录偏离；只证不产生 approval，不新增 reject classifier。
