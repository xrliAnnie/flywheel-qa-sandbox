# FLY-795 restart-resilient runner — 探索(durable / 可交接执行状态地基)

Issue: FLY-795 (https://linear.app/geoforge3d/issue/FLY-795/stabilityresume-runner-必须-restart-resilient-重启交接后从真实进度续做不从头重来-709)
日期: 2026-07-02
基于: 无

> ✅ 状态:**brainstorm 已锁定**(Annie 三项全拍 + BRAINSTORM GATE 确认全对)→ research.md/plan.md 已写 →
> **Codex design review APPROVED(4 轮 xhigh)** → 已报 Lead 给 Annie 看。**实现排 793 之后**、接口跟 793 对齐、plan-first、不自 ship。
> 本文档 = 现状机制(查证)+ 铁证 + 设计空间 + 取舍 + 锁定决定 + 状态模型;可执行计划见 plan.md。

---

## 1. 现象与目标(来自 issue)

- **现象(Annie)**:从 7-01 起很多东西反反复复做无数遍、永远做不完。典型 = FLY-709 从 7-01 早跑到现在还没完。
  **每次全量重启,在跑的 runner 就从头重做** —— 纯浪费时间 + token。而且**最近修了某东西之后反而更严重(回归)**。
- **目标**:runner 必须 **restart-resilient** —— 重启 / 交接后从**真实进度**续做、不从头。
  这是「可信后台」的地基,一套地基三处复用(重启 resume / FLY-752 fix-loop / FLY-793 跨 agent 交接)。

---

## 2. 现状机制(已查证,非猜测)

### 2.1 runner 是什么、durable 的到底是什么
- runner = 一个 `claude` / `codex`(将来 agy / kimi)进程,跑在一个 **detached tmux window** 里,
  由 `Blueprint.run(...)`(在 **Bridge 进程内**)用**从零构建的 prompt**(读 Linear issue)拉起。
  入口:`RunDispatcher.start` / `RetryDispatcher.dispatch` → `blueprint.run` → `TmuxAdapter.waitForCompletion`(in-process poll loop)。
- **在盘上 durable 的**:
  - **worktree(代码)** —— `~/Dev/flywheel-FLY-<n>`,重启 / reboot 都不丢。
  - **StateStore `sessions` 行**(`~/.flywheel/teamlead.db`):`issue / worktree_path / branch / status /
    decision_route / decision_reasoning / summary / diff_summary / commit_messages / changed_file_paths /
    session_params / heartbeat_at / adapter_type / runner_model`。
  - **流水线 stage**(via `flywheel-comm stage set` → `session_events`):粗粒度(onboard/brainstorm/plan/implement/…)。
- **不 durable 的(关键缺口)**:runner 的**执行上下文** —— 「做到哪、脑子里在想什么、下一步是什么、
  试过哪些死路、关键决定」。这些只活在**进程的会话内存**里,进程一死就没。
  `sessions.summary` / `diff_summary` 是**完成时**由 `DirectEventSink` 写的(喂 digest / 报告用),
  **不是** resume 输入;而且是 raw diff(lossy,见 §4)。

### 2.2 各种「重启」场景的真实行为(逐个查证)

| 场景 | tmux window | runner 进程 | 续做? |
|------|-------------|-------------|--------|
| **Bridge-only 重启**(self-ship deploy) | 存活(detached) | 存活、继续干 | ✅ 进程没死就继续;FLY-623 re-adopt 监控(心跳恢复、状态不冻)。**但 `wait_for_idle` 默认等 sessions_count==0 才停 Bridge,`--force` / reboot 绕过** |
| **机器 reboot** | **死光** | **死光** | ❌ autostart(`flywheel-cmux-autostart.sh`)只起 cmux watcher,**不 re-dispatch 任何 runner**。in-flight runner 直接消失,靠 Lead 事后**从头**重派 |
| **crash-reaper 清理**(FLY-720,6-30 merged) | dead-pin | 已死 | ❌ 探测到 dead → teardown + terminated + archive → 之后被**从头**重派 |
| **retry 路径**(`RetryDispatcher`) | 新建 | **fresh** | ❌ 只带 `retryContext`(previousError / reasoning / attempt),**没有真实进度** |

**结论**:除了「Bridge-only 重启且进程恰好存活」这一种,其余所有路径的「续做」都是**重起一个 fresh runner、
从头读 issue、重跑 explore/research/plan**。`RunDispatcher.inflight` 是**进程内内存 map**,重启即空,
没有任何东西按「durable 进度」把它重新拉起(FLY-245 的 launch-claim / commit 只是 Codex-Lead gateway 的
exactly-once 去重,不是进度 resume)。

### 2.3 唯一存在的「resume」不是给主 runner 的
`ChatSessionHandler` 有 `--continue` resume,但那是 **CHAT session**(Lead 在 Linear/chat thread 里的对话),
**不是** DAG 主 runner。主 runner(`TmuxAdapter`)每次都是 fresh spawn,不带 `--resume`。

---

## 3. 铁证 — FLY-709(live teamlead.db 查出)

FLY-709 两天里被 **6 个不同 execution_id** 跑过,**全部共享同一 worktree** `~/Dev/flywheel-FLY-709`:

| execution | 起 | 止 | 终态 | route |
|-----------|----|----|------|-------|
| 2686811f | 07-01 05:49 | 07-01 20:28 | terminated | needs_review |
| e615b335 | 07-01 23:30 | 07-02 03:46 | terminated | needs_review |
| cfbc86df | 07-02 04:45 | 07-02 04:46 | terminated | (无) |
| 4c204d04 | 07-02 05:29 | 07-02 15:04 | terminated | needs_review |
| 57915b7a | 07-02 15:04 | 07-02 16:51 | terminated | needs_review |
| 8e00a71b | 07-02 16:52 | (进行中) | awaiting_review | needs_review |

**读法**:每个 execution 都是**全新的 runner**(新 execution_id),`session_started`(direct-event-sink)→
若干 `stage_changed` → `session_completed` 到 `needs_review`(即跑到了 PR/review)→ 之后被 `terminated`
(fsm `state_transition`)→ 立刻又一个**从头**的新 runner。**代码进度在盘上完整保留,但每个新 runner
无视它、重头再来**。这就是「永远做不完 + 纯浪费 token」的本质。

**churn 不止 709**:一批 FLY-7xx(709 / 766 / 758 / 756 / 535)都在 7-01/7-02 各 ~6 次 execution
(和 Annie「从昨天起」吻合)。历史上 GEO-257 曾 18 次 —— 说明这是**结构性缺陷**,不是偶发。

---

## 4. 回归 / churn 机制(已进一步查证 session_events,修正初始假设)

Annie:「最近修了某东西之后反而更严重」。查 FLY-709 的 `session_events` 后,**修正**如下(诚实):

- **709 的跨-execution 终结不是 crash-reaper**,而是**显式 `terminate` action**
  (`state_transition {from:awaiting_review, to:terminated, trigger:"terminate"}`,由 `actions.ts:1049`
  的 founder/Lead reserved `terminate` 发出)→ 之后一个**全新 execution** 被 `/api/runs/start` **fresh 重派**。
  即结构性机制 = **「parked review runner 被显式 terminate + 从头重派新 runner」**(每轮 QA / redesign 一次)。
- **代码在积累,思考在重来**:同一 worktree 里 commit 数跨 execution 递增(2686811f 14 commits/39 files →
  8e00a71b 29 commits/54 files),但每个新 runner 仍从头读 issue + 重跑 explore/research/plan、重新定向。
  **浪费在重复的探索/定向**(以及 fresh runner 不懂已积累状态、容易反复)。
- **同一 execution 内的 fix-loop 是能续的**:2686811f 一个 execution 内多次 completed(收反馈接着做,commit 递增)。
  → 缺的是**跨 execution 边界**(重启 / 显式 terminate / reboot / 换 agent)的续做。

**回归 verdict(已日志坐实,非猜)**:
- **crash-reaper(FLY-720)排除**:代码里 `FLYWHEEL_CRASH_REAPER` **默认 ON**,但生产 teamlead.db 里
  `trigger:"crash_reap"` 触发 **0 次**、`last_error LIKE '%reaped%'/'%Crashed (process dead%'` **0 条**
  → enabled 但从没走到 dead_pin reap 路径,**不是元凶**。
- **churn 的真实 driver = 显式 `terminate`**:近 7 天 `state_transition` trigger 统计 —— `terminate` **73 次**
  (最多)、`fly638_close_runner_done` 60、`orphan_reap` 7。709 的每次「从头」= parked review runner 被
  显式 terminate + 一个 fresh execution 重派。
- **所以「修了某东西更严重」不是单一坏 commit**:是 terminate→fresh 这条路**一直没 durable resume**,
  而近期 auto-QA(FLY-579)+ fix-loop(FLY-752)+ 密集 ship 让「重测 → 重派」频率飙升,**把一直存在的浪费放大**。
- **结论不依赖锁定单一 commit**:根因 = **跨 execution 没有 durable 续做** —— 地基修好后,任何触发都从进度续、不从头。

> **回归止血可以先落地**:让「显式 terminate / 重测 / 重启」后的重派**读进度续做**,而非 fresh(见 §6 Q3)。

---

## 5. 设计空间(把选项摆开 + 取舍,不预设答案)

### 轴 A:durable 执行状态**是什么形态**?

- **A1 — 原生会话 resume**(`claude --resume <session>` / `codex resume`):持久化 runner 真实会话 id,
  重启后带原会话拉起 → **无损**恢复完整上下文。
  - ✅ 真·续着做,零信息损失。
  - ❌ **vendor 特定**(claude/codex 各一套;**agy/kimi 无 resume**);会话文件本地 + 可能巨大;
    **reboot 可能丢**;**无法跨 agent 交接**(claude 会话喂不了 codex QA)→ **服务不了 FLY-793**。

- **A2 — 结构化进度台账**(agent-agnostic,盘上一个文件,放 worktree 内):runner 维护一份干净的
  「state-of-work」(当前 stage / 已完成清单 / 下一步 / 关键决定 / PR·branch / 待解问题)。
  resume / 交接 / fix-loop 时,**新 runner 读它 + 读自己盘上的代码与 doc,接着做**。
  - ✅ **agent 无关**(claude/codex/agy/kimi 通用);活过 reboot;**人类可读**;**三处复用同一份**
    (重启 resume + 跨 agent 交接 FLY-793 + fix-loop FLY-752)。
  - ❌ 是「**温续**」(重新定向、读自己的笔记)不是逐字无损;依赖 runner 有纪律地保持它新鲜。

- **A3 — 混合**:同 agent + 同机 + 会话在 → 走 A1 无损快路;reboot / 跨 agent / no-transport → 落回 A2 台账。
  - ✅ 覆盖最全。 ❌ 两套机制、复杂度高。

- **A4 — doc-flow 原生**:full 档已有 exploration/research/plan.md,只加一个轻「进度标记」。
  - ✅ 复用现成、full 档零新状态。 ❌ doc-flow 是**可选**(none/plan_only 档没有);不覆盖 implement 中途;不是每个项目开。

> **本 runner 的初步倾向(供讨论,非定论)**:**A2 为主**(必要),因为**三处复用**里的
> reboot / 跨 agent 交接 / no-transport agent **都只能用 agent-agnostic 形态**,A1 服务不了它们。
> A1 可作为**后续**的无损快路叠加(→ A3)。但**这正是要问 Annie 的第一个方向问题**(§6 Q1)。

### 轴 A 的具体物理形态(答 Annie「台账是什么、记在哪」,待她 OK)
- **① 存成什么**:**一个 markdown 文件 `progress.md`**。顶部一小块结构化头(机器可读:当前 stage / 下一步 /
  PR·分支)+ 正文散文(人+agent 读:已锁关键决定 / 试过的死路 / 待解问题)。**md 不 json** —— 丢的正是
  「想法/为什么/试过啥」这类散文,json 硬结构会再丢一遍;一小块头覆盖机器字段足矣。
- **② 记在哪**:**commit 到分支 B、issue doc 文件夹** `engineering/doc/FLY-XXX-<slug>/progress.md`。**不是 DB**:
  放分支上 = 重启/reboot 不丢(磁盘 + git 历史)+ 天然跟分支走(交接时下段 agent checkout 分支 B 直接读)+
  任何 vendor 只是读文件。Bridge DB 继续管调度索引(issue/worktree/分支/status)+ 顶多一个指针,**runner 执行
  上下文不塞 DB**(DB 给 Bridge 看,不给续做的 runner 读)。
- **③ 跟 793 统一**:**同分支、同 doc 文件夹、同 commit-to-branch 模式**(793 已把 exploration/research/plan
  提交到分支)。`progress.md` = 那文件夹里多放的一个文件。分工:doc-flow 文档 = 「做什么/为什么/计划」;
  `progress.md` = 「现在到哪/下一步/试过啥」。**一套系统一个地方**;793 的 file-based 交接顺带读它。
- **取舍(诚实)**:放分支 = runner 要定期 commit `progress.md`(纪律)+ 出现在 PR 分支。视为好事(可审计);
  若不想进最终 PR diff,可当 doc-flow 过程文档处理(Annie 拍;Lead 倾向留 doc 文件夹当工作记录)。

**✅ 分层钉死(Annie 拍「甲」+ Lead 架构原则,2026-07-02)**:
- **管线结构 = 一个 issue、三个内部阶段(Design/Implement/QA)、Bridge dispatch 契约不改、不拆 sub-issue**。
  → `progress.md` = **一个 issue 内部三阶段的接力载体**(intra-issue,不是跨 sub-issue)。R1 因此简化(见 §7.1)。
- **职责分层、别重合**:**Bridge status(StateStore)= stage / 调度的唯一权威**;**`progress.md` = 执行内容**
  (想法 / 已锁决定 / 死路 / 下一步细节 / 待解问题)。**唯一小重叠 = stage** → **Bridge 权威**,`progress.md`
  **只引用 stage、不复制为真相源**(所以 §① 头里的 stage 是「引用 Bridge 的」,不是自立门户)。
- 793 / 799 按「甲」对齐(同一 issue 三内部阶段模型)。

### 轴 A 的 schema 草图(纳入 793 消费需求 + Q4 富台账,Lead 转 793 需求 2026-07-02)
> **799 v1 对 progress.md 零消费**(StateStore 自足);v2 才经 `ShipResumeSubstrate` 接口 → **v1 schema 只纳入 793 + restart-resume**。
> 模型/phase 映射**在 config、不进 progress.md**(793 ⑥)。最终 schema 在 plan.md 定死;此为草图。

`progress.md`(分支 B、issue doc 文件夹)结构:
- **头(结构化,机器可读)**:`issue` / `branch(B)` / `phase`(**引用** Bridge stage 权威:design·implement·qa,不复制)/
  `phase_cursor`(phase 内第几块/子步)【793 ①】/ `artifacts`{doc 路径 on B、PR 号、reviewed sha}【793 ④】。
- **N-块计划(结构化 list)**【793 ②】:每块 = {id, 顺序, 依赖, done判据, 状态∈todo/doing/done/qa-pass/qa-fail}。
- **交接边界 payload**【793 ③】:design→impl{设计摘要+docs指针+块计划} / impl→qa{PR+commit+各块状态} /
  qa→impl{findings+失败块} / 回退→design{原因}。
- **✅ 轻台账(Q4 定):只记「做到哪」游标 + 下一步 + 指针** —— `next_step`(下一步具体动作)+
  `doc_pointers`(指向已 commit 的 `plan.md`/`exploration.md`/`research.md`,rationale 在那,**不在 progress.md 重复**)。
  resumed runner = 读 `plan.md` 拿 approach/决定 + 读 `progress.md` 拿游标 → 不重复不 re-derive。
- **写入纪律**【793 ⑤】:**仅 active phase 单写** / **每有意义步 commit** / **提交到分支 B(durable 真源)**。

→ 一套**轻** schema 同时满足 793 三阶段交接(①-⑤)+ restart-resume 续做;rationale 复用 doc-flow committed 文档;**不搞两套、不重复**。

### 轴 A 的状态模型 + 三层对应(Annie 要精确,已核 FSM 代码;2026-07-02)
**3 层状态是嵌套、不是并排**(+ Runner 物理正交层):

1. **Bridge status(唯一权威 · issue 生命周期 · 粗)** —— `workflow-fsm.ts` 实测合法流转:
   `pending→running→{awaiting_review|completed|blocked|failed|terminated}`;
   `awaiting_review→{approved_to_ship|completed|rejected|deferred|shelved|terminated}`;
   `approved_to_ship→{completed|blocked|failed|terminated}`;终态 completed/shelved/terminated。
   **不知道三个内部阶段** —— 只说 issue 整体在跑/等评审/待 ship/完事。
2. **phase(progress.md,引用 Bridge,中)** = Design / Implement / QA(第三阶段=QA)。
3. **chunk(progress.md,795 新增,细)** = N 块,每块 `todo→doing→done→(QA)qa-pass|qa-fail`。
4. **Runner 物理(正交)** = alive-tmux / parked-gate / dead(reboot/crash/terminate)。

**对应(核心)**:三个 phase **全嵌在 Bridge `running` 里循环**;Bridge status 只在跨「等外部输入」边界才变粗状态:
- `running`+design/implement/qa = 各阶段进行(块 todo→doing→done→qa-pass/qa-fail)
- implement 完开 PR → `awaiting_review`;某块 qa-fail → 回 `running`+phase 退 implement
- 全 qa-pass + founder 批 → `approved_to_ship`→ship→`completed`
- 显式 terminate/崩溃/reboot → Bridge 停在 running/awaiting_review/approved,Runner 物理=dead

> **一句话**:Bridge status=issue 整体到哪(粗);phase=三阶段哪段;chunk=那段第几块到啥程度(细)。三层嵌套不重合。
> **795 续做开关** = 「**Runner 物理=dead 且 Bridge status 非终态(running/awaiting_review/approved)**」→ 新 runner 读
> `progress.md` 知 phase+块+决定+死路 → 从那续。今天缺 `progress.md` → 新 runner 只见粗粒度 running+issue 原文 → 从头重跑 = 709 病根。

**Discord thread 前缀 = Bridge status + stage 的投影(派生视图,非第四层状态)**。**Bridge StateStore 权威、Discord 只渲染**(呼应分层)。
现状 `stage-utils.ts`(FLY-560)+ **Annie 校正后的目标命名**:
| stage | 现状 badge | Annie 校正后 | 原因 |
|---|---|---|---|
| onboard/brainstorm/research/plan | 🧠规划 | 🧠规划(不变) | |
| design_review | 👀设计审 | 👀设计审(不变) | |
| implement | 🔨实现中 | 🔨实现中(不变) | |
| **test** | **🧪QA** | **🔨自测**(并进实现家族) | 🧪 与「独立 QA 阶段」混淆,让人以为独立 QA 在跑 |
| code_review | 👀代码审 | 👀代码审(不变) | |
| **pr_created** | **⏳待批** | **📬PR已开**(与 approve 分开) | 「待批」听着像等 founder 批准,其实只是 PR 开好等 review |
| approve | ⏳待批 | ⏳待批(保留 = 真·等 founder 批) | |
| ship | 🚀ship | 🚀ship(不变) | |
| completed | ✅完成 | ✅完成(不变) | |
| (真·独立 QA 阶段) | — | **🧪QA(专属)** | 🧪 只留给真正 QA 阶段 |

跨切叠加:🔴受阻(`BLOCKED_EMOJI`,blocked)· **⚠️重连中(`RECONNECTING_EMOJI`,FLY-623)= 795 续做/交接的可见信号**。

- **795 设计要点**:续做/交接中复用 FLY-623 的 `⚠️重连中` stamp、续上(事件通道证明活)后 clear/flip 回真实 badge —— 让
  「重启无感自动续」在 thread 上也诚实可见(不再是冻住的 🔨实现中)。
- **落地任务(Annie 要,✅ Lead 确认搭 795 落地 + reverse-compat 单测,不单开 follow-up)**:修真实 `stage-utils.ts`
  FLY-560 mapping —— `test` 的 `STAGE_EMOJI`(🧪→🔨)+ `STAGE_WORD`(QA→自测);`pr_created` 的 `STAGE_WORD`(待批→PR已开)+
  `STAGE_EMOJI`(⏳→📬),与 `approve` 拆开(参照 design-review/code-review 共 emoji 分词先例);🧪 只留给真·独立 QA。
  改动极小、与 795『thread 诚实可见』同源 → 作为 795 实现的一部分,附 reverse-compat 单测。已改进 v2 状态图(Lead re-publish)。

### 轴 B:**什么时候 / 谁**触发续做?
- B1 — 进程还活着(Bridge-only 重启):**别 force-kill**,让它继续(FLY-623 已 re-adopt 监控)。
- B2 — 进程死了(reboot/reap):**自动**带 resume-context 重派(读台账/会话) —— 需要轴 A 的地基。
- B3 — 先**上浮给 Lead/founder** 确认再续(信任/控制取舍)。

### 轴 C:**重启时别把 parked runner 干掉**
awaiting_review / 卡在 founder gate 的 runner 是否该在 fleet 重启中**存活**?709 铁证显示它们被 terminate+重派。
止血的一部分 = (a) 重启别 terminate parked runner;(b) 真丢了(reboot)才从 durable 状态续,而非 fresh。

---

## 6. 开放问题 + 决定(brainstorm 进行中)

> Lead 指令:brainstorm 阶段把架构开放问题**一个个**抛给 Annie(经 Lead relay),等她拍方向再往下。
> **Annie 2026-07-02:「你就去做吧」= 授权推进。**

### 已决定
- **前提 / 关系(答 Annie)**:795 是 **793 的地基**(强依赖:三段 agent 交接靠它把执行状态跨 agent 传下去);
  跟 **799 独立**(799 = ship 端重构,互不依赖)。795 = 709 永远做不完的直接根因、全队的税(铁证 §3)。
- **✅ Q1(续做无损度)= C 混合(Tadashi 架构拍板)**:**v1 先做 A2 温续台账**(轻量进度快照、马上落、
  止血 709/751 churn);**A1 无损原生 resume 作 roadmap 随后**。与本 runner rec(A-first)一致 + 符合 Annie 止血优先。
- **排序 / 接口约束(Lead)**:**实现排 793 之后**;durable 状态**接口要跟 793 runner 对齐**(设计/实现/QA 三段
  交接与重启 resume 共用同一份台账,**别各造一套**)。

- **✅ Q2(行为 / 信任)= 甲 静默自动续(Annie 拍)**:重启后 in-flight runner 直接从盘上进度续、对她**无感**;
  **只有续不干净**(进度快照缺/对不上)才上浮问她。**红线不动**:ship-gate / 等 founder 批准的永远 gated、绝不自动 ship。

### ✅ 末轮已决定(Annie 拍板,brainstorm 锁定 2026-07-02)
- **✅ Q3 = 砍**:重启/terminate 后的重派**读进度台账续做、不 fresh**(直击 #1 driver = 显式 terminate→fresh 73×/7天)。
- **✅ Q4 = 轻台账**:`progress.md` **只记『做到哪』游标**(phase + phase_cursor + N-块状态 + 下一步 + 产物指针);
  **设计 rationale(决定/为什么/取舍)靠已 commit 的 plan/exploration 文档承载,不在 progress.md 重复**。
  (推翻本 runner 原「富台账」rec —— Annie 选轻,更干净:doc-flow 已把 rationale committed 到同一分支,resumed runner
  读 plan.md 拿 approach + 读 progress.md 拿游标,不重复也不 re-derive。同时正好贴合 793 的 ①-④ 需求。)
- **✅ progress.md 进 PR / 提交到分支 B** = **durable 真源**。worktree 丢了 → 从分支 checkout 重建 worktree + 读 progress.md 续。
- **✅ worktree 语义**:**Bridge 重启 = 原地续**(worktree+进程在盘上/被 re-adopt);**reboot / worktree 丢 = 从分支 B 重建 worktree 再续**。

---

## 7. 三处复用 = 同一地基(已查证关系)

| 场景 | runner **活着**时 | runner **死了/换 agent**时(← 本地基补的) |
|------|------------------|------------------------------------------|
| **FLY-752 fix-loop**(已落第一版) | `retest_wake` / `feedbackWakeMain` 唤醒 parked runner | 目前 = fresh re-spawn 同 issue → **应改为从进度续** |
| **FLY-795 重启 resume**(本 issue) | FLY-623 re-adopt(进程还在就继续) | 目前 = fresh 重派 → **从 durable 进度续** |
| **FLY-793 跨 agent 交接**(exec 9826ae47 在跑) | n/a | 下一 agent/stage 从上一段 durable 状态接 |

**结论**:FLY-752 已有的是「**活着就 wake**」这半边;三处共同缺的、也是本地基要提供的,是
「**死了 / 换 agent 就从盘上 durable 执行状态续做**」这半边。**别三处各造一套** —— 一份 agent-agnostic
进度台账(§5 轴 A2)同时喂这三条路。

### 7.1 与 FLY-793 的接口对齐(R1–R4,Lead 明确要求「别各造一套」)
793 runner(exec 9826ae47)已在其 exploration §7/§8 **先定接口、把深交接实现挂给 795**。795 设计必须落这四条:
- **R1 单分支阶段延续(Annie「甲」后简化 = intra-issue)**:一个 issue 三内部阶段**共用同一 worktree/分支**,
  阶段间接力(Design→Implement→QA)。**不拆 sub-issue** → 无跨 sub-issue 的 worktree 归属转移。795 只需保证
  「**同一时刻单 writer + 阶段/重起交接原子**」(比原「跨 sub-issue 派生+归属传递」简单一档)。793 dispatch 契约不改。
- **R2 干净进度快照(非有损)** = **本 issue 正题 = A2 台账**。Design→Implement 的意图交接已由 doc-flow
  (exploration/research/plan commit 到分支)满足;795 补的是**code + 执行进度也非有损**(不是 raw diff / 有损 summary)。
- **R3 跨 sub-issue 续修**:file-based 重起先行(与 A2 一致)→ 同会话原地续作 roadmap(= 与 Q1=C 的 A-first/B-later 完全一致)。
- **R4 与守护交互**:交接 / 重起的 runner **不被 idle-watchdog / reconciler / reaper 误杀**
  (触及 FLY-623 re-adopt、FLY-720 reaper、RunnerIdleWatchdog;FLY-752 已趟一版)。**resumed runner 必须被识别为合法**。

→ **一份台账(R2)+ 一套 worktree/分支阶段交接契约(R1)+ 守护识别(R4)** 同时服务「重启 resume」和「793 三阶段交接」。

**schema 收口(Lead 确认 2026-07-02)**:定 `progress.md` schema 时**纳入 793(其消费需求会由 Lead 转来)+ 799 的需求,一套 schema 别两套**。
stage 字段确认只**引用** Bridge StateStore(唯一权威、Discord 派生),`progress.md` 不复制 stage 为真相源。
→ **依赖项**:写 plan/schema 前需拿到 793 的 progress.md 消费需求(Lead relay)。

## 8. 关联
- **FLY-8**(2026-03 老 Session Resume spike)—— 本 issue 承接 + 扩到当前 P0。
- **FLY-709**(最惨受害者)—— 修好后用它验。
- **task #73**(sessions 存 clean prose summary 而非 raw diff)—— 与轴 A2/§4 直接相关,可能并入。
