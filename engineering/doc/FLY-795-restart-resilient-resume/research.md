# FLY-795 restart-resilient runner — 调研(落地代码研究)

Issue: FLY-795 (https://linear.app/geoforge3d/issue/FLY-795/stabilityresume-runner-必须-restart-resilient-重启交接后从真实进度续做不从头重来-709)
日期: 2026-07-02
基于: exploration.md(brainstorm 已锁:C 混合/甲 静默续/一 issue 三阶段/轻 progress.md 进分支/Q3 砍/793 对齐)

> 本文 = **落地代码研究**:把 exploration 锁定的设计映射到现有代码的**精确钩子**,供 plan.md 用。设计取舍见 exploration。

---

## 1. 现状代码机制(已核源码,非猜)

### 1.1 dispatch / re-dispatch 路径
- `RunDispatcher.start` / `RetryDispatcher.dispatch`(`run-dispatcher.ts`)→ `runtime.blueprint.run(...)`(**Bridge 进程内** poll loop)。`inflight` 是内存 map,重启即空。
- re-dispatch 入口 = `/api/runs/start`(Lead 手动 / auto-QA / fix-loop)。**显式 terminate** = `actions.ts:1049`(`state_transition trigger:"terminate"`)—— 709 每次「从头」的实测触发(exploration §4,73×/7天)。
- **今天:每次 dispatch/re-dispatch 都是 fresh** —— Blueprint 用从零 prompt 拉起,无视盘上进度。

### 1.2 runner prompt 组装点(读侧钩子所在)
- `Blueprint.ts:794-847`:from-scratch prompt = `Implement ${issueId}: ${issueTitle}\n\n${issueDescription}` + `systemPromptLines`(读码→TDD→PR→land)。
- **`Blueprint.ts:832-847` 已有 `## Retry Context` 段**(按 `ctx.retryContext` 追加 previousError/reasoning/reason)—— **这是注入「## Resume from progress.md」段的天然先例**(同一 systemPromptLines、同一 ctx 传递模式)。

### 1.3 worktree(reboot / 丢失重建所在)
- `WorktreeManager.createWorktree`:branch 名 = `worktreeName(mainRepoPath, issueId)` → **同 issue 恒定同 branch B**;`git worktree add -B branch startPoint`(`-B` reset stale 分支,FLY-99)。
- 推论:**同 issue 重派 = 落回同一 branch B**(带 committed progress.md);worktree 目录本身活过 reboot(在盘上),真丢失/被清 → `git worktree add` 从 branch B **重建**即拿回 progress.md。**分支/worktree 连续性 per-issue 已天然具备**(intra-issue「甲」不需 793 §7.2 的跨-sub-issue 插座)。

### 1.4 durable state 现状
- `StateStore.sessions`(`~/.flywheel/teamlead.db`):**orchestration 权威** —— status/worktree_path/branch/session_stage/heartbeat_at/decision_route。**这是 stage 唯一权威**(分层)。
- **执行游标无处存** —— 无「做到哪 phase/块/下一步」。progress.md(新增)补这块。
- `summary`/`diff_summary` 是**完成时**写(DirectEventSink,喂 digest),非 resume 输入、且 raw diff(lossy)—— 不复用作台账。

### 1.5 守护(R4 交互)
- `HeartbeatService`(FLY-172/623):Bridge 重启 re-adopt 存活 tmux runner + 心跳恢复 + `⚠️重连中`(`stage-utils.ts RECONNECTING_EMOJI`)stamp/clear。
- `crash-reaper`(FLY-720):默认 ON 但**生产 0 触发**(exploration §4 坐实)—— 不影响本设计。
- `RunnerIdleWatchdog` + `StuckRunnerDetector`:reconnecting 时被 `isReconnecting()` 抑制(FLY-623 §3.5)。

### 1.6 badge(Annie 校正落点)
- `stage-utils.ts`:`STAGE_EMOJI`(`test:"🧪"`,`pr_created:"⏳"`)+ `STAGE_WORD`(`test:"QA"`,`pr_created:"待批"`,`approve:"待批"`)。修点:test 🧪/QA→🔨/自测;pr_created ⏳/待批→📬/PR已开(与 approve 拆开)。`ALL_STATUS_EMOJI`/`EMOJI_TO_WORDS` 的 strip 需同步(reverse-compat)。

---

## 2. 三个落地钩子(v1)

### 钩子 A — 写 progress.md(runner 侧)
- **schema(轻)**:结构化头(`phase` 引用 Bridge stage / `phase_cursor` / N-块状态 `todo|doing|done|qa-pass|qa-fail` / `next_step` / `doc_pointers`)+ 极简正文(交接边界 payload,793 ③)。**rationale 不写**(在 committed plan/exploration)。
- **落法**:`flywheel-comm progress`(新子命令)—— 写 `<dept>/doc/<ISSUE>-<slug>/progress.md` + `git add/commit` 到 branch B(原子、仅 active phase 单写)。Runner 每有意义步调用。schema 由命令固化 → 793 可靠 READ。
- **prompt 纪律**:Blueprint systemPromptLines 加一条「每完成一个有意义步,用 flywheel-comm progress 更新 progress.md 并 commit」。

### 钩子 B — 读 progress.md 续(Blueprint 侧,读侧)
- Blueprint.run 组装 prompt 前:探 branch B worktree 有无 `progress.md`(且非首个 execution)。有 → 注入 **`## Resume from progress.md`** 段(位置/模式镜像 `Blueprint.ts:832` retryContext 段):
  - 「本 issue 已有前序进度。**读 `<path>/progress.md` 拿游标(phase/块/下一步/指针)+ 读 committed plan.md/exploration.md 拿 approach/决定,从游标续做 —— 不要重跑 explore/research/plan**。」
  - 把默认「Implement … from scratch」框架**降级为续做框架**。
- **byte-compat**:无 progress.md(全新 issue)→ 不注入,行为 = 现状。

### 钩子 C — worktree 连续性(dispatch 侧)
- 同 issue 重派已落同 branch B(§1.3)。补:dispatch/worktree 创建时,若 branch B 存在但 worktree 缺 → 从 branch B 重建(`git worktree add` 已支持);progress.md 随分支回来。**reboot 语义**:Bridge 重启=原地续(worktree 在);reboot/清理=从分支 B 重建。

---

## 3. 793 接口对齐(R1-R4)+ 799
- **R1**(intra-issue 简化):同 issue 三阶段共用 branch B + 单 writer(仅 active phase)+ 交接原子(progress.md commit)。793 dispatch 契约不改。
- **R2** = progress.md(非有损)= 本 issue 正题。
- **R3**:file-based(读 progress.md)先行;同会话原地续 = B roadmap。
- **R4**:resumed = 一个正常新 execution,守护正常对待;续做窗口 thread 显示 `⚠️重连中`(复用 FLY-623 stamp/clear)。
- **接口**:progress.md schema = 793 + 795 共用**一套**(793 提的 ①-⑤),命令/文件同一处;**跟 793 runner 定稿前不各造**。
- **799**:v1 零消费;`ShipResumeSubstrate` 接口 v2 留位(不实现)。

---

## 4. 风险 / 边界(喂 plan 的约束)
- **单 writer**:同一时刻只 active phase runner 写 progress.md(避免并发写分支)。
- **原子 commit**:progress.md 写+commit 作一步,失败不半写。
- **byte-compat 默认**:无 progress.md = 现状;env kill-switch(如 `FLYWHEEL_PROGRESS_RESUME`)默认 ON、`=0` 回退纯 fresh。
- **badge 修**:reverse-compat 单测(strip 旧/新前缀都还原;emoji-only 模式)。
- **不做**:B 无损原生 resume(roadmap);跨-sub-issue(甲 不拆);raw-diff 台账(lossy)。

---

## 5. 结论(进 plan.md)
三钩子(写/读/worktree)+ 一套轻 progress.md schema + badge 小修,全部有现成先例钩子(retryContext 段 / WorktreeManager branch 派生 / stage-utils)。低风险、byte-compat 默认、排 793 后、接口跟 793 对齐。plan.md 定实现步骤 + TDD 测试 + 文件清单。
