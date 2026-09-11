# FLY-2483 现在要你看 — 实施计划
Issue: FLY-2483 (https://linear.app/geoforge3d/issue/FLY-2483/进度页e2-现在要你看attention-三路合并-固定四段格式-跳-discord-threaddiscordguild-id)
日期: 2026-09-09
基于: research.md

## 1. 交付效果与范围

首屏固定显示本项目等你处理的事项，不受有没有挂进 Epic 影响。Epic 是带子单的大任务；本次保留它和子单原来的渲染。每件事完整显示“这是什么 / 需要你做什么 / 等了多久 / 去哪儿做”，可用时跳本单的 Discord thread，即该单专属讨论串。没有事明确写“现在没有等你的事”，查不全则写“清单不完整”，不能混为一谈。

本单完成六项 issue 要求：独立三路合并、attention.v1 固定词表、四段、guild 持久化及真 thread 链接、QA 实点截图、排除 declared_blocked。仅做 E2，不依赖 E1，不升级 scope.v1，不补 parent、rollup、lead_note 或 Epic 排序/依赖布局。此节点只交设计；下列代码工作属于 implement，实点属于 QA。

## 2. 数据流

源图见 `d1-flow.mmd`，数据结构图见 `d2-model.mmd`；HTML 使用本地渲染 SVG，失败时按任务规定保留图源及待渲染标识。

生成器并行读取项目独立 attention 来源与现有 Epic snapshot。attention 读取 StateStore 当前 founder 门、项目 CommDB 未答问题、Linear 项目绑定范围内的 founder-review 未终态单。合并后补充 issue 身份/标题及 canonical thread 绑定。新文档 v2 同时携带来源叶子 Cell、合并结果、可用性。HTML/Markdown 均只消费该文档，不再查库或出站。

## 3. 来源的精确边界

### 3.1 当前 founder 门

在 `StateStore.ts` 新增只读 `listAttentionGateFacts(projectName)`，返回完整 source/question/run/node/attempt/issue/execution IDs、状态、authority mode、开始时间和出处，仅供内部合并及受认证 JSON。托管 HTML/Markdown 不输出这些内部 ID（见 §5）。参数化 SQL 初筛 run.project_name 匹配、run active、holder awaiting_review、holder 对应 run.current_node_id、node attempt 一致、node review 且 ended_at IS NULL、卡未 void、没有更晚的当前 holder。holder.created_at / node.started_at 在 SQL 投影中按现有写法 `strftime('%Y-%m-%dT%H:%M:%SZ', ...)` 转成 UTC RFC3339；禁止把 SQLite 的无时区 datetime 直接交给 Date.parse。再复用 `makeGateAuthorityView.resolve` 对 pinned 工作流做权限确认；不重写权限解释器。

只读投影不调用 approve、不答 gate、不改变 state。land/runner_ship → ship；engine_terminal → founder_gate。不同状态 approved/superseded/materializing、旧 attempt、旧 head/作废卡、终态 run 全部不出现。source session 已结束但 engine holder 仍有效时仍出现。完整 question ID 用于把 holder 与同一 mailbox gate 合并为一个来源，不以 execution_id8 合并。

Legacy mailbox founder 门采用现有 founder 展示 allowlist：approve_to_ship → ship，founder_review/brainstorm → founder_gate；先排除与当前权威冲突或已 superseded 的历史问题。review_design/review_code、自动 reviewer 门不纳入。未知 checkpoint 不自动升级为 founder 门；只有已证明为 founder authority 且未知 kind 的来源才能进入未知类型分支。

### 3.2 question_pending

新增 `CommDB.listAttentionQuestions`，读 `commDbPathForProject(projectName)`，沿用 canonical open 语义，直接读 `mailbox` 基表（recipient_kind 不在兼容 projection 视图）：

```sql
SELECT q.id, q.from_agent, q.checkpoint, q.relay_state, q.created_at,
       q.kind, q.content, q.to_agent, q.recipient_kind,
       strftime('%Y-%m-%dT%H:%M:%SZ', q.created_at) AS since
FROM mailbox q
WHERE q.type = 'question'
  AND q.relay_state != 'terminal_disposed'
  AND q.superseded_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM mailbox r
    WHERE r.ref_id = q.id AND r.type = 'response'
  )
ORDER BY q.created_at, q.id;
```

不改 mailbox-schema.ts 的 projection SELECT/版本，不 bump MAILBOX_MESSAGE_PROJECTION_VERSION，不触发一次性的 legacy-push→notified 迁移；此 reader 没有 schema mutation。SQL 返回的 q.content 仅在 reader 内用于标准停止报告分类，分类后立刻丢弃，不返回给生成器；spilled 问题按已有 kind/id metadata 识别，缺分类依据要显式标未知来源，不能回显正文。分页增加参数化 `(created_at,id)` cursor 与 LIMIT，不把客户端字符串插入 SQL。没有 14 天/到期过滤，不 inner join latest/live session。复用现有标准 stop report 分类器，不把停止报告当问题；runner_stopped/标准停止报告不进入。declared_blocked、run_held 是 StateStore signal，本 mailbox 路天然没有；它们本身不是第四条 attention 来源，不是对整张 issue 的否决。先识别 §3.1 founder 门，再按现有 question_pending 分类规则收集其余问题，明确排除自动 review checkpoint。

问题身份按 exact card binding → 同项目 session → 唯一 workflow execution/run binding 解析；多 activation 歧义不取最新。没有身份的未答问题保留 `question:<full-id>` 独立行，单号/标题/链接写不知道。不得解析 message content 中的单号或人名。内部读取 protected/stop 分类所需字段，但 raw content/from_agent 不进入页面文档。

本单按指派把 question_pending 纳入；它当前也可能等 Lead 回答，不宣称存在独立的“已升级给 founder”字段。页面主动作仍按 PRD 固定文案；同一②段必须紧接明确角色提示，例如“记录收件方：Lead；当前在等 Lead 回复，你可进入讨论串了解情况”。reader 将基表 recipient_kind 的精确枚举 `lead/bridge/runner` 原样写入独立 `recipient_role:Cell<string>`，provenance 为 commdb/mailbox/question ID；无效或缺失用 source_unavailable，不把 to_agent 原值或 displayName 输出。不从 lead 类型推导 founder 接收事实；未知收件方写不知道。kind/action 仍由唯一 registry 生成，角色提示不是第二套动作词表。若以后要只显示已升级问题，需要单独定义权威字段，不能本次用自然语言猜测。

### 3.3 Linear founder-review

新增 `bridge/linear-attention-query.ts`。复用 FOUNDER_REVIEW_LABEL 常量与 ProjectLinearBinding 边界；GraphQL variables 以 AND 组合 team.key、可选 project、可选 scope label、精确 founder-review 标签，`state: { type: { nin: ["completed", "canceled"] } }`，includeArchived:false。没有 parent、children、started、backlog 条件。标签范围 + founder-review 要两个 AND 子句，不用 labels.in OR。`nin` 已按 [Linear 官方 comparators](https://linear.app/developers/filtering) 核对；实现测试还须用 SDK 的 IssueFilter 类型/satisfies 编译或与当前 schema 校验 query，不能仅 mock 成功响应。

读取 id/identifier/title/url/state.type/labels 与 project/team 验证字段，禁止 assignee.name、creator.name、正文进入 attention。通过同一小型查询批量补齐门/问题的 issue 元数据，不从 Epic items fallback。source issue 身份不匹配项目则不暴露外项目标题/thread，并保留项目内原未答记录的未知身份提示。

每页 50，最多 1000 个原始记录/路、总查询 deadline 15 秒；去重前看 1001st/hasNextPage，达到边界且仍有更多就标 `source_truncated`，不是读完。缺游标/超时/API errors 都标源不可用。三路分别返回成功空/成功非空/缺失，不用 [] 吞错；已读到的行可保留，但计数注明“已知 N 件，清单不完整”。生产负载要求超过上限时不能声称满足全量，要提高经体积验证的边界后再验。

## 4. 合并、词表与等待时间

Canonical key = `issue:<Linear UUID>`；未知身份 = `question:<完整 ID>` 或 `holder:<完整 ID>`。同 UUID 合成一行，question ID 精确折叠同一门的两种记录；各源证据及独立问题均保留。先使用 StateStore 已验证的 issue aliases，再补齐 Linear；若补齐失败，保留不能证明同一身份的原记录，绝不猜测合并。受影响 issue_id Cell 标 issue_identity_unknown，新增 attention_sources.identity Cell 标 source_unavailable，整个区明确“清单不完整，身份尚未核齐，同一件事可能暂列多条”。不得把暂列行数说成已去重事项总数；只可称“已知 N 条记录”。key 稳定性只保证相同身份事实输入下稳定；补齐恢复后 provisional key 可以变成 UUID key 并重新合并，不为旧临时 key 持久化反馈或授权。排序按 identifier 的固定数值友好顺序、再 key；未知单号排末。顺序不表示优先级。

在 `epic-page/attention.ts` 定义唯一 ATTENTION_V1 registry，同时拥有稳定 kind ID、①类型词、②动作、合并主显示顺序。generator 按它输出 kind/action Cell，两个 renderer 不复制第二套映射。优先顺序是 ship → founder_gate → question → founder_named，仅选主显示，不丢较低来源。②按同顺序附加其它不同动作，注明“另有 N 条待回答记录”，完整来源列表可展开；同 issue 多个问题不会无声消失。

- `founder_gate`：在等你按一下 → 去 thread 里回一句「同意」或「打回」。
- `question`：体在问你一句话 → 去 thread 里回答它的问题。
- `ship`：ship 卡在你手里 → 去 thread 里点 :cool: 或说停。
- `founder_named`：你点过名要回来找你 → 去看一眼,决定继续还是停。
- 已被允许进入但不认识的类型：kind.value 保留原始 kind，action.value = 不确定,去看一眼；不改成已知类别。raw kind 限长、转义，不允许用未知类型绕过来源准入。

上述文案是导航提示，不新增任何批准途径，:cool: 仍由原授权链判定。页面留言与页面访问都不算批准。

③使用被选主动作的最早仍有效来源时间；如果该主动作有未知起点，不借其他类型的时间填补，显示不知道。mailbox 用 created_at；holder 用 created_at 或可证明对应的 gate node.started_at，不用 updated_at。label-only 没有标签应用时间，一律 `since_unknown`，不拿 issue.createdAt/updatedAt 冒充。

有效时间统一存 RFC3339 UTC 字符串；SQL 归一输出 NULL 或格式不对 → invalid_since。新增 assertAttentionSince 对 since.value 单独验证 RFC3339 UTC 正则及日历有效性，先验格式再 Date.parse；拒绝非 T/Z 格式，禁止 V8 本地时区宽松解析。展示“自 HH:MM 起,已等 N 小时”，显式标 UTC 与日期（跨日不能只给时分）。N 按 renderNow-since 向下取整小时；小于一小时显示 0 小时并补“未满一小时”。非法日期/未来时间显示“自 不知道 起,已等 不知道 小时（起点无效）”，不把负数夹成 0。年龄由展示时计算，不作为新持久化事实。

### 4.1 体积降级，不能让长清单挤掉原 Epic

每路1000仅是读取资源上限，不是页面行数承诺。新增 attention-budget.ts 在最终 assertEpicPage/buildReceipt 之前处理未提交的完整候选模型：保持原 Epic 字节及各 raw source read-health，按稳定 key 排序，只保留能同时满足 JSON 1,507,328 bytes 和 HTML 512 KiB 的最长完整行前缀。预算通过真实 canonical JSON UTF-8 字节和最终 renderer HTML UTF-8 字节计算，计入 escaping、全部 source Cells、warnings 和 freshness；不拿平均2KB作硬保证，不按字符串切半个 Cell/来源列表。每次候选前缀都重新生成派生指针/summary/freshness，再验体积，最后只写一次最终 receipt。实现先预留固定最坏提示文案空间，以二分前缀数+末端实际校验减少渲染次数；边界提示状态切换造成非单调时取较小已验证前缀，不把未验证结果当可装下；validator 和 publisher 保留最终独立 size guard。

若省略任何行，attention_sources.budget.value=null/missing=source_truncated，页面及 Markdown 显示“已知 N 条记录，清单不完整（体积上限，部分事项未显示）”；此时即使 N=0 也不能显示没事。完整装下时 budget.value={retained:N}；其 provenance 为 attention.v1，from 指向三路读取 Cell 与 identity Cell。无 source 列表截断、不装不下就删 Epic 卡。若原 Epic 基础文档连最小新提示块都容不下，则走现有 size 失败并保留 last-good，这是原系统硬上限，不声称任意无界输入都可生成；独立 telemetry/CLI 返回 size failure，不能谎称已更新。

C5 必测近上限 Epic+大量 attention、单行带大量来源、标题转义膨胀、刚好边界与多一字节；产物保留旧 Epic 完整，attention 显式不完整且非假空。最终以实际 per-row/max-fixture 字节报告给出环境能显示的行数，不能提前写“1000条可展示”。

## 5. v2 数据结构与校验

文档 `schema_version:2`、`generator.version:epic-page/2`。保留现有字段，再新增 `discord`、`attention_sources`、`attention[]`、`epic_scope`。类型草案（每个 Cell 都遵循现有 value-null iff missing）：

```ts
type AttentionSource = {
  fact: Cell<{ id: string; kind: string; state: string; authority_mode?: string }>;
  recipient_role?: Cell<"lead" | "bridge" | "runner">; // required for mailbox source, absent otherwise
  since: Cell<string>;
};
type AttentionItem = {
  key: string; // stable structural key, reconciled against source identity
  issue_id: Cell<string>;
  identifier: Cell<string>;
  title: Cell<string>;
  sources: AttentionSource[];
  kind: Cell<string>;
  action: Cell<string>;
  since: Cell<string>;
  thread: Cell<{ thread_id: string; channel_id: string }>;
  thread_url: Cell<string>;
};
type AttentionExtension = {
  discord: { guild_id: Cell<string> };
  attention_sources: {
    gates: Cell<{ count: number }>;
    questions: Cell<{ count: number }>;
    founder_review: Cell<{ count: number }>;
    identity: Cell<{ resolved: number; unresolved: number }>;
    budget: Cell<{ retained: number }>;
  };
  attention: AttentionItem[];
  epic_scope: Cell<{ available: true }>;
};
```

所有 mailbox 来源（含 question）必须有 recipient_role 的原始 commdb Cell；其它非 mailbox 来源不允许该字段，不虚构它有收件人。validator 同时验证此条件与 lead/bridge/runner 枚举，不把角色当作没有输入证据的 derived。sources 为 plain array，里面是叶子 Cell，禁止 Cell.value 再嵌 Cell。原始事实用 statestore/commdb/linear provenance；kind/action/since/thread_url 用 derived `attention.v1`，from 指向同一文档真实 source Cells（thread_url 精确指向 `/discord/guild_id` 与 `/attention/i/thread`）。title/identifier 引用真实 Linear issue；无法补全时保留可追踪的原 source provenance + missing，不写伪 Linear ID。

扩展 `epic-page/model.ts` 的 RULE_IDS 数组加入 attention.v1（它是 assertProvenance 的准入门）。`rules.ts` 的同名映射不新增第二条 attention 常量；attention.ts 的 registry/ruleId 必须满足 model.RuleId 类型，不复制词表。MissingReason 增加 `no_guild_configured`、`invalid_guild_config`、`no_thread_binding`、`thread_binding_conflict`、`thread_missing`、`invalid_discord_id`、`issue_identity_unknown`、`issue_title_unknown`、`since_unknown`、`invalid_since`、`source_unavailable`、`source_truncated`、`epic_scope_unavailable`、`legacy_attention_unavailable`。detail 只能是有限安全原因，不存 raw error。

`assertEpicPage` 接受 exact v1 或 exact v2，不放宽通用 unknown key 检查。v2 四个新块必须全有；key/source identity 一致、key 唯一、来源非空、source count 不负、缺失三路不允许声称 complete；重算 registry 对 kind/action 与选择的 since 做一致性校验，URL 必须精确等于两个源 ID 组成的地址。未知 kind 保留原值但固定未知 action。篡改 URL、来自不存在 Cell 的指针、v2 缺字段均拒绝。

内部完整 IDs 只存在于合并模型、受认证 JSON 和 source-only receipt。新增 attention 的 HTML/Markdown renderer 不能复用会输出 raw value/provenance.key 的通用 audit renderer，不内嵌整个 JSON。公开 `data-attention-key = 'a-' + sha256('attention.v1\0'+projectName+'\0'+canonicalKey)` 的完整64位hex；来源展开仅显示角色、源类型、时间和所需正常单号。完整 question/run/node/execution UUID 不进入文本、HTML注释、data属性、JS或 href；公开 hash 不是授权令牌。实现测试注入完整内部 ID sentinel 后对整个 HTML/Markdown 字节断言 absence，JSON 内部输出仍保留可审计原始身份。

新 generator 必须显式收到来源读结果；测试/调用者不能因省略依赖而默认为成功空。旧 v1 输入只用于兼容读取/旧文档测试，首屏显示“现在要你看：不知道（旧版尚未采集）”，不能解释为没人等待。现有远端 CLI 透传 JSON；旧严格消费者必须随新版升级，v2 不谎称旧严格读取器可用。

receipt 继续 schema v1，仅保存出处与时间，不复制 attention 值。新增原始源 Cell（含 mailbox recipient_role）加入 generate 的 freshness sourceCells，receipt walker 收集其中 linear/statestore/commdb 来源；budget 保持 derived，不进入 source-only receipt。identity 明确定义为 derived attention.v1，from 指向本次保留行的全部 issue_id Cell 和三路原始 read-health Cell；只计保留行的 resolved/unresolved。任一 issue_id 为 issue_identity_unknown 时 identity.value=null/missing=source_unavailable，计数不宣称完整；被体积省略的行由budget单独标不完整。未丢行且三路成功空时identity为{resolved:0,unresolved:0}。validator重算该规则，保证计数/缺失状态可从文档叶子重建。freshness可引用derived identity/budget，但回执只保留被引用的原始叶子，不保存derived格。回归 derived.from、oldest_source、内容摘要及 legacy receipt 迁移。unknown 类型与 disabled 链接的缺失原因在 HTML/Markdown/JSON 必须一致。

## 6. guild 单份持久化与 thread 解析

`StateStore` 增量创建表 `discord_config`，只有一个实例级配置行：

```sql
CREATE TABLE IF NOT EXISTS discord_config (
  singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'discord'),
  guild_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('configured','missing','invalid')),
  source TEXT NOT NULL CHECK (source = 'DISCORD_GUILD_ID'),
  source_updated_at TEXT NOT NULL,
  CHECK ((state = 'configured' AND guild_id IS NOT NULL)
      OR (state IN ('missing','invalid') AND guild_id IS NULL))
);
```

Bridge `StateStore.create` 之后、所有 page consumers 启动之前，用 resolved config.discordGuildId 调 `syncDiscordConfig`。trim 后必须匹配 `^[1-9][0-9]{0,19}$` 且 BigInt <= 2^64-1，始终存/传字符串。missing/invalid 显式写 guild_id=NULL；不能读旧值补回。值/state 相同时不更新时间，不伪造配置修改；新行或变化写观察到配置变化的时间。SQL 全部 bind，事务提交失败则本次 page guild Cell statestore_error，不能从内存绕过持久化。无热重载承诺；下一次正常配置加载同步。

顶层 guild Cell 的唯一读源 = `discord_config`。源说明注明最初来自 DISCORD_GUILD_ID；每个 thread 不复制 guild。现有配置端点若仍服务其他调用者保持原合同，本页不绕到它取不同值。明确不 fallback 到 roundtable/huddle、测试常量、@me。

thread 解析先取得同项目 canonical issue UUID/identifier 别名，枚举该项目所有已配置 Lead.chatChannel 并调用 chat_threads 正向读取。若被选 gate 有权威 channel 绑定，优先使用并验证该绑定；没有 gate 则只在唯一无冲突的项目内结果上给链接。现行 resolveLeadForIssue 的标签路由可以优化查询顺序，但 matchMethod=general 返回的第一个 Lead 不能作为唯一查询目标。UUID/identifier 两个别名查到不同 thread、多个无法确定的部门绑定，标 conflict 并灰掉，不能挑第一行。只有查完本项目候选频道均无结果才能报 no_thread_binding；不因 lead_id 名字不同误选跨项目记录。discord_missing_at 标记禁用；archived_at 本身不等于不可读，保留链接交 QA 验证。无正确 channel/issue binding 则 no_thread_binding/issue_identity_unknown。

有效两个 ID 产生 `https://discord.com/channels/{guild_id}/{thread_id}`，父 channel_id 用来定位绑定而不是 URL 的 thread 段。render 只允许 https、host 精确 discord.com、无凭证/port/query/hash、路径精确等于生成值。任意一半缺失显示 disabled 文本/span aria-disabled=true（没有 href），写“去哪儿做：不知道（未配置 Discord 服务器编号/没有该单讨论串绑定/绑定冲突…）”。不可用时 action 四段仍保留，不提供冒充 thread 的 Linear 链接。

迁移只加表，不改 chat_threads，不回填假 guild，不改批准库。重启重建同一配置行；旧程序回退时忽略表，保留数据。配置移除后后续生成禁用链接；此前已发布静态页不会被即时撤销，按刷新/更新时间可见，不能声称全站立即灭链。

## 7. 无 Epic 的独立运行与故障边界

这是一处需要明确实现的可用性分离，不改 scope.v1 内容。给 ActiveScopeNotFoundError 加 typed reason：`no_active_roots`、`missing_daily_root`、`declaration_disappeared`；保持已有默认行为。materialize 独立启动 attention 读取，仅前两种“缺范围声明”允许 attention 页面继续；snapshot 返回 null 而不是伪造成功空范围，`epic_scope.value=null/missing=epic_scope_unavailable`。其它 API 失败、缺 cursor、截断、parent 消失仍走原生成失败/last-good 发布链，不静默吞掉。

当 snapshot=null：items=[] 是“未提供该区块”结构值，header.roots/header.items、founder_items、ready_items、dependency_review、stuck_items、gaps 这些依赖范围的 Cell 一律 value=null 且 missing.reason 精确为 `epic_scope_unavailable`，不能用 []/0 假装查过；scope_definition 仍保留原规则。provenance 使用实际项目绑定 query 身份，禁止 id 空字符串。schema 必须验证这个整组状态，禁止 missing scope 下出现 ready 候选。

render 顶层仍显示 attention；Epic 区块只给范围不可用提示并跳过原 Epic body，原有成功路径 renderItem/排序/折叠代码保持不变。Markdown 同样处理。`epic-residual-scan` 看到 snapshot=null 必须给 existing `structural: active_scope_not_found` unavailable，不得计算零 remaining/ready 或触发调度；`runEpicPageAttempt`/result 类型明确允许 snapshot=null，所有解引用都逐个审计。这不会把未排期单改成 Epic，也不更改 Linear。

`packages/flywheel-comm/src/commands/dependency.ts` 同步改造，不把 v2 的合法 scope missing 当 invalid_response。HTTP 200 成功 JSON 解析后，先验证 `document.schema_version===2`、`epic_scope.value===null`、`epic_scope.missing.reason==='epic_scope_unavailable'`，且 ready_items/dependency_review 两格均满足 `value===null && missing.reason==='epic_scope_unavailable'`；满足才 `fail('active_scope_not_found', 'dependency show: Epic 范围不可用，请补齐 Epic/日常筐前置')`，保持现有非零 exit 和机器 error code，不伪造 HTTP 422。畸形/矛盾 v2、无 scope 标记的 null 仍 invalid_response；legacy 422 原映射和正常 v1/v2 数组结果不变。页面 generate 仍返回 200 attention 文档，遵循 Lead 独立显示裁定。测试必须把真实新版 materializer 返回的 scope-missing 文档接入 CLI fetch seam，不能仅验证旧异常映射或固定 mock 数组。

刷新账本语义在此明确选择：`epic_page_refresh.outcome` 继续表示本次页面生成/发布是否成功，partial attention 页成功仍是现有 ok/ok_unpublished，不新增 outcome 词表。范围缺失不再是该成功发布的 failure token；它只在文档 epic_scope、residual unavailable 和 dependency show 的 active_scope_not_found 中保留。现有“按 refresh structural token 统计缺范围”的口径会减少，这是有意变化；不得把 ok 解读成 Epic 数据可用。C3/C5 断言成功发布 outcome + scope missing + residual unavailable + CLI可诊断错误同时成立，并确认 getEpicPageFreshness 的 last_generated/last_published 记录页面成功而非伪失败。

attention 三路局部失败允许已知行显示并提示不完整；全成功且 attention=[] 才输出确切空态。项目未绑定仍使用现有 route 错误，不用单号前缀猜项目。手动/自动/scan fallback 都走同一 materializer。

## 8. 四段呈现、通用文案与安全

新增首屏 section 标题“现在要你看”，默认展开，位于现有 overview/Epic 前。每行用 dl 或四个标记段落表示 ①②③④，窄屏仍按相同顺序，不用表格。每段缺任一成分都明确“ 不知道 ”，不得省去整段；①保留已知类型/单号并给缺标题提示。各行唯一 data-attention-key 用 §5 的公开 hash，四段提供 data-attention-part=what/action/wait/where 便于可见 DOM 断言。

F13：新字段与固定文案不携带具体人名，使用 founder/Lead/工程 Lead 等角色。不读取 assignee、sender displayName、消息正文作为页面事实；fixture/报告使用中性标题。外部 Linear 标题保留来源真实值并 HTML escape；escape 不能去人名，故“任意上游标题也保证零人名”尚不是本设计可证明的性质，已向 Lead 问清口径。未经裁定不引入不可靠姓名猜测或篡改 Linear 标题。

所有 issue/repo/tool-derived 文本在 markup 插入前转义；动态写入只用 textContent/value。不能把原始错误、邮箱、token、消息正文放入 audit details。thread URL 严格验证再转义 attribute。Markdown 用原逃逸函数，四段列表不添加表格。报告自己所有文字无具体人名。保留现有 relativeTime 对未来 observed_at 夹到0的行为；attention 的等待起点严格判无效。这是本单不改旧卡片所留下的已知展示差异，QA 分别断言，不顺手修改 Epic DOM。

## 9. 实现任务与验证顺序

每个 chunk 都采用失败测试 → 最小实现 → 重构 → 目标包验证 → 提交。以下是接口、输入/预期与文件范围，不是本设计节点要执行的产品实现。

C1 数据源与持久化：新增 `epic-page/attention-sources.ts` 与 `bridge/linear-attention-query.ts`；修改 `StateStore.ts`、`flywheel-comm/src/db.ts`、`bridge/plugin.ts`。新测试 `StateStore.attention.test.ts`、`db.attention.test.ts`、`bridge/__tests__/linear-attention-query.test.ts`。先断言没有 Epic/14 天前/终态 session 的有效问题仍被读取；已答/作废/旧 holder/自动评审/另一项目被排除；配置重启、删除、非法、并发幂等；真实 query 的二页 AND 过滤、cap+1、timeout。

C2 模型与计算：新增 `epic-page/attention.ts`、`epic-page/attention-budget.ts`，修改 `model.ts`、`generate.ts`、`freshness.ts`（如类型需要）、receipt 类型/遍历测试。新 `epic-page/__tests__/attention.test.ts` 与 fixtures/attention.ts，扩充 model/generate/receipt/freshness tests。同时测试 SQLite UTC时间归一、非法无T/Z的since被拒、身份补齐失败/恢复时合并与计数口径。固定三源每源一个不同单，输出 exactly 3；同 UUID 跨源合为 1；同 issue 多问题来源计数不丢；unknown kind 原文+未知 action；Lead收件提示而非伪founder收件；label since 缺失；所有 from 可解析；篡改派生字段必须失败。

C3 接线与范围隔离：修改 `materialize.ts`、`linear-epic-query.ts`、`epic-page-route.ts`、`plugin.ts`、`epic-residual-scan.ts` 和受 snapshot nullable 影响的 `epic-page-refresher.ts`。同步修改 `packages/flywheel-comm/src/commands/dependency.ts` 及 `commands/__tests__/dependency.test.ts`，修改 materialize、linear-epic-query、epic-page-route、epic-residual-scan、refresher 测试。真实 materializer 的 no_active_roots/missing_daily_root v2 文档→CLI 接线用例先 RED invalid_response，修复后 GREEN active_scope_not_found；正常 v1/v2、legacy422、畸形null也分别回归。三入口相同 fixture 一致；typed 两类缺范围允许 attention 但 residual unavailable；parent 消失/API 截断不被吞掉；成功旧 Epic scope/items/ready/stuck 逐字段完全相等。

C4 页面与安全：修改 `render-html.ts`、`render-markdown.ts`、`labels.ts`（仅标题/缺失文案，不复制 registry）。扩充 render/labels/escape tests 与新 `attention-render.test.ts`。DOM 检查首屏 exactly 3 个 attention 行，每行 exactly 4 段；每个字段单独缺失仍四段；空态与不完整分离；无 guild/no thread/conflict 无 href 且原因可读；恶意标题/原 kind/URL 不注入；旧 v1 是未知。旧 Epic 卡 DOM 输出不变；新增 section 无表格，报告全文无表格。

C5 发布/回归/QA 交接：扩充 publisher、CLI passthrough、receipt legacy migration 的测试，保留同 token 更新、失败不伪造发布成功、512 KiB 与 JSON 1,507,328 bytes 边界。对实际生成最大 fixture 量检查体积，超出不能截掉 attention 行继续宣称完整。

实现时目标命令（首次应验证相应新增行为失败，实现后 PASS）：

```sh
pnpm --filter flywheel-comm exec vitest run src/__tests__/db.attention.test.ts src/__tests__/epic-page-signals.test.ts src/commands/__tests__/dependency.test.ts src/commands/__tests__/epic-page.test.ts
pnpm --filter flywheel-teamlead exec vitest run src/epic-page/__tests__ src/__tests__/StateStore.attention.test.ts src/bridge/__tests__/linear-attention-query.test.ts src/bridge/__tests__/linear-epic-query.test.ts src/bridge/__tests__/epic-page-route.test.ts src/bridge/__tests__/epic-residual-scan.test.ts src/bridge/__tests__/epic-page-refresher.test.ts src/__tests__/epic-page-publisher.test.ts src/__tests__/statestore-epic-page.test.ts
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-comm typecheck
git diff --check
```

若本地实际测试文件拆成更细粒度，按新文件真名更新交接命令；不得把未执行的命令写 PASS。不跑会触及真实桌面的 monorepo 根测试。SQL/schema 修改同时运行现有 StateStore epic_page 迁移相关文件（以 rg 定位，不遗漏旧 full-document receipt 迁移）。

## 10. QA 验收合同与报告骨架

QA 先在隔离 fixture 造三单：A 当前 founder 门，B Epic 外 question_pending，C Epic 外非终态 founder-review。固定时钟 2026-09-09T12:00:00Z，A since=10:00Z、B=09:00Z、C unknown。只允许 A/B/C 三行，A 等 2 小时、B 等 3 小时、C 明确不知道。第四个 declared_blocked-only 且无门/无未答问题/无 founder-review 标签的第四个单只留原状态区；closed gate/answered question/terminal labeled issue 都不能增加行。

另一个显式 fixture：declared_blocked + 非终态 founder-review 标签仍进入，唯一原因是独立的点名来源；去掉标签且无其它两路时退出。不能因“卡住”本身添加一行，也不能让这个状态抹掉真实 founder 请求。

其它必须记录的负向验收：重叠三源合并、两个独立问题保留、超过14天、终态源 session、orphan 无单号、另一项目、未知 type、缺 guild/缺 thread/冲突/错误 URL、时间无效、分页遗漏、任一路失败不能假空、无 Epic 时有 attention 而 residual unavailable。固定四段对每种 missing 单独验证。

真实浏览器验收是独立硬要求：

1. 使用 QA 实际生成并发布的页面，记录代码 SHA、文档 generation/version、issue ID、期望 guild/channel/thread ID、thread_url 原值；该行必须由真实来源生成，不能手工替换 href。
2. Claude-in-Chrome 登录会话打开该页面，实际点击其跳转；记录 click 前后时间、落地 URL，并截图包含地址栏或另外可核 URL 证据，以及可见正确 thread 标题/单号。
3. 截图与期望 issue/thread 绑定一起进入报告。登录页/Discord 首页/父频道/错误 thread/权限拒绝都算未通过；curl 200、字符串正则、API thread 存在、普通 HTML 截图不能代替。
4. 缺 guild 场景在隔离环境重生成并截图，确认链接灰掉、无 href、原因可见。不要更改生产 guild 来造负例。
5. 无 Claude-in-Chrome 或浏览器受限则报告“真实 thread 点击未验证”，不能 QA PASS 或静默换浏览器冒充。设计阶段没有这条截图；后续 QA 必须补齐才满足实现验收。

报告使用无表格的 ship report 顺序：一句话结论 → 改了什么/用户可见结果 → 怎么验证（命令、三源对账、真实点击和截图）→ 已知边界与未通过项 → 风险/回退 → 证据链接与版本。每项写实测/未测，不把方案稿当 ship 成果；不得包含人名、凭据或原问题全文。

## 11. 风险、回退与阶段交接

label 的精确等待起点缺失是明确代价；项目扫描可能滞后一周期，保持现有 freshness。配置存在且 URL 格式合法不证明访问权限，所以 QA 实点不可省。跨数据库读取不是全局事务快照：来源各自带 observed_at，本页展示观察事实，不保证随时可批准；行动仍回原 thread 权威。

回退由常规代码回退和独立 updater 的窗口部署执行。保留 discord_config 表、receipt 历史与 fixed token，不执行破坏性 down migration；旧 renderer 下 attention 功能会消失，报告这一功能回退。没有自动合并/新批准权/生产重启权限。

设计结束条件：三文档+图源+带逐节评论的 HTML 已提交推送；两张图尚未渲染、无 SVG/视觉证据是显式未完成的视觉项，本任务允许用标准重试失败后的 DIAGRAM PENDING LOCAL RENDER 降级交付，不能在发布后改称图已完成；正式 request-review 的 reviewVerdict APPROVED；托管 publish-only 成功并向实际 Lead 报 DESIGN-HTML ready；progress 记录；完成 phase_design_complete 后 park。不调用后继派发，不把 design phase 当整个 issue 已实现，不向 founder 请求 ship/brainstorm 批准。

## Lead 语义裁定（本轮已收到）

问题 `11a90990-9057-4c15-837b-6ca536579e1e` 与 `57f47ca0-07de-446c-ba0b-3c9002ed840e` 已答复：同意项目级全未答 question_pending、排除 declared_blocked、逐单合并保留所有来源与既定主动作顺序；明确 no_active_roots/missing_daily_root 时独立显示 attention，Epic 提示不可用且 residual unavailable；F13 为无硬编码人名、角色文案与外部标题保留并转义；真实 Discord 点击+截图是 QA 硬门，设计保持未验证。前文提问已经解决，以上为当前实施口径。
