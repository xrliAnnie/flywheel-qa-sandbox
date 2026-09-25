# FLY-2761 固定页漏报「无会话、不在 Epic」的 founderAsk — 调研
Issue: FLY-2761 (https://linear.app/geoforge3d/issue/FLY-2761/固定页漏报-founderask-挂在无会话不在-epic-范围的-issue-上时-现在要你看静默丢掉它attentionaudience)
日期: 2026-09-24
基于: exploration.md

## 1. 约束：attention.v1 校验器（`epic-page/attention.ts` `assertAttention`）

生成期（`generate.ts:751`、`materialize.ts:177`、`attention-budget.ts:115/144`）都会跑 `assertEpicPage` → `assertAttention`。相关不变量：

| 不变量 | 位置 | 对本单的含义 |
|---|---|---|
| `issue_id` 非空 ⇒ `key === issue:<issue_id>` | attention.ts:556 | 补源身份的行 key 是 `issue:FLY-2736` |
| `issue_id` 非空 ⇒ issue_id/identifier/title 三格 provenance 必须是 `linear` 且 `id === issue_id` | attention.ts:569 | **补源身份过不了**，必须放宽 |
| `issue_id` 为空 ⇒ `thread` 必须为空 | attention.ts:592 | 不能「身份不知道但有链接」 |
| `buildAttention` 对 `issue_id` 为空的候选强制把 thread 置 `issue_identity_unknown` | attention.ts:330 | 同上 |

存储过的页面**不会**被重新校验（只有生成期调用 `assertEpicPage`，已 grep 确认），所以放宽校验器是纯加宽：
旧代码回滚后重新生成的页面仍是旧格式，不存在「旧校验器读新页面」的问题。

## 2. 方案比较：身份从哪来

| 方案 | 做法 | 结论 |
|---|---|---|
| R1 | 用 ask 行伪造一条 `LinearAttentionIssue`，provenance 仍写 `linear` | ✗ 谎报来源；审计链说它来自 Linear 其实不是 |
| **R2** | 新增身份来源 `statestore · founder_ask · {ask_id}`；校验器只在该 ask 是本行自己的来源之一时接受 | ✓ 来源真实、可审计、范围最小 |
| R3 | 放宽「身份不知道也可带链接」 | ✗ 推翻 FLY-2597 的不变量；行里 identifier 仍是「不知道」，founder 看不出是哪张单 |
| R4 | Linear 元数据查询对 ask 身份去掉 project/label 边界 | ✗ 改网络查询边界；Linear 挂了照样丢；也没解决呈现层的静默过滤 |

选 **R2**。

## 3. 讨论串从哪来

两条路：直接用 ask 行的 `thread_id`，或走已解析 issue 共用的 `resolveAttentionThreadBinding`（`StateStore.ts:3624`）。

- `bridge/tools.ts:882-957`：ask 行的 `(issue_id, channel_id, thread_id)` 就是 `getChatThreadByIssue(resolvedIssueId, channelId)` 那一行（或刚 `ensureChatThread` 建出的那一行）；
  `chat_threads` 有 `UNIQUE(issue_id, channel_id)`。所以「以 ask.channel_id 为权威频道查绑定」拿到的就是 ask 自己的讨论串。
- 共用解析器还带来：项目频道约束（`channelIds` 之外的频道 → `no_thread_binding`）、`discord_missing_at` → `thread_missing`、Discord ID 格式校验。
- 同一 issue 上有多个来源（例如 ask + holder）时，它们本来就共用一个 issue 级讨论串；走同一条路不会出现两套链接口径。

选**共用解析器**：现有 `gateChannels/otherChannels` 聚合已把 ask 的 `channel` 当作该 issue 的候选频道，只要身份不再是 undefined，这段代码原样可用。

## 4. `founder_ask.issue_id` 的形状

- `tools.ts:882-891`：「canonical thread key = session 的 issue_id（实践中是 identifier），否则 identifier——**never the bare Linear UUID**」。
- 生产库只读统计（2026-09-24，`sqlite3 -readonly`）：`flywheel` 项目 156 行，156 行都是 `^[A-Z][A-Z0-9]*-\d+$` 形状。
- 防御：只有 identifier 形状的 `issue_id` 才补源；否则维持「身份不知道」——**但仍会被 A 列出并计数**，只是没有标识和链接。
  这样也不会把 UUID 之类内部标识渲染到公开页面上（`attention-render.test.ts` 「never renders internal identity sentinels」）。

## 5. 标题（title）

补源身份没有 Linear 标题：title 格为空，`missing: issue_title_unknown`，行里显示「不知道」。
不用 ask 的 `excerpt` 顶替：FLY-2597 定过 excerpt 只留审计（`attention-sources.test.ts` 「keeps the page renderable…」断言页面不含 excerpt）。
founder 点讨论串即可看到原文。

## 6. 其它 founder 视图

- thread 标题（`issue-display-refresher.ts`）：走 `readEffectiveFounderAttention`，与 session 无关，
  `bridge/__tests__/founder-attention-sync.test.ts`「Lead-owned Epic with no runner session」已覆盖无 session 点亮「🔔要你答」。不改。
- `attention-budget.ts`：只按 founder 优先排序截断并打 `budget_incomplete`，不看身份。不改。
- 审计：身份格的 provenance（`founder_ask · {ask_id}`）与该行 ask 来源的 fact provenance 相同，公开页本来就不渲染 attention provenance；
  新测试断言页面字节里没有 ask_id。

## 7. Markdown 计数口径

`render-markdown.ts:492` 摘要传 `page.attention.length`（含只在等 Lead 的项），HTML 传 founder 行数。
FLY-2597 的 `attention-render.test.ts`「distinguishes a successful unresolved identity lookup…」把这个差异钉成 HTML 1 / Markdown 3。
「计数对得上」要求 N 与列出的行一致，所以 Markdown 改为与 HTML 同口径（founder 行 + 班车行）；该断言随之改成两端都是 1。

## 8. 回滚

纯代码回滚。无迁移、无新表、无新配置。旧代码重新生成页面即恢复旧行为（包括重新静默丢弃）。
