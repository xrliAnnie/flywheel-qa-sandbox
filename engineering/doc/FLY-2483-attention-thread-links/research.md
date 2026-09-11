# FLY-2483 现在要你看 — 调研
Issue: FLY-2483 (https://linear.app/geoforge3d/issue/FLY-2483/进度页e2-现在要你看attention-三路合并-固定四段格式-跳-discord-threaddiscordguild-id)
日期: 2026-09-09
基于: exploration.md

## 结论

新增项目范围 attention 读取链路，不能把 Epic 内的旧 stuck_items 当全量事实。三路来源在生成阶段合并，页面只显示 Cell；Cell 是携带值、来源、观察时间或缺失原因的记录。guild 配置单独持久化，讨论串链接由两个有出处的输入生成。设计不包含执行授权，也不把浏览器打开成功提前写成事实。

## 当前证据与消费者

以下行号来自本分支基线 `42869f935`，本轮读取和两个独立只读研究均以工作区为准。

- `epic-page/materialize.ts:52-72` 先取 Epic snapshot，再按 snapshot.items 读取事实/signals。`generate.ts:135` 把 itemFacts 与 items 数量严格绑定。新增 attention 输入须独立于这个数组。
- `epic-page/signals.ts:11,162-167` 有 14 天窗口；`flywheel-comm/src/db.ts:4042-4055` 按 execution+kind 只选一个问题，`epic-page-signals.ts:18-27` 没有完整 question ID。无法用这些结果证明所有未答问题均可见。
- `StateStore.ts:11866-11877,11945-11951` 的范围事实依赖最新 session；历史 session 上尚未关闭的问题会被遗漏。attention 不用最新 session 限制，也不用 execution_id8 去重。
- `CommDB.getOpenGatesByCheckpoint` (`db.ts:3763-3781`) 定义 canonical open：question、非 terminal_disposed、无 superseded_at、无 response。明确忽略 expires_at，清理保留期不是授权关门。
- `db.ts:3997-4020` 把标准停止报告分开，protected 且有 checkpoint 的问题归 waiting_founder，其余归 question_pending。question_pending 不等于已升级给 founder；不能读自由文本猜对象。
- `StateStore.listOpenGateAuthorities:11503-11519` 包含批准过的历史。当前 holder 需 active run、current node/attempt、awaiting_review、node review 未结束且卡未作废。结构依据 `StateStore.ts:38897-38911`，固定工作流权限依据 `approval-signal/gate-authority-view.ts:43-85`。
- `workflow-run-snapshot.ts:202-241` 的权限模式 land/runner_ship/engine_terminal 决定 ship/普通门；不用显示标签推断权限。legacy founder 展示 allowlist 见 `gate-poller.ts:1915-1921`，自动 design/code review 不纳入。
- `StateStore.ts:33526-33533` 可以按 question 取得 founder-review 卡绑定；`33458-33469` 的 workflow execution 绑定遇歧义返回空。未知归属必须保留缺失项而非从消息正文抽单号。
- `linear-epic-query.ts:269-273` 在零 root 或缺日常筐时失败；相同异常还用于 parent 消失。不能宽泛 catch 后造成功空范围。attention 与 Epic 的可用性需明确分离。
- `linear-query.ts:60-79,87-105,145-152` 的通用查询没有团队边界、标签 OR、仅一页、读取 assignee.name。新查询使用 `linear-scope.ts:107-123` 同一项目绑定 AND 语义，单独分页，复用 `rules.ts:3,57-59` 的 FOUNDER_REVIEW_LABEL。
- `config.ts:226` 读取 DISCORD_GUILD_ID；`plugin.ts:4432-4442` 配置端点直接读内存。没有本功能可复用的持久化全局 guild 配置。voice session/huddle 的 guild 不是本页配置来源。
- `StateStore.ts:5699-5718` 的 chat_threads 以 (issue_id, channel_id) 唯一；`16036-16062` 的规范正向读取排除 discord_missing_at，保留 archived_at。不读 phase_chat_threads，不用 @me。
- `tools.ts:1128-1130` 说明历史 issue key 有 UUID/identifier；只使用项目内验证过的别名。Lead 由项目/标签解析，chatChannel 来自配置，见 `ProjectConfig.ts:1226-1248`。冲突不能 LIMIT 1。
- `model.ts:749-780` 根键严格校验，新增字段即使仍叫 v1 也会被旧读者拒绝。`319-330,683-711` 的递归 timestamp 检查禁止 Cell.value 中再嵌套 Cell。选择 plain attention[] + 每个叶子 Cell。
- `model.ts:373-424` 的 derived.from 指针必须指向真实 Cell；不能引用不存在的来源或只给文字说明。thread_url 同时指向 thread Cell 与 guild Cell。
- `generate.ts:313-365` 手动枚举 freshness 来源；新增源必须进入 freshness。`receipt.ts:202-254` 能递归找到源 Cell，但不保存 value。
- `StateStore.ts:6947-6955` 当前 epic_page 存 source receipt，不存完整文档。保留 receipt schema v1，不能把缓存文档当 guild 持久化。`6990-7001` 的旧 document→receipt 迁移仍要回归。
- materialize 有三个接线口：`bridge/plugin.ts:6190` 自动刷新、`bridge/epic-page-route.ts:234` 手动、`bridge/epic-residual-scan.ts:104` fallback。三者都要接，缺任一会出现手动可用、自动漏数据。
- `epic-page/residual.ts:289-305` 与调度消费 scoped stuck_items，保持原义。CLI `commands/epic-page.ts:188-190` 透传 JSON；`commands/dependency.ts:183-205` 只读旧 ready/dependency 字段。
- `render-html.ts:510-529` 是新增首屏插入点；现有 renderItem 不变。Markdown 同源增加四段列表。本单报告无表格，不改旧 Epic Markdown 的表格布局。
- `epic-page-publisher.ts:8,43-124` 限 HTML 512 KiB、复用项目 token，并以分阶段提交发布。新模型不改变 URL 与发布事务。

## 外部边界核对

本轮查阅官方文档，未把文档当作真实点击证据。

- [Linear filtering](https://linear.app/developers/filtering)：多个 filter 条件按 AND 合成；同时要求 scope 标签与 founder-review 必须以两个 AND 子句表达，不能改成 labels.in 的 OR。
- [Linear pagination](https://linear.app/developers/pagination)：按 hasNextPage/endCursor 持续翻页。分页失败或缺游标不能解释为已经读完。
- [Discord threads](https://docs.discord.com/developers/topics/threads) 与 [channel resource](https://docs.discord.com/developers/resources/channel)：thread 有自己的 channel ID，parent_id 是父频道。设计采用 PRD 的 https://discord.com/channels/{guild}/{thread}，实际权限和落点仍要浏览器实测。

## 时间与缺失

mailbox.created_at 或 holder.created_at 是具体等待的开始，不用 updated_at。label-only 项没有标签添加时间；issue.createdAt/updatedAt 均不证明等待开始，必须显示不知道。合并后主动作的等待时间来自该动作，不能借另一个更早来源的时间夸大 ship 等待。

缺失的 guild、thread、身份、title、since 各自有固定原因；不打印原错误/消息正文。三路有任何一路失败或截断，不能写“现在没有等你的事”。可显示已知行并说明清单不完整。

## 设计门与能力边界

已按动态指令向 Lead 发非阻塞语义问题 `11a90990-9057-4c15-837b-6ca536579e1e`，无 Epic 可用性问题 `57f47ca0-07de-446c-ba0b-3c9002ed840e`。普通技能里的人工 research/brainstorm 确认被本轮明确授权的设计流程取代，仍执行正式 request-review 硬门。

本节点没有 Claude-in-Chrome 可调用工具，不把本页检查等价于 Discord QA。真正点击由 QA 使用有权限的登录会话完成；不能完成就不得宣称该验收通过。没有打开实时数据库、没有更改线上配置或真实等待门。

## Lead 语义裁定（本轮已收到）

问题 `11a90990-9057-4c15-837b-6ca536579e1e` 与 `57f47ca0-07de-446c-ba0b-3c9002ed840e` 已答复：同意项目级全未答 question_pending、排除 declared_blocked、逐单合并保留所有来源与既定主动作顺序；明确 no_active_roots/missing_daily_root 时独立显示 attention，Epic 提示不可用且 residual unavailable；F13 为无硬编码人名、角色文案与外部标题保留并转义；真实 Discord 点击+截图是 QA 硬门，设计保持未验证。前文提问已经解决，以上为当前实施口径。

## R1 消费者复核增补

`packages/flywheel-comm/src/commands/dependency.ts:198-204` 在 ready/dependency_review 不是数组时返回 invalid_response，因此先前“只读旧字段”的描述不证明兼容scope missing。计划现已把该CLI与commands/__tests__/dependency.test.ts加入修改与接线验证范围。刷新outcome仍表示页面发布状态；缺Epic信号显式保留在document/residual/CLI，不冒充发布失败。Linear官方comparators本轮确认使用nin；holder/node/mailbox时间在SQL转换UTC后再入since Cell。
