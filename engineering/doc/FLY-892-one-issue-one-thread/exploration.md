# FLY-892 一 issue = 一 thread — 探索

Issue: FLY-892 (https://linear.app/geoforge3d/issue/FLY-892/pipelineux-一-issue-一-thread-收敛三段式-designimplementqa-三-thread-lead-chat)
日期: 2026-07-05
基于: 无

## 1. 问题

Annie(2026-07-05,P1):「同一个 issue 我要在三个不同的地方 track,认知负荷过高。就算它有三个 session(为了每段跑不同模型),我希望它们在**一个 thread** 里 track 同一个 issue。马上调成只用一个 thread。」

目标一句话:**一 issue = 一 thread**。某 issue 的所有 Discord 消息——Lead 更新 + design/implement/QA 三段 session 产出——全部落在同一条 `(issue, channel)` thread。后端三段 session 保留(每段不同模型),纯前端 thread 收敛。

## 2. 现状审计(代码事实)

### 2.1 根因 1:FLY-793 的 per-role 侧表

FLY-793 Step 11(Hybrid,Annie 2026-07-03 拍)刻意做成双表:

- `chat_threads`:`UNIQUE(issue_id, channel_id)`(`StateStore.ts:1278-1280`)— main thread,1 issue 1 行。
- `phase_chat_threads`:`UNIQUE(issue_id, channel_id, session_role)`(`StateStore.ts:1291-1308`)— design/implement/qa 各一条。

thread 解析全部集中在 StateStore 的 role-aware API(role 缺省 `'main'`):

| API | 位置 | role 行为 |
|---|---|---|
| `upsertChatThread(threadId, channel, issue, lead, role)` | `StateStore.ts:2975` | role 路由表 + delete-stale 按 (issue,channel,role) |
| `getChatThreadByIssue(issue, channel, role)` | `StateStore.ts:3815` | role 路由表 |
| `getChatThreadByThreadId(threadId)` | `StateStore.ts:3861` | 先查 main 再查 phase,回显 `session_role` |
| `set/get/clearChatThreadAttachPin(..., role)` | `StateStore.ts:3941/3972/4005` | role 路由表 |
| `markChatThreadMissing/Archived(threadId)` | `StateStore.ts:3902/3922` | 按 thread_id 双表 UPDATE(天然安全) |

创建入口唯一:`ChatThreadCreator.ensureChatThread(ctx)`(`ChatThreadCreator.ts:253`),`ctx.chatThreadRole` 进 in-flight dedup key(`:256`)、进查找/upsert(`:275/:401`)、进标题徽章 `phaseThreadBadge`(🎨设计/🔨实现/🧪QA,`:141-152/:172`)。

role 的取值在 Blueprint 一处派生(`Blueprint.ts:615-616`):`chatThreadRole = shareParentBranch && sessionRole ? sessionRole : 'main'`,随 `session_started` 持久化为 `sessions.chat_thread_role`(`StateStore.ts:899/1170`)。

### 2.2 根因 2:Lead chat-threads/send 分叉

Lead 的 `/api/chat-threads/send`(`tools.ts:1048`)查 `getChatThreadByIssue(canonicalKey, channelId)` **不带 role** → 永远解析/创建 main 表行。三段 phase session 的消息却进 phase 侧表 thread → **同一 issue,Lead 一条 thread + 三段各一条 = 最多 4 条**。今天 Tadashi 给 880/882/883/886/887 各多开了一条(main)thread,Annie 明确不满。

### 2.3 附带发现:现状已自相矛盾(强化收敛的理由)

- **stage emoji / attach-pin 打错地方**:`event-route.ts:407/472`(`stampStageEmojiForSession` / `pinRunnerAttachForSession`)查 thread **不带 role** → three-stage 下,phase session 的 stage 前缀/rescue pin 实际打在 Lead 误建的 main thread 上(若无 main 行则静默 no-op),phase thread 标题永远不更新。
- **phase thread 永不归档**:`done-thread-archiver.ts:211`、`post-ship-finalization.ts:273` 只解析 main 行;FLY-793 plan ⑤「Done 时归档全部 role 行」未真正落地 → 三段 phase thread 在 Done 后一直躺在 sidebar(Annie 的 clutter 有一部分来自这里)。
- **role-passing 调用点不完整**:带 `session.chat_thread_role` 的只有 HeartbeatService(:1264)、bootstrap-generator(:305/330)、gate-poller(:1404/1791/1964/2108)等;event-route/tools/done-archiver/founder-ux/founder-consent 全走 main。即「三 thread」从未被全链路一致实现过。

### 2.4 `chat_thread_role` 的第二身份:three-stage 持久标记(不能动)

FLY-793 ③ 让 `sessions.chat_thread_role` 兼任「这是 three-stage phase session」的持久标记(`session_role` 单独不够——auto-QA 在独立 issue 上也是 `sessionRole='qa'`)。依赖它的逻辑:

- `countSessionsByIssueAndChatThreadRole`(FLY-859 fix-loop 轮次上限,`StateStore.ts:2369`)
- `getThreeStageQaSessionsWithVerdictEvents` / `getStrandedThreeStageQaPassSessions`(FLY-859 reconcile,`:2388/:2413`)
- `event-route.ts:671`(three-stage QA verdict 识别)、`phase-orchestrator.ts:363`(非 three-stage 早退)

**结论:收敛不能改 Blueprint 的 chatThreadRole 派生,也不能改 sessions.chat_thread_role 的写入——只能改「role → thread」的解析这一层。**这恰好就是 issue 要求的「thread 解析层统一到单一 (issue, channel) → thread 的 registry」。

## 3. 方案

### 方案 A(推荐):在 thread 解析层收敛,role 降级为消息标记

- **StateStore 四组 thread-resolution API 去掉 role 路由**:`upsertChatThread` / `getChatThreadByIssue` / attach-pin 三件套一律走 `chat_threads` 主表(role 参数删除,TypeScript 编译错误驱动改掉全部调用点,不留「看着还会路由」的死语义)。`chat_threads` 即「单一 (issue,channel) registry」。
- **`phase_chat_threads` 降级为只读遗留**:不再有任何写入;`getChatThreadByThreadId` 保留双表读(历史 phase thread 的 reverse lookup / reply-guard 分类不受影响);`markChatThreadMissing/Archived` 保留双表 UPDATE(历史行可归档)。表和历史行不删。
- **ChatThreadCreator 去 role**:in-flight dedup key 回到 `(issue, channel)`;`phaseThreadBadge` 不再进 thread 标题(标题回到 `[FLY-XX] <title>` + FLY-560 stage/model 前缀)。
- **`sessions.chat_thread_role` 与 Blueprint 派生逐字不动**(three-stage 标记语义完整保留,FLY-859/verdict sweeps/phase-orchestrator 零影响)。
- **session_role → 消息内标记**:phase session 产出的 founder-facing 消息加角色前缀(见 §4)。
- **Lead 分叉自动愈合**:`chat-threads/send` 本来就走 main 表,收敛后 Lead 与三段 session 解析到同一行,无需改 send 语义。

优点:改动收敛在一层(StateStore + ChatThreadCreator);所有 caller(带不带 role)自动汇合;非 three-stage 项目行为逐字不变(它们从未传过非-main role);把 §2.3 的三个自相矛盾一并治好。

### 方案 B(否决):Blueprint 把 chatThreadRole 派生改成恒 'main'

一行改动,但 `chat_thread_role` 的 three-stage 标记身份同时被抹掉 → FLY-859 轮次上限、QA verdict reconcile、phase-orchestrator 门控全部失效。需要再造一个新标记列 + 迁移,净复杂度更高。否。

### 方案 C(否决):把 phase_chat_threads 行迁移合并进 chat_threads

`UNIQUE(issue_id, channel_id)` 下同 issue 多行必须挑一弃二,历史 thread 映射丢失,reverse lookup / 归档破坏。一次性迁移风险 > 运行时收敛。否。

## 4. UX 设计(founder-facing,Annie 的原始指令即规格)

- **一条 thread**:标题 `[FLY-XX] <title>`,FLY-560 stage emoji 前缀照常(单 thread 下改名频率↑,但 FLY-630 的 coalesce-to-latest title writer 已结构性处理 2/10min 限速;三段互斥运行——runs-route 的 active-phase 检查——无并发抢改名)。
- **消息级角色标记**:phase session(`chat_thread_role !== 'main'`)产出的 founder-facing thread 消息,前缀 `🎨设计` / `🔨实现` / `🧪QA`(与 FLY-793 ⑦ Annie 定稿的徽章字面一致,只是从「thread 标题」搬到「消息前缀」)。注入点 = 以 session 为输入、向 issue thread 发文的共享 helper(founder-thread-notifier / gate-poller founder 通知 / event-route design_review·pr_created 提示等),一个 `phaseMessagePrefix(session)` helper 统一供给。Lead 的 `/send` 消息不加前缀(Lead 说话就是 Lead 说话)。
- **thread 标题不再带 phase 徽章**(单 thread 没有「属于哪段」;当前阶段由 FLY-560 stage emoji 表达)。

## 5. 迁移 / 兼容(FLY-887 等在飞 issue)

- **运行时归并(主机制)**:部署后任何解析都走 main 行。880/882/883/886/887 均已有 main 行(Tadashi 今天误建的 thread 恰好成为正主)→ 后续消息直接归并。若某 legacy issue 无 main 行,下一条消息经 `ensureChatThread` 建唯一一条 main thread(每 issue 至多一次,可接受)。
- **一次性 boot sweep(清 sidebar)**:Bridge 启动时,对所有未归档 `phase_chat_threads` 行:向该 phase thread 发一条指针消息「🔀 本 issue 后续消息已归并到主 thread <link>」(main 行存在时)→ Discord archive → `archived_at` 落库。幂等 by construction(处理过的行已 archived,不重复);无新周期 timer。
- **历史行为对照**:非 three-stage 项目(生产上除 flywheel 外全部)从未写过 phase 侧表 → 逐字无变化。**不加 config 开关**:收敛本身就是 Annie 的指令,OFF 路径=保留她明确否决的行为;非 three-stage 路径本来就无行为差异,开关只增加测试矩阵(feedback_match_process_weight_to_risk)。

## 6. Cross-reference 影响分析(别改崩清单)

| 在飞/已落地件 | 影响 | 处理 |
|---|---|---|
| FLY-793(三段式) | session 层、`chat_thread_role` 标记、phase-orchestrator 全不动 | 只收敛 thread 解析层 |
| FLY-560(stage 标题前缀) | 单 thread 下继续工作且更一致(§2.3 的打错地方被治好) | 复用 coalescing writer |
| FLY-314(roundtable per-topic thread) | `roundtable_topic_threads` 独立表,不碰 | 无 |
| FLY-369(close→archive 级联) | `markChatThreadArchived` 双表 UPDATE 保留;单 thread 后语义更简单 | boot sweep 清历史 phase thread |
| FLY-887(正在 implement) | 已有 main 行 → 部署即归并;in-flight session 的 `chat_thread_role='implement'` 只再作为消息前缀用 | 运行时归并覆盖 |
| FLY-859(fix-loop 轮次/QA reconcile) | 依赖 `chat_thread_role` 标记 → 不动 | 方案 A 明确保留 |
| FLY-807(auto-QA thread 路由) | auto-QA 本来就是 main → 无变化 | 无 |

## 7. 红线确认

后端**三段 session 保留**(每段独立模型 = Annie 要的)。本设计不触碰 session 派生、phase orchestration、模型选择——只动 Discord thread 的解析与消息标记。

## 8. 开放问题(带进 brainstorm gate)

1. 消息前缀样式(`🎨设计 ` 字面)是否需 Annie 再过目,还是她 2026-07-05 的指令(含「保留为 thread 内消息标记」)已覆盖?→ 建议:字面沿用 FLY-793 ⑦ 她定稿的徽章,不再打扰。
2. boot sweep 的指针消息要不要发(还是静默 archive)?→ 建议:发,一条消息换掉「thread 突然没动静」的困惑。
3. 四组 StateStore API 的 role 参数是「删参数」(编译期驱动改全调用点,推荐)还是「留参数但忽略」(diff 小但留死语义)?→ 建议:删。

## 9. 更新(2026-07-05,Annie mockup 审定案)

- §4 的「FLY-560 stage emoji 前缀照常」被 Annie 定案**收敛**:three-stage issue 标题前缀只到阶段级(🎨设计/🔨实现/🧪QA),细粒度 status 不再上标题;非 three-stage 字节不变。
- 新增定案:自动状态播报统一用专职「系统播报」bot(池子空 bot 03–06 复用),与聊天 Lead 身份分开。
- ①②③④ 全量定案见 plan.md §0;Annie 已批准 UX 说 go,Design 段交棒 Implement。
