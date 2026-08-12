# FLY-1709 archive-once 死角与 no-op 假成功 — 调研

Issue: FLY-1709 (https://linear.app/geoforge3d/issue/FLY-1709/archive-once-死角agent-在归档-thread-发言后永远关不上-no-op-返回伪装成-archivedtrue)
日期: 2026-08-12
基于: exploration.md

以下全部为对当前 `main`(worktree 分支 `flywheel-FLY-1709`,基于 `4f246f52`)的实读审计。行号以该版本为准。

## 1. 归档链路的完整地图

### 1.1 唯一 sink:`archiveThreadAndRecord`

`packages/teamlead/src/bridge/done-thread-archiver.ts:97-233`。合同(文件头注释 + FLY-1165):
- 所有归档路径(close cascade、endpoint、6h reconcile sweep、terminal 定向归档、post-ship)都路过它;
- per-thread 串行锁 `threadArchiveLocks`(:81,rejection-proof 链尾);
- **archive-once 守卫在临界区内 fresh read**(:107):`store.isChatThreadArchived(threadId)` 为真 → 直接返回 `{archived:false, attempts:0, reason:"already_archived"}`(:108-112),并写 `chat_thread_archived` 审计事件(payload reason already_archived);
- 真归档走 `archiveChatThread`(chat-thread-utils),成功后 `store.markChatThreadArchived`(:145)。

**缺陷①的机械根因就在 :107**:守卫只看本地 `archived_at`,不看 Discord 真实状态,更不看是谁把 thread 弹开的。

### 1.2 endpoint:`POST /api/chat-threads/archive`

`packages/teamlead/src/bridge/tools.ts:983-1165`。关键分支:
- **:1119-1129 前置短路(缺陷②本体)**:`thread.archived_at` 已置 → 直接 `res.json({threadId, archived:true, reason:"already_archived", attempts:0})`——**没碰 Discord、没做任何事,却回 `archived:true`**。Honey Lemon 复现的第 3/4 步响应即出自这里。
- :1149-1164 正常路径调 sink 后 `res.json({threadId, ...result})`——sink 的返回是如实透传的;也就是说若删掉前置短路,sink 守卫的 `archived:false` 本会到达 HTTP 层(仍是不可行动的 already_archived,但至少不是 true)。
- :988-994 无 `TEAMLEAD_API_TOKEN` 时 503 fail-closed;:1028-1035 `validateChatThreadParams` 做 caller scope 校验;:1040-1110 canonical key 解析(FLY-270 identifier/UUID 双形态)。

### 1.3 调用方(sink 之上)

| 调用方 | 文件 | 触发 | 状态门 |
|--------|------|------|--------|
| close cascade | done-thread-archiver.ts:361-375 `maybeArchiveThreadOnClose` | closeRunner 收口 | `["completed"]` + 无其他 active runner |
| crash reaper | 同文件 `archiveIssueThreadIfNoOtherActive` | FLY-720 收尸后 | `["terminated"]` |
| 6h reconcile sweep | done-thread-reconcile.ts:369 | boot + 周期 | 只枚举 `getUnarchivedIssueChatThreads()`(**`archived_at IS NULL`**,StateStore.ts:8656)+ 双门(fresh Linear Done/Canceled + 无活进程)+ 三重 veto |
| terminal 定向归档 | terminal-thread-archive.ts:201 | session 终态事件 | 全 alias ∈ {completed, terminated} 等更严格前置;同样只走未归档枚举 |
| 手动 endpoint | tools.ts:983 | Lead 调用 | 无 session 状态门(escape hatch) |

**要点**:两条自动收敛路径(sweep + terminal 定向)都只枚举 `archived_at IS NULL` 的行——`archived_at` 已置而 Discord 侧被弹开的 thread 对它们**不可见**。这决定了修①后的自动收敛边界(见 exploration §5)。

### 1.4 `archived_at` 的生命周期(关键审计发现)

- 置:仅 `markChatThreadArchived`(StateStore.ts:8629-8637,同步写 `chat_threads` + legacy `phase_chat_threads`)。
- 读:`isChatThreadArchived`(:8734-8744,空串视为未归档)、`getChatThreadByIssue`(:8536-8550,返回行含 `archived_at`)、两个未归档枚举(:8656, :8987)。
- **清:全仓不存在**。`upsertChatThread`(:6601-6624)的 `ON CONFLICT(thread_id) DO UPDATE` 只更新 `channel_id/issue_id/lead_id`,不碰 `archived_at`。→ rework 复用 thread 后账本永远是「已归档」,exploration §4.3 的配套修由此而来。

## 2. Discord API 行为事实

- **对归档(未锁定)thread POST 消息 = 自动 unarchive**。这是 Discord 文档化行为(Threads topic;bot 需 SEND_MESSAGES_IN_THREADS),也是 issue 现象第 2 步与 FLY-1680 弹开的机制。代码内已有同款认知注释:chat-thread-utils.ts:113(「If a user later sends a message in the archived thread, Discord will auto-unarchive it — by design」)。
- **对归档 thread 改名(PATCH name)= 400 code 50083**,不会 unarchive。`renameChannel`(chat-thread-utils.ts:754-762)识别之;标题写手把它映射为 `deferred`(ChatThreadCreator.ts:730-732)。→ face A(标题)**不是**重开源;重开源是消息 POST。
- 归档状态可从 `GET /channels/{id}` 的 `thread_metadata.archived` 读出;现成 helper `getChannelName`(chat-thread-utils.ts:656-709)已返回 `archived?: boolean`。
- 取某时刻之后的消息:`GET /channels/{id}/messages?after=<snowflake>&limit=100`(需 READ_MESSAGE_HISTORY)。snowflake 可由毫秒时间戳合成:`(ms - 1420070400000) << 22`。消息作者的 bot 身份看 `author.bot === true`(我方全部 Lead/announcer 写手都是 bot 身份;founder 是人类账号)。
- `archived_at` 由 SQLite `datetime('now')` 产生(**UTC**、`YYYY-MM-DD HH:MM:SS`),解析时须按 UTC 拼 `Z`。时钟偏差方向分析:`archived_at` 写在 Discord PATCH 确认**之后**,重开消息必然更晚;向过去留 2s 容差只会把归档前的旧消息误纳入「之后」,而那会把人类消息多算进来 → 误向「不抢」= 安全方向。

## 3. 自动状态贴(issue-display)链路

### 3.1 刷新器与三个 face

`issue-display-refresher.ts` `IssueDisplayRefresher.refreshOnce`(:627-941):
- :653 `store.getChatThreadByIssue` 取 thread 行(**行里已含 `archived_at`,当前代码完全没读它**);
- face A 标题(:722-757):`stampStatusBadgeResult` / `stampStageEmojiResult` → GET+PATCH name → 归档时 50083 → `deferred`;
- face B 置顶 pipeline header(:759-890):`ensureRunnerPipelineHeaderPinResult` → pin 状态机 `ensureRunnerAttachPinNow`(ChatThreadCreator.ts:1048-1130):无记录 → **POST+pin**(`postAndPinAttach`,:995-1038);edit 404 → **repost**。**POST 即重开归档 thread**;
- face C(:900-918):legacy 散贴清理,只 DELETE;
- fingerprint(:920-940):只有所有启用 face 为 changed/noop 才落——**face A 的 `deferred`(50083)会让归档 thread 永远落不下 fingerprint,成为 sweep 每 tick 的永动重试候选**(次生浪费,闸门顺带治掉);
- 触发面:applyTransition hook / DirectEventSink / park-wake / stage_changed / finalize / GatePoller sweep(文件头 :4-10)。terminate 属于 lifecycle 转移 → 会触发刷新,与 FLY-1680 标本一致。

### 3.2 「🔴受阻 [G]」的字面来源

- 🔴受阻:`issue-display.ts:231`(PHASE_DISPLAY_GLYPH_PARTS.blocked)与标题 badge `BLOCKED_EMOJI+BLOCKED_WORD`(refresher :728-733,stage-utils.ts:139)。
- `[G]`:模型 marker(stage-utils.ts:284 注释:`🔨实现 [G] [FLY-1255] Title`,G=GPT),经 `phaseMessageTag(role, runner_model)` 进入 face B 行 label(refresher :793-798)。
- 因此「🔴受阻 [G]」= face B 置顶 header 的行内容(或弹开后 face A 补上的标题)。与标本吻合。

### 3.3 legacy 逃生口

`FLYWHEEL_ISSUE_DISPLAY_REFRESH=0` 时走 `stampStageEmojiForSession`(:166-221)/`pinRunnerAttachForSession`(:230-381)——同样取 thread 行、同样不读 `archived_at`、同样能经 pin 状态机 POST。闸门须双侧覆盖。

### 3.4 终态映射(缺陷④)

`issue-display.ts`:
- `PHASE_BLOCKED_STATUSES = {failed, terminated, blocked, rejected}`(:72-77)→ phase state "blocked";
- `MAIN_BLOCKED_STATUSES = {failed, terminated, blocked}`(:125-129)→ main badge `{kind:"blocked"}`(:157);
- 每行映射由 `issue-display.test.ts` 钉死(:80-91 注释),改映射必须同步改表格注释与测试。

### 3.5 收官证据的现成来源

- `hasFinalizationCompletedForIssue`(StateStore.ts:36922-36936):`land_operation.finalization_completed_at IS NOT NULL` 或 `post_ship_finalization_completed` 事件计数 > 0。generalized workflow 走 FLY-1655 terminal land 的 issue 会留下 land_operation 行。
- session 行:`sessions.status ∈ {completed, merged}` 存在性查询——现无现成 helper,需加一个只读小方法(不加表)。
- `thread.archived_at`:归档过 = 收官过(refresher 已持有该行,零额外查询)。

## 4. 其他往 thread 写消息的路径(界定「自动状态贴」范围)

grep 全 bridge 消息 POST 面,与 issue thread 相关的:
- **自动状态类(本次要闸)**:issue-display-refresher 三 face(经 ChatThreadCreator pin 状态机)+ legacy stamp/pin。
- **Lead 主动通信类(不闸,弹开属正常语义)**:`/send` 路由、gate question 绑定(approval-signal/gate-message-binding.ts)、founder-reply-deliverer、founder-thread-notifier、runner-ready-to-close-notifier、disposition-receipt 等——这些是人指挥/面向 founder 的对话消息,重开 thread 是 Discord「重新使用」的本意;它们弹开后的收敛靠修① 后真正可用的归档调用。
- 频道级(AlertChannelHub、standup、roundtable)与 issue thread 无关。

## 5. 现有测试面

- `packages/teamlead/src/bridge/__tests__/done-thread-archiver.test.ts`:sink 守卫、锁串行、审计事件(FLY-1165 行为被钉死——本次要**改**这些断言,属 LEGITIMATE RETARGET,plan 里点名)。
- `__tests__/issue-display.test.ts`:映射表逐行钉死。
- `__tests__/issue-display-refresher*.test.ts`:refreshOnce 各 face 结果与 fingerprint 语义。
- tools/endpoint 测试:archive 路由分支(含 already_archived 短路——同样要改断言)。
- chat-thread-utils 测试:archiveChatThread 重试/404/验证。

## 6. 风险与开放点

1. **READ_MESSAGE_HISTORY 权限**:reopener 分类需要读消息历史。我方 bot 创建并管理这些 thread,常规配置下具备;若缺权限 → 分类失败 → fail 向「不抢」,不会误关,但也修不了该 thread(错误会留在返回值与审计里,响亮)。
2. **消息分页上限**:`after` 起最多翻 2 页(200 条)。超限即「无法确证全 bot」→ fail 向「不抢」。归档后堆 200+ 条消息的 thread 必然有人类参与或异常热度,不抢是对的。
3. **与 issue 原文的 reopener 规则偏差**(latest-speaker → any-human):见 exploration §4.1,交 design review 裁。
4. **`upsertChatThread` 清 `archived_at` 的波及面**:该方法被 /api/runs/start(原子注册)、/api/chat-threads/register、/create 三处调用——全部是「thread 进入活跃使用」语境,清账本语义一致。歧义点:同一 upsert 也可能在无新 run 的对账场景被重放?审计未发现此类调用方;plan 中以 reverse-compat 测试钉住「非归档行为零变化」。
5. **audit 事件量**:修①后归档尝试在 archived_at 已置时会多 1-2 个 Discord GET;触发频率 = 归档触发频率(事件驱动,低),无周期增量。
