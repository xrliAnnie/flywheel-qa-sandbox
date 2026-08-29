# FLY-892 一 issue = 一 thread — 调研

Issue: FLY-892 (https://linear.app/geoforge3d/issue/FLY-892/pipelineux-一-issue-一-thread-收敛三段式-designimplementqa-三-thread-lead-chat)
日期: 2026-07-05
基于: exploration.md

Brainstorm gate 已过(Tadashi 批方案 A + 三个开放问题全批)。随后 Tadashi 两条指令(d53dce5a / 2223facc)带来 **Annie 已批准(founder-approved,锁定)的两条 UX**:
① 每段消息带**模型标签**(『[设计·Opus]』格式 = 段名·模型名)+ thread 置顶一条 header 列三段各自模型;
② 置顶列该 issue 三段 session 的 tmux/cmux 位置 / exec id,可点跳去看各段 scrollback(复用 `chat_threads` 现成 `attach_pin_*` 字段);②依赖 FLY-887(三段 session 保活并存)才有全值,887 前优雅降级,**别把 887 改崩**。
③(读法/mockup/②与887配合)照常出 design → Tadashi → Annie 过目。
**Annie mockup-审两条追加定案(指令 3c87c49e)**:
③ thread 标题前缀只到**阶段级**(🎨设计/🔨实现/🧪QA),three-stage issue 上收敛 FLY-560 细粒度 status;非 three-stage 字节不变;
④ 自动状态播报统一用**专职「系统播报」bot**(池子空 bot 03–06 复用,不新开、不用 InfraBot),与聊天 Lead 身份分开。
**2026-07-05:Annie 批准 UX 说 go(指令 7ed3320a)→ Design 段交棒 Implement;QA 挂 892 自己的 QA 段。**

## 1. Thread 解析面(要收敛的全部代码位置)

### 1.1 StateStore(单一改动核心)

| 函数 | 位置 | 现状 | FLY-892 改法 |
|---|---|---|---|
| `upsertChatThread(threadId, channel, issue, lead, role)` | `StateStore.ts:2975` | role 路由双表 + delete-stale 按 (issue,channel[,role]) | **删 role 参数**,只走 `chat_threads` |
| `getChatThreadByIssue(issue, channel, role)` | `:3815` | role 路由双表 | **删 role 参数**,只查 `chat_threads` |
| `getChatThreadByThreadId(threadId)` | `:3861` | 先 main 后 phase,回显 `session_role` | **保留双表读**(历史 phase thread 的 reverse-lookup / reply-guard 分类) |
| `set/get/clearChatThreadAttachPin(..., role)` | `:3941/:3972/:4005` | role 路由双表 | **删 role 参数**,只走 `chat_threads` |
| `markChatThreadMissing/Archived(threadId)` | `:3902/:3922` | 按 thread_id 双表 UPDATE | **保留**(历史 phase 行仍可标失效/归档) |
| `normalizeChatThreadRole` / `ChatThreadRole` | `:263/:276` | role 归一 | 保留(`sessions.chat_thread_role` 标记语义仍在用) |
| `phase_chat_threads` DDL | `:1291-1308` | 侧表 + 唯一索引 | **保留 DDL 与历史行**,降级只读遗留;新增读查询 `getUnarchivedPhaseChatThreads()` 供 boot sweep |

### 1.2 ChatThreadCreator(创建唯一入口)

- in-flight dedup key `issue:channel:role`(`ChatThreadCreator.ts:256`)→ 回到 `issue:channel`。
- `ctx.chatThreadRole`(`:127`)从 `ChatThreadContext` **删除**;`_doEnsure` 查找/upsert(`:275/:401`)不再传 role。
- `phaseThreadBadge`(`:141-152`)**保留改任职**:从 base-title 徽章(`buildIssueThreadName` 拼接 `:172-173` 删除)变为 three-stage issue 的**阶段级标题前缀**来源(Annie 定案③:🎨设计/🔨实现/🧪QA 取代 FLY-560 细状态,经 `stampStageEmojiForSession`/`composeThreadTitle` 现有组装;非 three-stage 照旧 `stageEmoji` 细前缀,字节不变)。消息级区分另走模型标签 helper(§3)。

### 1.3 传 role 的调用点(编译期驱动清除第三参)

HeartbeatService(`:1264`)、bootstrap-generator(`:305/:330`)、gate-poller(`:1404/:1791/:1964/:2108`)、DirectEventSink(`:208` chatThreadRole 透传)、`Blueprint.ts:615` 的 envelope 字段**保留**(它落 `sessions.chat_thread_role` 标记),但 `ExecutionEventEmitter`→DirectEventSink 到 ChatThreadCreator 的 ctx 透传删掉。runs-route/tools/event-route/done-archiver/founder-ux/founder-consent 本来就不传 role → 零改动。

### 1.4 不动清单(three-stage 标记语义)

`sessions.chat_thread_role` 列 + Blueprint 派生(`Blueprint.ts:615-616`)+ `resolveCompletionSessionRole`(`three-stage-phases.ts:69`)+ `countSessionsByIssueAndChatThreadRole`(`StateStore.ts:2369`,FLY-859 轮次上限)+ `getThreeStageQaSessionsWithVerdictEvents`/`getStrandedThreeStageQaPassSessions`(`:2388/:2413`)+ `event-route.ts:671` + `phase-orchestrator.ts:363`。**全部逐字不动。**

### 1.5 HTTP API 面

- `/api/chat-threads/send|create|archive|GET`(`tools.ts`)与 `/api/chat-threads/register`(`chat-thread-register.ts:208`)已全走 main → 收敛后零改动、Lead 分叉自动愈合。
- `/api/chat-threads/by-thread`(`tools.ts:900`)靠 `getChatThreadByThreadId` 双表读 → 不变。
- `tools.ts:340` 的 `req.query.sessionRole` 是 **retry/action 的 session 选择器**(挑哪个 session 重试),不是 thread 路由 → 不动。

## 2. 现状已损坏、本次顺手治好的三处

1. **stage emoji / attach-pin 打错 thread**:`event-route.ts:407/:472` 不带 role 查 main → three-stage 下 phase thread 标题永不更新、pin 落在 Lead 误建的 main thread。收敛后天然正确。
2. **phase thread Done 后永不归档**:`done-thread-archiver.ts:211`、`post-ship-finalization.ts:273` 只解析 main 行(FLY-793 plan ⑤ 未落地)。收敛后新 run 只有一条 thread;历史 phase thread 由 boot sweep(§4)清掉。
3. **attach-pin 状态本来就按 main 键存**:`ensureRunnerAttachPinNow`(`ChatThreadCreator.ts:851`)读 pin state 不带 role → phase thread 的 pin 状态从未正确隔离过。收敛后语义归一。

## 3. 消息级 phase 标签(session_role 的新家;字面 = Annie 批准的 ①)

**Helper**:`phaseMessageTag(chatThreadRole: string | null | undefined, runnerModel?: string | null): string` → `"[设计·Fable] "` / `"[实现·Opus] "` / `"[QA·Sonnet] "` / `""`(main/缺省)。放 `packages/config/src/three-stage-phases.ts`(与 phase 表同源;`phaseThreadBadge` 及三个阶段徽章字面也**搬进同文件**作单一词表来源,供 ChatThreadCreator 与 stage-utils strip 逻辑共用,Codex R3 #4)。

- **模型显示名**:从 `MODEL_TIERS` 注册表按 `runnerModel` id 反查短名(Fable/Opus/Sonnet/Haiku);session 无 `runner_model`(账号默认)→ 按 `DEFAULT_PHASE_TIER[role]` 的计划模型渲染;再兜底只渲染段名 `[设计] `。
- 说话者的模型来自**该 session 自己的** `session.runner_model`(注入点手里都有 session)。

**注入点**(以 session 为输入、向 issue thread 发 founder-facing 文本的位置;caller 端 prepend,notifier 内部不感知 role):

| 位置 | 消息 |
|---|---|
| `gate-poller.ts` founder 通知 4 处(`:1404/:1791/:1964/:2108` 一带) | gate 问题 / approve 请求等 |
| `founder-thread-notifier.ts` 的三类 body(`buildBody:91`/`buildStuckBody:408`/`buildMilestoneBody:333`)的调用方 | 审批/卡死/里程碑 |
| `AutoQaEffects.postThread`(`auto-qa-effects.ts:128-142`,中心 seam)、`stuck-escalation.ts:579`(经 notifier opts)、`runner-ready-to-close-notifier` | QA 结果 / 卡死升级 / 可关提示 |

注意(Codex R1/R3 验证):`event-route.ts:198-346` 的 design_review/pr_created handler 是 CommDB 指令排队、**不是 Discord 发帖**,不注入。

Lead 的 `/api/chat-threads/send` 不加标签(Lead 就是 Lead)。thread 标题前缀 = **阶段级徽章 🎨设计/🔨实现/🧪QA**(Annie 定案③:three-stage issue 上取代 FLY-560 细粒度 stage emoji/状态词;非 three-stage 照旧,字节不变)。

## 4. 置顶 Pipeline Header(Tadashi gate 新增;吸收现有 attach-pin)

现状:FLY-560 Feature C 每 issue 一条 pinned 消息(`buildAttachMessageContent`,`ChatThreadCreator.ts:725`),内容 = 当前 runner 的 tmux attach 命令,PATCH 原地更新(per-thread FIFO `attachChains`,幂等键 = 存储的 `command`,`:868`),自愈(missing→重发,403→下次 stage 重试 pin)。

**FLY-892 扩展**:同一条 pinned 消息升级为「pipeline header」,three-stage issue 渲染:

```
📌 [FLY-XX] 三段流水线
[设计·Fable]  ✅ 完成   exec 1a2b3c4d — attach: <tmux 命令>   ← 887 后 session 保活可跳
[实现·Opus]   ▶ 进行中  exec 8e5b4127 — attach: <tmux 命令>
[QA·Sonnet]   ⬜ 未开始
```

- **数据源**:已开跑的段 → 该 issue 的 phase sessions(`session_role`/`status`/`runner_model`/`execution_id`;需新增 StateStore 查询 `getPhaseSessionsForIssue(issueId)`,按 `chat_thread_role IN ('design','implement','qa')` 取各段最新一条);未开跑的段 → `DEFAULT_PHASE_TIER`/`resolvePhaseModel`(`three-stage-phases.ts:78/:90`)+ `MODEL_TIERS` 短名;attach 目标 → 现有 CommDB tmux target 解析(`event-route.ts pinRunnerAttachForSession` 同一套),**对每个 CommDB 仍能解析到 target 的段都渲染**(= ② 的「点着跳去看各段 scrollback」)。
- **FLY-887 配合(sequence,Tadashi 指令)**:①(单 thread + 模型标签 + header 列三段模型)**独立先落**,不依赖 887;②(跳三段 session)的渲染是**可用性驱动** —— 887 前已完成段 session 已关、CommDB 无 target → 该行只渲染「✅ 完成(session 已结束)」;887(三段 session 保活并存)落地后,同一渲染逻辑自动对三段都给出 attach 目标,本 issue 侧零改动。**不碰 887 的任何东西** —— 只读 CommDB,不管 session 生命周期。
- **非 three-stage issue**(无 phase session):渲染回退到现有单-runner attach 格式,**字面不变**(非 three-stage 项目零变化)。
- **幂等/限速**:幂等键从裸 `command` 换成渲染内容本身(存进现有 `attach_pin_command` TEXT 列,不加列);内容没变→零 PATCH。更新触发点不变(stage_changed → `pinRunnerAttachForSession`),每段生命周期 stage 变化 O(个位数)次 PATCH,消息编辑无 2/10min 改名限速问题(改名限速只对 thread title)。
- **`attach_pin_*` 字段沿用**(Tadashi 点名):`attach_pin_message_id`(置顶消息 id)/`attach_pin_command`(幂等指纹)/`attach_pin_pinned_at`,不加列不迁移。

## 5. 迁移 / boot sweep

- **运行时归并**:部署后一切解析走 main 行。审计:880/882/883/886/887 均已有 main 行(Lead `/send` 建的)→ 直接归并;无 main 行的 legacy issue 下一条消息建唯一 main thread(每 issue 至多一次)。
- **Boot sweep `reconcileLegacyPhaseThreads()`**(挂 Bridge 启动,模式同 FLY-172 marker drain / FLY-863 reconcile,零新周期 timer):对 `getUnarchivedPhaseChatThreads()` 每行 → (a) 有 main 行:发指针消息「🔀 本 issue 后续消息已归并到主 thread <link>」→ archive → `markChatThreadArchived`;(b) **无 main 行 fail-closed(Codex R1 #1)**:issue 仍需可见面(running/awaiting_review/design_done/pending+worktree,专用判定、不用全局 TERMINAL_STATUSES)→ 跳过 + log skipped_no_main;terminal → 归档。幂等 by construction;Discord 失败 → 下次 boot 重试;逐行 try/catch 不断 sweep。指针消息由 announcer bot 发(定案④)。
- **数量级**:phase 侧表只在 flywheel 项目 2026-07-04(#446)后有行,≈ 880-892 波次 × ≤3 行,sweep 一次 <20 个 Discord 调用,无限速风险。

## 6. 测试面

- **单测(改/新增)**:`phase-chat-threads.test.ts`(FLY-793 Step 11 的 role-路由断言 → 重写为「role 不再路由:任何 role 都解析 main 行」+「历史 phase 行 reverse-lookup/归档保留」)、`ChatThreadCreator.test.ts` / `ChatThreadCreator.attach-pin.test.ts`(dedup key、标题无徽章、pipeline header 渲染三态、非 three-stage 字面回退 sentinel)、boot sweep 单测(指针消息/归档/幂等/单行失败不断)、`phaseMessageTag` 注入点抽查。
- **reverse-compat sentinel**:非 three-stage 项目(无 phase session、无 role 传参)全链路输出字节不变 —— thread 标题、pin 文案、消息文本。
- **真机 E2E(529 Room)**:派一个真 issue 走三段式 → 断言 `chat_threads` 恰 1 行、`phase_chat_threads` 零新行、Discord 恰 1 条 thread(对照 FLY-793 前科:FLY-277 pre-fix 2-thread 案例);Lead `/send` 落同一 thread;pinned header 三行随段推进更新(模型 + exec id + attach 目标);消息带 [设计·Fable]/[实现·Opus]/[QA·Sonnet] 标签,Lead 消息无标签。参考 memory:529-room 注入 gotchas(`TEST_REPLY_BY_ISSUE=1` 等)、thread 改名限速(每场景换 issueId)。

## 7. 系统播报 bot 身份(Annie 定案④)

自动状态播报(阶段播报、QA 播报、boot-sweep 指针、pipeline header 的 POST/PATCH/pin)统一改用项目级可选配置:输入键 **`announcerBotTokenEnv`**(env 变量名,沿 ProjectConfig 的 `botTokenEnv` 秘密模式)→ load 时 hydrate 出 runtime-only `announcerBotToken`,raw token 输入被 strip/拒绝(`ProjectConfig.ts:590-593` 同型);池子空 bot 03–06 之一;未配置 = 现状 lead bot,byte-compat 默认关。**路由规则一条:凡 @mention Annie 的消息 = lead bot(founder-thread-notifier 全部 body);纯播报 = announcer**(完整矩阵见 plan.md Step 7)。存量 pin 由 lead bot 所发 → announcer PATCH 403 → 并入现有 missing 自愈(clear + 重发重 pin)。Setup 前置:池 bot 需 channel 的 View/Send/Send-in-Threads/pin 权限。

## 8. 部署形态

纯 Bridge 侧(teamlead 包)+ edge-worker 的 ctx 透传删除 → **单次 Bridge 重启**;Runner/Lead 不动。与在飞 Bridge PR 攒批重启(Annie 纪律)。
