# FLY-2033 会议产物与闭环(C) — 调研
Issue: FLY-2033 (https://linear.app/geoforge3d/issue/FLY-2033/rayav5-会议产物与闭环c每场一单-notes-落-thread-复用互动卡)
日期: 2026-08-29
基于: exploration.md

> 世界标记:[raya] = raya `origin/main` 36be7e6(FLY-2032 会议骨架已并入,PR #5;FLY-2126 语音 harness 已并入,PR #6);[flywheel] = 本 worktree `d4e08f4a5`。

---

## 0. Attempt 2 事实审计:不是 Raya 专属,错在报告措辞

- 上游 FLY-2032 `plan.md` 明确把 actor 改成参数化 `leadId`:换 Lead 不换代码,身份是数据。当前 FLY-2033 `MeetingRecord.leadId` 同样接受任意非空 Lead id,规划器对所有存档逐场处理,不存在 Raya allowlist。
- 被 founder 引用的 ship report 原文把「meeting 数据面不依赖 Linear/Flywheel」写成「Raya 对 Linear、Flywheel 一无所知,也不该知道」。前半句是代码模块事实;后半句把模块边界错误人格化成 Lead 知识边界,必须撤回。实现侧同时清理 `rayaStateDir`/固定 `Raya` card meta 等会强化误读的命名。
- `dispatch.leadId: flywheel-product-lead` 指**会后 note-taker run 的 owner**,不是参会 Lead。参会者仍来自每场存档的 `leadId`;note taker 按 PRD §41 是会后独立 runner。
- 本轮交付不再引用「部署/激活后再验」。真实 Discord 证据由 QA 在 ship 前产生;实现只负责让该路径可执行并 fail-close。

## 1. raya 侧事实(逐行读自 [raya] main)

### 1.1 会议账本与存档(`packages/contracts/src/meeting.ts`)

| 产物 | 路径 | 性质 |
|---|---|---|
| 当前场快照 | `RAYA_STATE_DIR/meeting.json` | brain 单写;终局后被 `clearCurrentMeeting` 清掉 |
| 事件账本 | `RAYA_STATE_DIR/meeting-events.jsonl` | 追加;`appendMeetingEvent`(meeting.ts:998-1004),事件含 `meeting_ended` 等 |
| 终局存档 | `RAYA_STATE_DIR/meetings/<id>/meeting.json` | **不可变**(`archiveMeeting` meeting.ts:1067-1081:重复写要求逐字节一致,否则 throw);只有 terminal 状态(ended/cancelled/missed)可归档 |
| 简报 | `RAYA_STATE_DIR/meetings/<id>/briefing.md` | 2030 写;前两行 `preparedAt:`/`validUntil:` 元数据合同 |
| 通知回执 | `RAYA_STATE_DIR/meetings/<id>/notifications.json` | routes: `shared-leads` / `lead-mailbox` / **`meeting-thread`** —— **排会卡开出的 Discord thread id 已落在回执里**(`MeetingNotificationReceipt`,meeting.ts:103-117) |
| 语音信号 | `RAYA_STATE_DIR/meetings/<id>/voice-signal.json` | voice 容器写 ready/live/interrupted/ended |

Meeting schema v2 字段(meeting.ts:33-58):`id/leadId/topic/scheduledAt/durationMinutes/requestedBy/status/continuesFrom/voice{liveAt,readyAt,…}/endedAt/endReason`。⇒ **会议时间窗 = `voice.liveAt`(或 `voice.readyAt` 兜底)→ `endedAt`**,note taker 切转写用它。

### 1.2 转写在哪(`apps/voice/src/evidence.ts` + `runtime.ts`)

- 逐事件留证:`RAYA_STATE_DIR/voice-evidence/events.jsonl`(config.ts:405),`EvidenceLog.record` 每行 `{ts, ...event}`,0600。
- **转写事件**:`kind:"realtime_transcript"`,字段 `{ts, role, text, generation}`(runtime.ts:738-747,只记 `chunk.final`)。`generation` = **session 代**(与 `state.gen.session` 比对,runtime.ts:730/752)。⚠️ 事件行里没有 meetingId。
- **会议锚点事件(逐行核实)**:
  - `meeting_container_starting` = `{kind, ...config.meeting(含 meetingId), processGeneration}`(runtime.ts:349-357);
  - `meeting_container_live` = `{kind, ...config.meeting(含 meetingId), processGeneration, threadId, coldStartMs}`(runtime.ts:385-399);
  - ⚠️ `voice_exit` = `{kind, code, reason}` —— **不带 meetingId、不带 generation**(runtime.ts:513-517),⛔ 不能当会议作用域的终止锚;
  - `processGeneration`(进程代)与转写的 session 代是**两个计数器,不能直接 join**;⚠️ session 代是**进程内计数器,跨进程重启会重用数值** ⇒ ⛔ 任何「generation 全局黑名单」都不是有效归属判据(codex R3 #1 证伪)。
  - 会议侧终局的 meeting 作用域证据 = 不可变存档的 `endedAt` + `meetings/<id>/voice-signal.json`(`state:"ended", at`,meeting.ts:517-520 路径)。
- **🔑 转写归属的真正不变量 = 语音进程单写者串行化(源码强制,逐行核实)**:
  - `cli.ts:227-230`:`claimPidFile(config.paths.pidFile, process.pid)` 在 assemble runtime、创建 EvidenceLog、`runtime.boot()` **之前**执行;claim 失败 ⇒ `startup_refused` 直接退出,**一行 evidence 都不写**;
  - `store.ts:144-165` `claimPidFile`:已有 pid 存活且经 `ps -o command=` 验明是 raya voice 进程(`processOwnsVoicePid`,store.ts:125-142,ps 出错 fail-closed)⇒ 拒绝 claim(`pid_owner_alive`);死 pid/非 voice 属主 ⇒ unlink 后 `wx` 独占创建;
  - `evidence.ts:12-17`:`appendFileSync` 同步追加 ⇒ 进程死后不可能再补写。
  ⇒ **同一 state dir 任一时刻至多一个 raya voice 进程在写 events.jsonl**(会议容器与普通语音模式互斥)。⚠️ 互斥不证跨崩溃的连续性:会议容器不净死后,普通语音进程可接管并无标记地写转写/`voice_exit`(supervisor down 时普通语音会覆写 meeting request,voice-mode.ts:228-236)⇒ ⛔ `voice_exit` 不可归属、不进合同(codex R4 #1)。
- **🔑 连续性证据 = voice-signal.json 单归属**:`run` boot 必须有 voice request(cli.ts:174-190);request 携带 meetingId 时成功 boot 的进程必是本会议容器(cli.ts:69-77 + meeting-context.ts:20-35,mismatch throw ⇒ cli.ts:233-241 写 `startup_refusal` 可见标记);容器先写 `meeting_container_starting` 再起 realtime(runtime.ts:349-357,锚先于转写);`meetings/<id>/voice-signal.json` **只有本会议容器会写**(runtime.ts:855-868,带 bootId)。⇒ 最终 signal(ended/interrupted)@T + pid 互斥 ⇒ [S_k, T] 全部事件归会议容器(S_k = T 前最近 container_live 且其间无其他 container_starting)。窗口切片规则见 plan §3.5;⛔ 不能只按 ts、voice_exit 或 generation 对齐。

### 1.3 终局的权威触发点(`apps/brain/src/meeting.ts`)

`finishTerminal`(meeting.ts:331-353):终局播报(🏁/⚠️/🗑️)→ `archiveMeeting` → 清 voice request → `clearCurrentMeeting`。到点 tick 与 voice-signal 消费都汇到这里;**「会开完了」的机器可读事实 = `meetings/<id>/meeting.json` 存档出现且 status=ended**。R-43 的「自动察觉」应钉在这个事实上,不钉在 Discord 播报文本上。

### 1.4 排会卡与 thread(`apps/brain/src/meeting.ts:67-82`)

`meetingScheduleCard` 产出机器可读卡(首行真 `@lead`,第二行 `[meeting_schedule:v1]`,含 `meeting_id`/`lead_id`);`MeetingInvitationPublisher.publish` 返回 `{messageId, threadId}` —— **每场会在共享 Lead 频道已经有一条从排会卡开出的 Discord thread**,id 在 `notifications.json` 的 `meeting-thread` route 里。

### 1.5 meeting 模块的依赖边界(不是 Lead 知识边界)

[raya] 仓无 Linear SDK、无 flywheel 包依赖(package.json 仅 discord/ws/codex 侧);Linear IO 所有权在 flywheel 侧。⇒ R-20 的 issue 创建不该让 meeting runtime 直连 Linear(exploration Q-A 的 A1 出局)。这条结论只约束模块依赖与凭据归属,**不描述 Raya 或任何 Lead 知道什么、能看什么**。

## 2. flywheel 侧事实

### 2.1 publish-report 管线(会后卡的托管与投递)

- 客户端 `packages/flywheel-comm/src/commands/publish-report.ts`:① `POST {bridge}/api/reports/publish` 拿不可猜 hosted URL;② ProofShot 截图;③ `POST /deliver` 发**一条** Discord 消息。HTML 上限 512 KiB。
- **权限分层(对本单关键)**:ingest tier(普通 runner)**没有 `/deliver` 权限**(publish-report.ts:133-141)—— runner 只能 `--publish-only` 拿 URL。现有 `founder_review` gate 接收 `--hosted-url + --artifact`,校验 HTML 已在当前 `HEAD` 提交且 clean,再由 Bridge 的 founder-review notifier 把带 URL 的 📝 卡投进 canonical issue thread;不需要 runner 持 master token或新造 Discord API。
- **deliver 的 channel 解析**(reports-route.ts:428-454):显式 `channelId` → **`issueIdentifier` 解析到该 issue 的 Lead thread**(report-issue-thread-resolver.ts,多匹配 fail-closed)→ project generalChannel。⇒ **往「issue 自己的 thread」发报告是现成能力**,传 `issueIdentifier` 即可。
- CSP/nonce:`report-registry.ts:345-396` 把 `__CSP_NONCE__` 全量替换成 per-report nonce 并注入 `script-src 'nonce-…'` CSP(`default-src 'none'; style-src 'unsafe-inline'; img-src data:`;**无 `connect-src`** —— 托管页发不了任何请求)。页面自带 CSP meta 会抑制注入 → 脚本被 block。
- 保留策略:最多 100 份 / 8.5 MiB / **7 天过期**(report-registry.ts:41-45)。⚠️ 对本单的推论:**hosted 卡是短命评审载体,不是归档** —— 归档靠 R-25 的 repo ship,7 天过期与「所有东西都有记录」不冲突,但 plan 里要写明。
- `verify-report --url <hosted> --expect '【页面意见汇总】FLY-XXXX'`(verify-report.ts):HTTP 2xx + nonce 已替换 + 每个 script 带 nonce + 子串存在 —— 发给她之前的那道闸。

### 2.2 互动卡合同的权威出处

- **提示词即规范**:`packages/edge-worker/src/Blueprint.ts:740-777`(founderDesignHtmlDeliveryLines)—— 分节 textarea + localStorage(key 含 `location.pathname`)+ 【页面意见汇总】marker + 1800 字分块 + 单 nonced script + addEventListener + mmdc 内联 SVG。**没有共享 template/generator**,仓内模式 = 每 issue 一份 `founder-design.template.html` + 临时组装脚本;`FLY-1693/build-report.py:7-9` 的三条断言(无 SVG 占位残留 / `__CSP_NONCE__` 恰一次 / 无自带 CSP)值得照抄。
- 原文红线:**"This marker is revision feedback, never a pass signal"**;"Never tell her the page auto-syncs comments"(Blueprint.ts:798)—— 页面不自动回传,必须她点复制粘回。

### 2.3 她的留言怎么「被消费」(⚠️ 反直觉,本单最重要的事实)

全仓搜 `【页面意见汇总】`:**没有任何代码解析这个 marker**(命中全是提示词与测试 fixture)。真实链路:

1. 她把汇总文本**粘进 Discord thread**(自由发言,不是 reply-to 卡)。
2. `bridge/founder-reply-deliverer.ts` 轮询 thread:Bridge 只做 transport,不分类不裁决;自由发言落兜底路径(L805-832)→ `deliverAmbiguousToLead`。
3. `bridge/gate-poller.ts:3108-3164` 构造 **`event_type:"founder_reply"`** 的 lead_event(summary=原文,带 thread/message id)→ 投给 Lead。
4. Lead 判断后用 `flywheel-comm respond <qid> …`(答 gate)或 `flywheel-comm send`(写 CommDB instruction → runner mailbox)把内容转给 runner。
5. 可靠性:processed-through cursor 至少一次投递 + `founder_reply_retry` 表 + dead-letter 告警。

⇒ **「founder 在卡上留意见并被消费」= 她粘贴 → founder_reply → Lead → runner mailbox,机制现成、零新增**。marker 是给人看的 provenance,不是路由键。若想「真自动回流」(页面直接 POST 回 Bridge)= 新机制 + 放宽 hosted CSP 的 `connect-src` = 新安全面 —— 本单不做(R-27 本来就说复用现有形状)。

裁决语义边界(测试锁死):marker 文本对 founder_review 卡判 `neither`、对 ship 卡判 `neutral_not_written` —— **贴汇总永远不会被误读成 approve/打回**。

### 2.4 Ship Card + founder approve(R-41 第 4 步的现成机制)

- Runner:`flywheel-comm gate approve_to_ship --no-block`(硬前置 CI green)→ `complete --route needs_review --pr <N> --question-id <id>` → 等唤醒。
- Bridge 出 🚀 Ship gate 卡(founder-thread-notifier.ts:116-129);她卡上 ✅ 或 reply `approve`;打回 = reply「打回」/`design:|implement:|qa:` 前缀。
- `flywheel-comm verify-approval --exec-id --pr-head`:本地 fail-closed 校验(approved response + founder 归属 + founder_review 轮次 + codex review + CI + `pr_head_sha` 一致)。
- merge 唯一路径 = `gh pr comment ":cool:"` 触发 deploy workflow;runner 绝不 `gh pr merge`。

⇒ R-41 的「提 PR、出 Ship Card、她 approve 才进 main」**逐字就是现有 runner ship 流程**,note taker 无需任何新机制。

### 2.5 Linear issue 创建入口

- **正路 = Bridge HTTP proxy**(`LINEAR_API_KEY` 只在 Bridge,GEO-187 pattern):`POST /api/linear/create-issue`(plugin.ts:3186-3424),入参 `{title, description?, priority?, labels?(名字), team?(key), project?(name), projectName?}`;labels 按名 team-scoped 解析;**无 assignee 参数**。兄弟路由:`PATCH /update-issue`、`POST /comment`、`GET /issues`。
- **本地进程直连 `@linear/sdk` 的唯一先例 = 小红书 flow**:`scripts/xiaohongshu-learning-tick.sh`(launchd wrapper,mkdir 原子锁防重入,从 `~/.flywheel/.env` 取 `BRIDGE_URL/TEAMLEAD_API_TOKEN/LINEAR_API_KEY`)→ `scripts/xiaohongshu-scheduler.ts`(装配层,**find-or-create 幂等**:稳定 title 先查后建)→ `packages/teamlead/src/xiaohongshu-scheduler.ts`(纯决策核,DI 可单测)。**三层结构 + 幂等 + 锁,是「自动化周期任务」的既定模板**。
- **`/glaw` huddle 已在做「一场会 = 一张 issue」**(另一套会议系统,voice-bridge 侧):`GlawCommand.ts:175` 自动立项(立项失败 = 会不开);`ConclusionPipeline.ts` 会后落地顺序 `summary comment → worktree → Done → TIV card`,`SUMMARY_MARKER(identifier)` 做**幂等标记**,`LandingProgressStore` 断点续跑。⚠️ 这是 huddle 线不是 Raya 线,但幂等 marker 与落地顺序值得照抄。
- `packages/flywheel-comm` **没有**建 issue 子命令。

### 2.6 issue↔Discord thread(R-24b 的「现成机制」实体)

- Bridge 单例 `ChatThreadCreator.ensureChatThread`(ChatThreadCreator.ts:325-350):**FLY-892 收敛「one issue = one thread」**;映射存 `~/.flywheel/teamlead.db` 的 `chat_threads` 表(UNIQUE(issue_id, channel_id));thread 从 root message 开出(`threadId === rootMessageId`),thread 名 `[FLY-XX] <title>`。
- **runner 派单时自动开 thread**:`DirectEventSink.ts:293-364` 在 session started 事件里 await ensureChatThread。⇒ note taker 一派单,issue thread 就存在。
- 往 issue thread 发消息的现成 API:`POST /api/chat-threads/send`(tools.ts:699-1000,lookup-first);`publish-report --issue FLY-XXX` 由 Bridge 解析到该 issue thread 投卡;founder gate 卡(founder-thread-notifier.ts)直接 POST 进 thread。
- ⚠️ FLY-270 key 规范化坑:`chat_threads.issue_id` 实践上是 identifier;新代码要照抄 tools.ts:847-856 的规范化,否则会造出 UUID-keyed 重复 thread。
- 路由纪律:带 issue token 的内容禁发 chatChannel 顶层(reply-guard.ts:9-15),必须走 thread。

### 2.7 issue → runner 派工

- **没有自动派单**:唯一入口 `POST /api/runs/start`(runs-route.ts:984);全仓没有「轮询 Linear 见新 issue 就起 runner」。
- `/start` 预检:`LINEAR_API_KEY` 必需 → 拉 labels(失败视作无 dept label,fail-closed)→ **department scope gate**(无 dept label 或 label 不匹配 → 403 DEPT_SCOPE_REJECT)→ 未传 leadId 时按 labels 解析 Lead。⇒ **会议 issue 必须带 department label 才派得动**。
- 派单要带 `taskCategory`(canonical work kind);menu 解析:`.flywheel/menus/ic-roster.yaml`(design/implement→engineer-executor、**generic→general-executor**…)+ `adoption.yaml`(**flywheel-eng-lead: [code, simple_code, generic]**;flywheel-product-lead: [prd, design, prototype] —— ⚠️ **product lead 未收养 generic**)。
- 自动触发的唯一既定模板 = xhs launchd tick(§2.5)。

## 5. 结论:exploration 三个架构问题的答案(事实驱动)

| 问题 | 答案 | 依据 |
|---|---|---|
| Q-A 谁开 issue | **flywheel 侧周期 tick(reconciler),照抄 xhs 三层模板,find-or-create 幂等** | raya 仓零 Linear 依赖(§1.5);FLY-2032 plan §5 把 2033 定义为 raya 账本的**读者**;xhs tick 是既定模板不是新轮子 |
| Q-B 哪条 thread | **flywheel issue thread(chat_threads)= 会后产物面**;V4 排会卡 thread = 会前/会中状态面,两面并存不冲突 | §2.6:派单即建 thread;publish/gate 卡都能进 issue thread;R-24b「现成机制」指的就是它 |
| Q-C 怎么察觉会开完 | **同一个 tick 轮询 `RAYA_STATE_DIR/meetings/*/meeting.json` 存档**:见 ended → 派 note taker;见 missed/cancelled → 留痕后关单 | §1.3 存档是终局的机器可读权威;§2.7 无现成事件桥,tick 是唯一模板;存档不可变 ⇒ 轮询无竞态 |
| Q-D note taker 宿主 | 🔄 **已被 plan 取代(codex R1 #1/#4)**:~~taskCategory=generic + 路径走 trigger body~~ ⇒ **taskCategory=prd + flywheel-product-lead**(generic shape 无 founderReview 能力,workflow-menu.test.ts:446-464 锁死);**路径唯一真源 = 受信配置 `.flywheel/meeting-notes.yaml`**,issue body 只带 meeting_id(同源自证被打掉)。不变的:标准 runner + meeting-notes skill,worktree = flywheel 仓,她砍的新 DAG 节点不复活 | plan §2/§3.2 为准 |
| Q-E 互动卡与消费 | 🔄 **回流协议已被 plan 收窄(codex R1 #5)**:publish-report(--publish-only)+ founder_review gate 卡进 issue thread;她粘汇总 → founder_reply → **Lead 只用 `send` 原样转 runner(⛔ `respond` 被 respond.ts:49-52 明令禁答 founder_review)**;gate 只被她对当前卡的显式 verdict 解除;不承诺自动回流 | plan §3.3 步 6 为准;§2.1-2.3 机制事实仍有效 |


## 3. 互动卡片合同(R-27 的「现有形状」)

现行 founder-design 卡的实现(以 `engineering/doc/FLY-2032-raya-meeting-mode/founder-design.template.html` 为范本,同构于历代 founder HTML):

- 分节 `<section>` + 每节 `textarea[data-k]`;`input` 时写 `localStorage`,key 前缀含 `location.pathname`(多报告同源防串);全部 try/catch。
- 底部汇总卡:聚合非空意见,首行 `【页面意见汇总】FLY-XXXX`;>1800 字分段,每段重复 marker;复制走 `navigator.clipboard.writeText` → `document.execCommand('copy')` 兜底。
- 全部 JS 在单个 `<script nonce="__CSP_NONCE__">`;事件全 addEventListener;零外部依赖;mermaid 图 build 时经 `mmdc --svgId <issue>-dN` 渲染成内联 SVG。
- 回传通道 = 她把汇总文本**粘回 Discord thread**;没有评论后端。

⇒ R-23 的「action item 逐条要不要做」可以在这个合同内表达:每个 action item 渲染成一节,节内加三态快选(采纳/不做/有意见)+ textarea,三态写进同一 localStorage 并进汇总文本 —— 机制零新增,只是分节粒度与节内控件的内容差异。

## 4. ~~尚待核实~~ 已全部闭合(2026-08-29)

- ~~Q-A~~ ✅ §2.5 已答(Bridge proxy + xhs 直连 SDK 先例)。
- ~~Q-B~~ ✅ §2.6 已答(chat_threads,一 issue 一 thread)。
- ~~Q-C~~ ✅ §2.7 已答(无自动派单;runs/start + dept label;⚠️ 派单形态最终定 prd,见 §5 Q-D 行)。
- ~~Q-E~~ ✅ §2.3 已答(无机器解析端;回流协议最终形态见 plan §3.3 步 6)。
