# FLY-793 三段式 agent 拆分 — 前半实施计划

Issue: FLY-793 (https://linear.app/geoforge3d/issue/FLY-793/pipeline-三段式-agent-拆分-designimplementqa-各一个-agent-各配模型-可开关-77-前-fable)
日期: 2026-07-02
基于: exploration.md, research.md

## Scope（前半，非 795 部分）

实现三段式的 **session 交接骨架 + 每 phase 模型 + toggle + 阶段可见性**——一个 issue / 一次 RPCI / 内部三 phase-session(Design=Fable / Implement=Opus / QA=Sonnet),在同一分支 B 上顺序接力(锁定架构 exploration §2A)。

**defer 到 FLY-795(Lead relay 对齐)**:`progress.md` 的 schema/位置 + 「重启中途续 phase 的干净非有损快照」保证。795 未落前,Design→Implement 内容交接靠**已 commit 的 docs**(doc-flow) + **pin 到上段 head** 做 bootstrap;`progress.md` 读写留 `TODO-795` seam。

> **Codex R1 更正(已纳入)**:早期草案两条 reuse 假设与源码不符——(a)分支**不是**同 issueId 白送(`deriveWorktreeKey` 给非-main role 加 `-role` 后缀);(b)现有 `AutoQaCoordinator` 只从 `main` 触发且必建独立 QA·FLY-XX issue。所以「同分支」「同 issue QA」都需 793 **新增自有契约**(Step 3/4/8),不是纯复用。Codex 确认:前半仍可在 795 前 ship,但必须补这些契约。

**byte-compat 底线**:toggle 默认 OFF = 现状单 session / 现有 auto-QA 零变化。

## 复用 vs 新增(核实后)

- **真复用**:`StartRequest`(sessionRole/agentName/dispatchModel/startPoint/qaContext/requireMailboxTransport,`retry-dispatcher.ts:85`)· `RunDispatcher` dedup `issueId:role`(`run-dispatcher.ts:240,593`)+ forward dispatchModel(`:625`)· 两 completion surface(`event-route.ts:1784` + `DirectEventSink.ts:581`,均在 notify 前跑 auto-QA)· Blueprint `qaContext` prompt 分支(`Blueprint.ts:357/372`)· FLY-99/603 worktree 清理原语。
- **必须新增(793 自有)**:三段共享 branch-key 覆盖(Step 3)· phase-handoff 生命周期 + headSha 捕获(Step 4)· phase-完成 durable 信号 + held-first 接线(Step 5)· PhaseOrchestrator(Step 7)· internal-QA 路径(Step 8,不建 QA·FLY-XX)· role-aware reader 审计(Step 9)。

## 实施步骤（TDD:先写失败测试 → 最小实现 → 重构）

### Step 1 — toggle config `pipeline.three_stage`（Codex R1 #6 精确化）
- **文件**:`packages/config/src/ConfigLoader.ts`(`pipeline` mapping 校验,**malformed → 与 `doc_flow` 一致:load 期 throw**,非静默;`ConfigLoader.ts:317` 是范式)。
- **语义**:`pipeline.three_stage: true` 才开;**缺省 = OFF**(注意:与 auto-QA 的 default-ON 不同——三段式是**新** opt-in feature,默认关保 byte-compat)。全局 kill-switch env + per-issue `no-three-stage` label。
- **✅ per-project(Annie 2026-07-03 追加,本设计已满足)**:`pipeline.three_stage` 是**每个项目自己的 `.flywheel/config.yaml` 键**(与 `qa.auto`/`doc_flow` 同为 per-project,非全局 flag);`resolveThreeStagePolicy(pipelineConfig=项目 config)` per-project 解析。**默认只 flywheel 开**:flywheel 的 `.flywheel/config.yaml` 设 `pipeline.three_stage: true`(ship 时的 config 改动),**其它项目(含 GeoForge3D)不设 → 默认 OFF = 逐字单段现状**。Step3 门控随之 per-project(项目 OFF → 从不 set `shareParentBranch` → 全 `main` → byte-compat)。→ **无代码改动、只是 flywheel 部署时开 config**。
- **RED**:有键 on / 缺键 off / malformed throw-at-load;env kill-switch;label opt-out;**per-project:flywheel config on → 该项目 issue 三段;别的项目缺省 → OFF/单段(逐字不变)**。

### Step 2 — phase 模型映射（canonical tier ID）（Codex R1 #6）✅ 已实现
- **文件**:`packages/config/src/three-stage-phases.ts`(+ index 导出)—— `ThreeStagePhase` 类型、`THREE_STAGE_PHASE_SEQUENCE`(design→implement→qa)、`DEFAULT_PHASE_TIER`(design=heavy/implement=medium/qa=light)、`resolvePhaseModel(phase)`→canonical id(复用 `MODEL_TIERS`,与 fleet/pricing 对齐)、`nextPhase(phase)`(给 PhaseOrchestrator 选下一段)。
- **固定表 + toggle-revert(定案,精化)**:表固定 = Annie 的 design=Fable/implement=Opus/qa=Sonnet;**7/7 revert = 关 `three_stage` toggle(回单 session),不是改这张表** → 表保持简单显式。**FLY-767 的 prefer-Fable 是 issue 级路由(Lead 分拣/dispatch model)的事,不塞进这张固定 per-phase 表**(免得悄悄盖掉 Annie 明确的 implement=Opus)。
- **测试(4 绿)**:序列;tier 映射;canonical id(fable-5/opus-4-8[1m]/sonnet-5);nextPhase 走到 qa=null。

### Step 3 — 三段共享 branch/worktree key 契约（Codex R1 #1 + R2 #3，NEW）
- **问题**:`deriveWorktreeKey(id, role)` 对非-main role 返 `${id}-${role}`(`WorktreeManager.ts:53`),Blueprint 用它建 branch(`Blueprint.ts:651`,`WorktreeManager.ts:138/144`)→ 三 phase 会各派 `id-design`/`id-implement`/`id-qa` 分支,**破坏锁定架构**。
- **改(✅ 已实现)**:落地成 **boolean `shareParentBranch`**(非外部 key value)。Blueprint 用新 pure `resolveWorktreeKey(node.id, {sessionRole, shareParentBranch})`;set 时三 phase 都收敛到 `deriveWorktreeKey(node.id,"main")` = 父 issueId 同一 branch B(无 role 后缀)。normal auto-QA / 其它 role **保持现有 role 隔离**(不动)。
- **QA 也是 writer、也占 B**(Annie 2026-07-02 拍 Q1 = QA 给写权限:把 test/report 写进分支 B、可能写 test 专用代码,权限跟别的 issue 一样)。所以三段全是 B 上的**顺序 writer**、同时刻只一个(git 同分支 checkout 硬拦 + 顺序保证)。QA 摞 test/report 提交到 B(Annie one-branch「QA 摞 test」那个样子),最终进 PR。**不再是 read-only / 不再 parked** —— 与 Model A 的调和更干净:每段干完 push+关闭 B,下一段(含 Implement-fix)再重起占 B,天然无 parked runner 挡 B(见 Step 8)。
- **安全(R2 #3,实现更强)**:boolean 比外部 key value **结构性更安全**——shared key 由 **node.id 自身**算,**绝不信外部 key 字符串** → mis-scope/注入面消除(最坏用自己 issue 的 main key,永远碰不到别的受管分支)。Bridge 内部字段:`StartRequest` + `RetryRequest` 都加、run-dispatcher 两 ctx 都 thread;`/api/runs/start` 不读它(runs-route 显式列字段、不含)。
- **实现**:`WorktreeManager.resolveWorktreeKey`(新 pure)+ `Blueprint` 用它 + `BlueprintContext.shareParentBranch` + `StartRequest`/`RetryRequest.shareParentBranch`。
- **✅ 测试(3 绿)+ typecheck**:absent→role-aware(byte-compat);shareParentBranch→三段收敛同一 B;`../evil` sessionRole 被忽略(用 node.id 自身);edge-worker + teamlead build 通过。**follow-up**:retry 保留 shareParentBranch 需持久化 + retry 重导(镜像 docTier,归 PhaseOrchestrator/Step 7)。

### Step 4 — phase-handoff 生命周期 + headSha 捕获（Codex R1 #2/#4，NEW）
- **问题**:即使共享 key,`git worktree add -B` 在分支被另一 worktree checkout 时仍失败(`WorktreeManager.ts:159`);现有 awaiting-review 保留 worktree 到批准;dirty-safe cleanup 是 post-ship 语义(要 tmux 关闭 + clean tree,`worktree-cleanup.ts:1/95`);`removeIfExists()` 是**启动期 stale 清理**,不能当正常交接原语(会丢掉正被交接的 worktree)。
- **契约(每次 phase 边界)**:① 校验本 phase 产物已 commit+push;② **捕获上段精确 head SHA**(从上段 worktree `git rev-parse HEAD`,**cleanup 前持久化**为 `evidence.headSha`——不用 `session.branch`,auto-QA 也是 pin `pr_head_sha` 而非 branch,`auto-qa-coordinator.ts:248`);③ 有意关闭上段 runner/tmux;④ dirty-safe worktree 移除;⑤ **然后**在捕获的 SHA 起下段(`startPoint = evidence.headSha`);⑥ 任一步(SHA 捕获/clean/tmux 关/移除)失败 → **fail-closed + 告警 Lead**,不起下段。
- **RED**:正常交接 = 捕获 SHA→关→移除→起下段 pin SHA;push 缺失/dirty/SHA 缺 → fail-closed 不起 + 告警;不误用 `removeIfExists` 丢交接 worktree。

### Step 5 — phase-完成 durable 信号 + held-first 接线（Codex R1 #7 + R2 #2,精确枚举）
- **问题**:`design_review`/`pr_created` 是 stage/gate 概念、非 durable phase-完成信号;prompt-only 停不足以驱动编排。现有枚举**严格**:`DecisionRoute` = `auto_approve`/`needs_review`/`blocked`/`pr_handoff`(`core/src/decision-types.ts:8`);`complete` 收 + `no_code`(`complete.ts:30`);sink 映射 status(`DirectEventSink.ts:337`);HTTP 严格 route guard(`event-route.ts:843`)。**不能留占位符。**
- **精确信号(定案)**:
  - **Design-完成 = 新增 route `phase_design_complete`**(Design 段 commit docs + progress.md 后 `complete --route phase_design_complete`)。**plumbing 镜像 FLY-493 `pr_handoff` 全套**:加进 `complete.ts` 允许集 + `DecisionRoute`(或独立 phase-route 类型)+ 两 sink 映射到一个**非终态** "design_done" status(不走 completed 终态清理)+ HTTP route guard + complete-marker replay + 全测试。PhaseOrchestrator 收到 → 起 Implement phase。
  - **Implement-完成 = 复用现有 `needs_review` → awaiting_review**(PR + evidence 落库,= auto-QA 现挂点)。PhaseOrchestrator 在 `three_stage && session_role=="implement"` 时 **held-first** 挂它 → 起 internal-QA phase(Step 8),替代默认 auto-QA;非 three_stage → 现状 auto-QA 不变。
  - **QA-完成 = 现有 `qa-result`**(PASS/FAIL);PASS → 放行 founder/ship;FAIL → 起 Implement-fix phase(Step 8 Model A)。
- **接线**:PhaseOrchestrator 在 completion mapping **已持久化 status/evidence 之后**、**任何泄露 founder gate 的通知之前**触发(镜像 auto-QA held-first,`event-route.ts:1784`/`DirectEventSink.ts:581`,别误 overload)。
- **RED**:`phase_design_complete` 全 plumbing(两 sink + guard + marker replay)+ 非终态 status;Implement `needs_review` 在 three_stage+implement 下起 internal-QA(held-first、通知前);QA PASS/FAIL 各触发;错误 route 不误触发;非 three_stage 全逐字不变。

### Step 6 — phase-aware 停点（Blueprint 按 sessionRole 换 prompt）（Codex R1 keep）
- **文件**:`packages/edge-worker/src/Blueprint.ts`(镜像 `qaContext` role 分支 `:357/372`)。
  - `design` → onboard→brainstorm→research→plan→design_review、docs(+progress.md TODO-795)commit 到 B、complete(**不进 implement**);brainstorm/design-review gate 在此。
  - `implement` → 读 B+docs 续 → implement→test→code_review→pr_created(**不重跑 design**)。
  - `qa` → 复用现有 QA-mode(独立验;pre-795 **read-only**,见 Step 8)。
- **✅ 已实现(base prompts)**:Blueprint 加 `isDesignPhase`/`isImplementPhase`(three-stage 且 sessionRole=design/implement);design prompt = 设计四步 + `phase_design_complete`(不 implement/PR);implement prompt = 读 committed design + 实现四步(含 PR);default 逐字不变。gate 掉 design 的 land/legacy 步骤。**4 测绿 + 101 现有 Blueprint 测全绿(byte-compat)**。
- **follow-up(→ Step 7)**:共享的 LEAD-REPORT-BACK / approve-gate / brainstorm-gate / merge-authority block 的 per-phase 精确 gating(design 不 ship、implement 不重跑 brainstorm、approve 在 QA 后而非各段)与编排流程耦合,随 PhaseOrchestrator 一起收口;当前 design 的显式「不 PR/ship」步骤先兜底,且 three_stage 默认关。

### Step 7 — PhaseOrchestrator（Codex R1 keep，接 Step 3/4/5）
- **文件**:新 `packages/teamlead/src/bridge/phase-orchestrator.ts` + 两 completion surface 都接(`event-route.ts` + `DirectEventSink.ts`)。
- **逻辑**:three_stage ON 且命中 phase-完成信号(Step 5)→ 跑 handoff 生命周期(Step 4)→ `startDispatcher.start({issueId(父,同), sessionRole:下一 phase, dispatchModel:模型表, startPoint:evidence.headSha, agentName:phase-executor, worktreeKeyOverride:sharedBranchKey})`。fail-closed(Step 4⑥)。
- **RED**:design-完成→起 implement(同 issueId/Opus/pin headSha/共享 key);OFF→不起(byte-compat);缺 headSha→不起+告警;两 surface 都接。

### Step 8 — internal-QA 路径 + fix-loop 生命周期（Codex R1 #3 + R2 #1，NEW `ThreeStageQaCoordinator`，**Model A**）
- **问题**:现 `onMainAwaitingReview` 仅 `main` role 触发(`auto-qa-coordinator.ts:233`);`spawnQa` 必建独立 `QA·FLY-XX`(`:396`)、用 `issueId: qaIssue.issueId`(`:459`);测试断言 QA 在独立 issue(`auto-qa-coordinator.test.ts:165`)。**不能直接复用**。且现 FAIL 假设父 implementer 仍活着 awaiting_review、`feedbackWakeMain` 直唤旧 exec(`auto-qa-coordinator.ts:547/654`,`auto-qa-effects.ts:241`)——**与 Step 4「Implement 交接前已关闭」矛盾**。
- **QA 写权限(Annie 2026-07-02 拍 Q1)**:QA 给**写权限**——把 test report 写进分支 B、可能写 test 专用代码,权限跟别的 issue 一样(她原话「建议给它比较多的权限」)。所以 QA 是 **B 上的 writer phase**(Step 3),不再 read-only、不再 parked。QA prompt 从现有严格 read-only(`Blueprint.ts:372`)放开为可 commit/push test/report 到 B。**独立性靠「另一个 session + Sonnet 模型」保住**(不是靠 read-only)。
- **生命周期 = Model A + 全顺序 writer(定案,与 exploration §3.2/§3.3 一致、restart-safe、比 read-only 版更简)**:
  - Implement 完成 → Step 4 关闭 Implement/交接干净 → **internal-QA phase 起**:`sessionRole:"qa"` 挂**父 issueId**、**共享 B key 占 B**(Step 3),跑测 + 把 test/report commit 到 B。**不 createQaIssue**;QA record keyed 到父 implement execution/head。
  - **QA PASS → push + 关闭 QA → 放行 founder/ship**(B 最终态含 QA 的 test)。
  - **QA FAIL → QA 把 findings/test commit 到 B + push + 关闭 QA(释放 B)→ 起新 Implement-fix phase**(父 issueId、共享 B key、pin 到 B 当前 head=含 QA 的 test/findings、Model A 重起非唤旧 exec)→ Implement-fix 改完 push 关闭 → **再起 QA**(读 B 上自己上轮的 test + Implement 的修)重测。**全顺序、同时刻一个 writer、无 parked runner、无 `retest_wake` 依赖**(QA 的 test 已在 B 上,重起的 QA 直接看得到)。
  - three_stage OFF → 老 auto-QA 逐字不变(byte-compat)。
- **RED**:ON→QA 起父 issueId、占 B(共享 key)、可写 test/report 到 B;PASS→push 放行;**FAIL→QA commit findings/test 到 B + 关闭 → 起新 Implement-fix(共享 B key、pin B head)→ 再起 QA 读 B 续测**、**不向已关闭 exec 发 wake**;OFF→老 auto-QA 逐字不变。

### Step 9 — role-aware reader 审计（Codex R1 #5，NEW）
- **问题**:`session_role` 给多 session/issue,但并非所有读取 role-aware;三 session 共享一 issue 后「按 issue 取最新 session」会歧义。
- **改**:审计 + 测 role-敏感读取——thread 查找、通知路由、latest-session 查找、QA verdict 绑定、dashboard 汇总。要么改 role-aware,要么证明只需最新 phase session。
- **可见性**(#5 附):**别假设 phase 已在 thread 标题**(现 stamp = status/stage/model,无 phase label)。**显式加 phase/role 标记** 或收窄承诺。
- **RED**:每个 role-敏感读取在 3-session/issue 下不歧义;标题带 phase+model。

### Step 10 —（defer 795）progress.md seam
- 仅留 `readProgress()/writeProgress()` 最小 seam（docs-based bootstrap:Implement 读 committed plan.md 的 N-块清单),标 `TODO-795`。795 定 schema 后替换。**不在 793 定 schema。**

### Step 11 — per-session-role chat_thread：一 issue 三 thread（Annie 2026-07-03 拍 **Hybrid**;Codex A-vs-B 推荐 + slice design review 3 轮 APPROVED;实现过 Codex code review，NEW）
- **问题**:`chat_threads` `UNIQUE(issue_id, channel_id)`(`StateStore.ts:1128`)= 一 issue 一 thread。三段共享同一 issueId → 三 phase 撞进同一条 thread;也是 auto-QA 必须另开独立 issue(804)才有自己 thread 的根因。
- **方案 = Hybrid(Annie 拍 (a) / Codex A-vs-B 推荐,de-risk pure-A 的索引迁移)**:**不动**现有 `chat_threads(issue,channel)`+主索引+main 行为;**新侧表 `phase_chat_threads`** 装非-main phase thread。
  - **新表** `phase_chat_threads(issue_id, channel_id, session_role, thread_id, lead_id, created_at, archived_at, discord_missing_at)`,`UNIQUE(issue_id, channel_id, session_role)`(role ∈ design/implement/qa,`session_role NOT NULL`)。**现有 `chat_threads` DDL/索引/行 字节不变 = 零迁移风险**(reverse-compat sentinel)。
  - **resolver** `resolveChatThread(issue, channel, chatThreadRole)`:`'main'`/缺 → 现有 `chat_threads` 路径(**逐字不动**);`design/implement/qa` → `phase_chat_threads`。~15 call site 都经 resolver 传 session 的 `chat_thread_role`;**现有 caller(全 main)→ 老路径零改动**。

**⚠️ 仍跨切面(~15 处 thread 解析点),但 Hybrid 让「main 路径逐字不变」——只有三段 phase 走新侧表。下面 ②-⑦「role 进身份 / 传播 / HTTP / archive / 徽章」都作用在 phase 侧表 + resolver;main 侧不碰。**

- **① 侧表(替代 pure-A 索引改)**:`CREATE TABLE IF NOT EXISTS phase_chat_threads(...)`(fresh + 既有库都只**加表**、`DROP`/改现有索引一律不做)。`session_role NOT NULL`(避 SQLite 多-NULL 绕唯一性)。测:现有 `chat_threads` DDL/index/行字节不变;侧表三 role 各唯一;role NOT NULL 拒空。
- **② StateStore role 进身份(处处)**:`normalizeChatThreadRole(role?)→'main'` 默认;`upsertChatThread(...,role='main')` 只删同 `(issue,channel,role)`(否则建 Implement thread 会删 Design thread,`:2525`);`getChatThreadByIssue(issue,channel,role='main')` 且返回 `session_role`(`:2967`);`getChatThreadByThreadId` 返回 `session_role`;`set/get/clearChatThreadAttachPin(...,role)` 按三元组(`:3045`)。
- **③ thread-role = 三段门控 + 持久化(byte-compat 关键;Codex R2 B1)**:门控值 = `shareParentBranch ? normalize(sessionRole) : 'main'`——非三段(含现有 auto-QA `role='qa'` 在独立 issue)一律 `'main'`,与迁移后现有行(→main)对齐。**但 `shareParentBranch` 只活在 dispatch/Blueprint context,不在 EventEnvelope/sessions**,故 Session-based 路径(DirectEventSink/Heartbeat/gate-poller)拿不到 → **必须持久化**:
  - 新列 **`sessions.chat_thread_role TEXT NOT NULL DEFAULT 'main'`**,在 start 时算一次(`shareParentBranch ? normalize(session_role) : 'main'`)落库;
  - **`EventEnvelope` 在 `session_started` 带上它**(`ExecutionEventEmitter`/Blueprint envelope,`:555`),**两条 started 落库路径都持久化**(Codex R3 附注,two-sinks 教训):DirectEventSink 建 thread 立即用(`:157`)+ 落 `sessions.chat_thread_role`(`:121`),**HTTP `/events` 的 session_started handler(`event-route.ts`)同样落**——否则经 `/events` 起的 runner 该字段丢。供后续所有 Session-based 路径读。
  - 下游一律读 `session.chat_thread_role`(不再各自算门控):`ChatThreadContext.sessionRole` + `resolveChatThreadId(store,issue,channel,role)` 贯穿 ChatThreadCreator(in-flight key `issue:channel:role` + lookup/upsert `:220/234`)、DirectEventSink(`:763`)、runs-route 轮询(`:590`)、event-route 标题/pin(`:393/459`)、HeartbeatService(`:1148/1267`)、RunnerIdleWatchdog(`:391`)、bootstrap-generator(`:301`)、auto-qa-effects(`:104/348`)、gate-poller founder 通知(`:1316/1661`)+ **founder-reply 投递按 issue-thread 分组(`gate-poller.ts:1828`,用 `q.from_agent` 的 Session 的持久 role,Codex R2 #3)**、founder-consent/ux。测:三段 design/implement/qa → 三 role 行;现有非三段 `sessionRole:'qa'` → 仍 `main`。
- **④ HTTP API 契约(含 register,Codex R2 B2)**:`/api/chat-threads/{create,send,archive}` + `GET`(`tools.ts:500/800/916/958`)+ **`/api/chat-threads/register`(`validateAndRegisterChatThread`,`tools.ts:423`/`chat-thread-register.ts:189`)+ `/api/runs/start` 的 `chatThreadId` 注册分支(`runs-route.ts:450`)** 都加可选 `sessionRole`(或 `executionId`);缺省 = main(byte-compat)。`RegisterChatThreadParams` 加 role 字段。**冲突语义**:同 `(issue,channel)` 的 `thread_id` 已映射到别的 `session_role` → 拒绝,除非显式 audited 重指派。`/by-thread` 返回 `sessionRole`,别拿 `getSessionByIssue()` 当 role-敏感元数据的「那个」session。
- **⑤ archive 多-thread 政策(定 + 测)**:pipeline 期各 phase thread 保持开;**final Done 时归档该 issue/channel 的全部 role 行**(`done-thread-archiver.ts:171`、`post-ship-finalization.ts:207` 改为按 issue 收全 role 行)。`discord_missing_at` 仍按 `thread_id` 安全,但重建缺失 role thread 不得删兄弟 role 行。
- **⑥ toggle-off 强保证**:门控(③)保证 OFF/非三段 → 全走 main → 现状 1:1。测:three_stage OFF + main → 复用现有 thread;旧 DirectEventSink/ChatThreadCreator/`/send`/archive 无 role → 全中 main;three_stage ON + design/implement/qa → 三条 distinct;非-main role 且 three_stage OFF → 归一 main(门控)。
- **⑦ phase 徽章(Annie 2026-07-03 终稿 spec)**:phase thread 标题 = **`FLY-XX <徽章> — <标题>`**,徽章 = **🎨设计 / 🔨实现 / 🧪QA**(design/implement/qa)。role 徽章进 **base title**、与现有 status/model 前缀(`stage-utils.ts:61`、`ChatThreadCreator.ts:156`)解耦;测 create/backfill/stage-restamp 不抹不重(`stripStatusEmoji`/`stripModelMarker` 保 role 徽章)。**与 795 修 FLY-560 对齐**(795 改 test 🧪→🔨自测、pr_created ⏳→📬;我这边 phase 徽章跟它同套,别撞语义)。
- **红线**:toggle 默认关 = 逐字现状 + reverse-compat 迁移(现有 thread 保留)。**roundtable_topic_threads 是另一张表,本 slice 不碰**(`StateStore.ts:1131`)。

## 测试计划(RED→GREEN 摘要)

| # | 文件 | 断言 |
|---|------|------|
| 1 | `config/…/ConfigLoader.test.ts` | three_stage on/缺=off/malformed=throw-at-load;env kill;label opt-out |
| 2 | `config/…/three-stage-phases.test.ts` | canonical tier 归一 + prefer-Fable + 非法 fail-closed |
| 3 | `edge-worker/…/WorktreeManager/Blueprint` | Design/Implement/QA three_stage→都共享父 branch(QA 也是 writer);auto-QA/其它 role→role-suffixed 不变;**负测:外部 `/api/runs/start` 传 `worktreeKeyOverride` 被拒**;cleanup 两路径 |
| 4 | `teamlead/…/phase-handoff` | 捕获 headSha→关→dirty-safe 移除→起下段 pin SHA;push 缺/dirty/SHA 缺→fail-closed+告警;不误用 `removeIfExists` 丢交接 worktree |
| 5 | `teamlead/…/phase-route` + `phase-orchestrator.test.ts` | `phase_design_complete` 全 plumbing(complete/DecisionRoute/两 sink/guard/marker replay)→非终态 status;Design-完成→起 Implement;Implement `needs_review`(three_stage+implement)held-first→起 internal-QA(通知前);OFF 不起;两 surface 接 |
| 6 | `edge-worker/…/Blueprint.*.test.ts` | design/implement/qa role prompt;main role 逐字不变 |
| 7 | `teamlead/…/three-stage-qa.test.ts` | ON→QA 起父 issueId、占 B(共享 key、可写 test/report);PASS→push 放行;**FAIL→QA commit findings/test 到 B + 关闭 → 起新 Implement-fix(共享 B key、pin B head)→ 再起 QA 读 B 续测、不向已关闭 exec 发 wake**;OFF→老 auto-QA 逐字不变 |
| 8 | role-aware reader 测试 | 3-session/issue 下 thread/通知/latest/verdict/dashboard 不歧义;标题带 phase |

## 风险 / 边界

- **byte-compat**:toggle OFF → 单 session + 老 auto-QA 全链现状不变(reverse-compat sentinel 测两侧)。
- **两 completion surface** 必须都接。
- **gate 语义不变**:brainstorm/design-review 在 Design phase;approve/ship 在 QA-PASS 后;PhaseOrchestrator held-first、不泄 founder gate。
- **fail-closed**:交接任一步失败不起下段 + 告警 Lead(不静默、不丢交接 worktree)。
- **795 依赖**:progress.md 真 schema + 中途续 phase 非有损 = 795;前半用 docs+headSha bootstrap 跑通交接骨架。
- **QA 写权限(Annie 2026-07-02 拍 Q1)**:QA 给写权限、把 test/report 写进 B(她「给它比较多的权限」)——三段全顺序 writer,比 read-only 版更简、更 restart-safe。
- **7/7 revert**:改模型映射即回;编排不改。
- **部署**:纯代码 + config 键;Bridge 重启生效(Tier-3 攒批)。

## 实现注意（Codex R3 APPROVED 附注,非 blocker,implement 时守）

1. **`design_done` 是状态生态、非单纯 route 映射**:同步扩 `WORKFLOW_TRANSITIONS`(`core/src/workflow-fsm.ts:120` 现无此态)+ close/cleanup eligibility(`close-runner.ts:43`)+ active/protected worktree 查询的显式 status 枚举(`StateStore.ts:2060/2081`)。
2. **`design_done` 跨 Bridge 重启的兜底**:若 design-完成后、PhaseOrchestrator 起 Implement 前撞重启,加**启动对账**或 **Lead 可见的 stuck/repair 路径**(不必上全套 795 durable,但**不许静默 strand 一个已完成的 design phase**)。
3. **`phase_design_complete` 类型收口**:要么**刻意**扩 `DecisionRoute`、要么独立 phase-route 类型;**别让通用 DecisionLayer triage 意外产出 phase route**。
4. **override 负测覆盖两条路径**:`/api/runs/start` **和**任何 runner/event payload 试图夹带 `worktreeKeyOverride` 的路径都要拒。

## 与 795/799 对齐点（Lead relay,别各造一套）

- `progress.md` schema/位置 → 795(消费需求 exploration §8.1 已交)。
- QA→Implement fix-loop wake + 交接 → 与 795 durable 接口对齐。
- 收尾简化 → 799 同甲模型。
