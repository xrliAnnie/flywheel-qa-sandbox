# FLY-907 thread 显示批次:状态随真实状态刷新 — 探索

Issue: FLY-907 (https://linear.app/geoforge3d/issue/FLY-907/uxdisplay-thread-显示批次-状态行标题随真实状态刷新parkwakekillresetfinalize-全触发-绿标)
日期: 2026-07-06
基于: 无

## 1. 问题

Annie 2026-07-06 一天内多次撞到同一族显示 bug:

1. `[FLY-XX]` thread 标题前缀不随真实状态更新(QA 了还显示 🔨实现/🎨设计)。
2. 置顶三段状态行/pipeline header stale(QA PASS 了还显示「进行中」;ship 全部完成后仍显示 parked/进行中,**永不自愈**)。
3. (折入 FLY-924) kill/terminate/operator-reset/重授 turn 后状态块不刷新;tmux attach 链接串到别的 issue 的窗口(FLY-543 现场:QA 的链接错接到 `cmux-FLY-921-...`)。

根因(FLY-902 E2E Finding #4 已实锤):显示只在 `stage_changed` 事件时刷新,FLY-887 的 park/wake 保活生命周期不发 `stage_changed`,把缺口从「很快过去」放大成「持续可见、ship 完不自愈」。

## 2. 代码审计(现状)

### 2.1 三个显示面

| 面 | 渲染代码 | 数据来源 | 现有触发点 |
|---|---|---|---|
| **A. thread 标题前缀** | `event-route.ts::stampStageEmojiForSession` → `ChatThreadCreator.stampStageEmoji`(coalesce-to-latest 写入器) | **上报 session** 的 `chat_thread_role`(三段→phase badge 🎨/🔨/🧪)或 stage(单 session→FLY-560 badge) | 仅 `stage_changed`(event-route.ts:1811);auto-qa-effects 有一处镜像 |
| **B. 置顶 pipeline header**(FLY-892) | `event-route.ts::pinRunnerAttachForSession` → `buildPipelineHeaderContent` | `getLatestPhaseSessionsForIssue`(per-role 最新 session)+ CommDB tmux target(attach 命令) | 仅 `stage_changed`(event-route.ts:1821,且需 `issueAttachPinEnabled`) |
| **C. 三段状态行**(FLY-887) | `plugin.ts:4055 refreshPhaseStatusLineEffect` → `computePhaseLineStates` + `renderPhaseStatusLine` | `getPhaseSessionsForIssue`(全量 phase sessions 的 `status` 字段) | phase-orchestrator 三处边界(580/701/706)+ post-ship finalization(可选参数) |

三个面**数据派生已经基本是状态驱动**(B、C 直接读 DB),问题集中在**触发面不全**和**词汇/终态缺口**。

### 2.2 触发面缺口清单(生命周期节点 × 是否刷新)

所有 session status 变更统一走 `applyTransition()`(applyTransition.ts:26,注释明言 "Unified entry point for ALL status changes")。但它**不触发任何显示刷新**。逐节点:

| 生命周期节点 | status/state 变化 | A 标题 | B header | C 状态行 |
|---|---|---|---|---|
| stage_changed | session_stage(metadata) | ✅ | ✅(flag on) | ❌ |
| park(887 保活) | CommDB declared-state(status 不变) | ❌ | ❌ | ✅(orchestrator 边界顺带) |
| wake(fix/retest) | CommDB(status 不变) | ❌ | ❌ | ✅(同上) |
| qa_result(三段 verdict) | 走 orchestrator | ❌ | ❌ | ✅ |
| finalize(ship 收尾,887) | parked phases → completed | ❌ | ❌ | ✅(post-ship refresh) |
| kill/terminate(actions.ts:1326) | → failed/terminal | ❌ | ❌ | ❌ |
| retry/reject/defer/shelve(actions.ts) | → 各 terminal | ❌ | ❌ | ❌ |
| operator-reset / Lead kill+重派 | terminate+新 session | ❌ | ❌ | ❌ |
| 重授 turn(turn-belt,CommDB) | CommDB-only,Bridge 不可见 | ❌ | ❌ | ❌ |
| HeartbeatService reconcile(orphan→failed 等) | applyTransition | ❌ | ❌ | ❌ |

### 2.3 结构性终态缺口(标题永远到不了 ✅)

`stampStageEmojiForSession` 在三段 issue 上用**上报 session 的 phase badge 替换** stage badge(event-route.ts:432,`phaseThreadBadge(session.chat_thread_role)`)。后果:implement runner 上报 `stage set completed` 时,标题仍被stamp 成 🔨实现 —— **三段 issue 的标题在结构上永远显示不出 ✅完成**,即使补全触发面也不行。这不是漏触发,是"标题取上报者的 phase"这个派生公式本身对终态无解。

### 2.4 词汇/颜色(Annie UI 反馈)

- B header:`PHASE_STATUS_BADGE = {planned: "⬜ 未开始", active: "▶ 进行中", done: "✅ 完成"}`(ChatThreadCreator.ts:205)。⬜ 是白色 → Annie 明确说不用白/浅色。
- C 状态行:`🎨design(parked)·🔨implement(active)·🧪qa(pending)`(英文四态,与 B 的三态词汇是两套系统)。
- B 的 done 判定 `HEADER_DONE_STATUSES`(含 design_done/awaiting_review 排除)与 C 的 `computePhaseLineStates`(pending/active/parked/done)语义不一致:同一 phase 在两个面可能显示不同状态(如 awaiting_review 的 implement:B=▶ 进行中,C=parked)。

### 2.5 attach 链接串线(FLY-543/924)

链路:header 行 → `getTmuxTargetFromCommDb(ps.execution_id)` → CommDB `tmux_window` → `resolveCmuxAttachTarget` 读 `window_name` → `cmux-<window_name>`。窗口名约定 = `<identifier>-<runner>-<title>`(core/tmux-naming.ts::buildWindowLabel,FLY-272)。

串线的**注册侧根因**(exec-id 错位写进 CommDB)归 FLY-923/921;显示侧的责任是**防御**:渲染前校验解析出的 `window_name` 以本 issue 的 identifier 开头,不匹配则不渲染 attach 命令(降级显示,绝不给错误链接)。B 已按 per-role 最新 exec-id 取行(FLY-892 Codex R1 #4),这一半是对的。

### 2.6 依赖/协调

- **FLY-921**(High,Backlog,未动工):turn-belt 死 holder / QA 抢跑 —— 底层状态正确性归它。本 issue 只保证「显示如实反映当前 DB/CommDB 状态」,921 落地后显示自动变准。**设计上无代码依赖**(我不碰 turn-belt 内部),不阻塞。
- **FLY-905**(Urgent,三段改两段):段序 3→2。显示代码必须 **phase-sequence-agnostic**(行数/顺序从 `THREE_STAGE_PHASE_SEQUENCE` 派生,不写死 3),905 改序列时显示自动跟随,不撞车。
- **FLY-560/FLY-892/FLY-887**:已 shipped 基座,在其上加,不重开。

## 3. 方案

### 选项 1(推荐,即 Lead 指令中的「优选」):统一 refreshIssueDisplay + 事件仅作触发 + 低频自愈兜底

**核心**:抽一个 `refreshIssueDisplay(issueId)`,一次性从真实状态(sessions 表 + CommDB)重算三个面。所有生命周期节点只负责**触发**它,不各自携带渲染逻辑。

1. **派生公式修正(治 §2.3)**:标题徽章改为 **issue 级聚合派生**——三段 issue:全部 phase 终态且 shipped → ✅完成;有 blocked → 🔴;否则显示当前活跃/最靠后未完成 phase 的 badge。单 session issue:保留现行 session_stage 公式(byte-compat)。
2. **触发面 = applyTransition 钩子**:`ApplyTransitionOpts` 加可选 `onTransition(executionId, targetStatus, ctx)`,plugin.ts 组装时注入一次 → kill/terminate/retry/reject/finalize/reconcile/完成路径**全部 status 变更一网打尽**(fire-and-forget + per-issue coalesce,绝不阻塞转移)。park/wake/turn-grant 不走 applyTransition → orchestrator 的 park/wake 效果处显式加触发;`stage_changed` 现有触发保留。
3. **自愈兜底(治「永不自愈」+ Bridge 不可见的 CommDB-only 变化如重授 turn)**:GatePoller 每 N tick piggyback 一次 display-reconcile 扫描(FLY-208 巡检同款模式,零新 timer):只扫「有非终态显示记录」的 issue,重算三面。任何漏触发/进程重启丢失的刷新最终都会被扫平,ship 完终态必然收敛正确。
4. **词汇统一 + 绿标**:B/C 两面统一一套四态词汇与高可见字形:完成=✅(绿)、进行中=▶、parked/等待=按 plan 定稿、未开始=灰色系(具体字形 plan 定稿,倾向 ⚫ 或 🩶,不用白色 ⬜)。
5. **attach 防串线**:渲染 attach 命令前校验 window_name 前缀 = 本 issue identifier;不匹配 → 显示「终端待解析」降级,不渲染错误链接。
6. **快照/单测钉住**:park/wake/qa-pass/qa-fail/kill/terminate/reset/finalize/ship 终态,每个节点三个面的期望输出用快照钉死;派生函数(纯函数)全部单测。

**优点**:一处派生、处处触发,任何未来新增生命周期节点(如 905 两段)天然不漏;自愈兜底给出最终一致性硬保证。**代价**:改动横跨 applyTransition/plugin/event-route/orchestrator,需要仔细保 byte-compat(非三段路径)。

### 选项 2(最小补丁):在每个缺口节点各自补调用现有三个刷新函数

kill/terminate/park/wake/finalize 各处手工加 `stampStageEmojiForSession` + `pinRunnerAttachForSession` + `refreshPhaseStatusLine` 调用。

**缺点**:①不治 §2.3 终态结构缺口(标题还是到不了 ✅,除非另外特判);②三个函数签名/依赖各异,每个调用点都要凑 deps,散弹式;③下一个新生命周期节点(905)照样漏;④重授 turn(Bridge 不可见)无解。**不推荐**——正是 Lead 指令里说的次选。

### 选项 3(激进):显示全部改纯轮询(定时器每 30s 重算)

**缺点**:与 Flywheel「事件驱动、零新 periodic timer」的既有纪律相悖(FLY-169/172 都刻意避免新增周期负载);刷新延迟感知明显(stage 变了 30s 后标题才动)。**不推荐**;但其「从状态重算」思想被选项 1 以「事件触发 + 低频兜底」形式吸收。

## 4. 范围边界

- **做**:三个显示面的触发补全、派生公式修正(终态)、词汇/绿标、attach 防串线校验、快照/单测。
- **不做**:turn-belt/相位排序内部(FLY-921)、CommDB 注册侧 exec-id 错位根因(FLY-923)、两段式改造本身(FLY-905,只保证 sequence-agnostic)、FLY-560 重开。
- **Runner pane spinner 串扰(issue 条目 3,低优先"能一起修就修")**:初判属 tmux/cmux 渲染层,与本 issue 的 Discord 显示子系统不是同一片代码 → research 阶段确认后大概率移出 scope,在 plan 里明记。

## 5. 假设(待 Lead 确认)

1. 「重授 turn」这类 Bridge 不可见的 CommDB-only 变化,靠低频自愈 sweep 兜底(分钟级延迟)可接受,不需要为它开新的实时通道。
2. 三段 issue 标题终态公式改为 issue 级聚合(全 done+shipped → ✅完成)是 Annie 要的行为;单 session issue 标题逻辑不动。
3. 未开始的灰色字形在 plan 阶段和 Annie/Lead 定稿即可,不阻塞设计。
4. spinner 串扰按 §4 移出 scope(除非 research 发现同片代码顺手可修)。
