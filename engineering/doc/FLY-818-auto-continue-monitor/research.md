# FLY-818 auto-continue Monitor — 调研:/loop-native vs Monitor-extension

Issue: FLY-818 (https://linear.app/geoforge3d/issue/FLY-818/infraepicrobustness-系统健壮性追踪-runner-完成idle-不上报-founder-lead-status-不准)
日期: 2026-07-03
基于: exploration.md（同文件夹）

---

## 0. 这份对比要回答的问题

Annie 想**先试 /loop（runner 原生自循环)**,好用就**可能不需要自造 Monitor**。Lead 要:摆平 **/loop-native vs Monitor-extension** 两条路（可行性/复杂度/是否自造/backend 覆盖/安全网/robustness)+ 推荐,给 Annie 过目。**不直接实现。**

先给结论,再展开。

> **一句话推荐**:**采用「/loop-native 续跑 + 保留最小安全网」的混合,不自造 Bridge-side Monitor。** 具体:
> 1. **/loop-native 当续跑主力**(claude runner 用 Claude Code 自带 `/loop`+`ScheduleWakeup` self-paced;智能在模型里、代码最少、天然抗 Bridge 重启)——**正是 Annie 的首选**。
> 2. **保留现有 `StuckRunnerDetector` 当安全网**(检测「真卡住/续不动」)+ **把它的升级经 FLY-368 alert channel 可靠直达 founder**（= item A 的真正硬要求:founder 不用自己发现真 stall)。**不删 watchdog。**
> 3. **先跑一个便宜的真机 spike（Phase 0）验 /loop-native 能不能干净套 runner**(Anthropic 的「先在 1 个上验、再放大」纪律,FLY-400 C1)。spike 过 → 走 /loop-native;spike 撞硬伤 → 退回 Monitor-extension 兜底。
> 4. **非-claude backend**(codex=`/goal`、agy/kimi=无)另计:agy/kimi 是 no-transport `pr_handoff` runner、本就终态不 idle-loop,受影响小;codex 可后续用 `/goal`。Monitor-extension 是唯一 backend-agnostic 方案 → 留作「兜底 + 非 claude 覆盖」的理由。

这个推荐**同时**满足 Annie 的偏好(试 /loop、别自造 Monitor)**和** item A 的真正诉求(真 stall 可靠直达 founder),且是**最少代码**。下面论证为什么。

---

## 1. 路 A：`/loop-native`（runner 自己续跑）

### 1.1 是什么

runner 的 Claude Code session 自己跑在「自循环到 goal 完成、遇问题才停」的模式。机制候选:
- **Claude Code 自带 `/loop`（self-paced/dynamic 模式）**:runner 每个 turn 结束时用 `ScheduleWakeup` 排下一次续跑,自己决定「继续 / 停下 / 问」。
- **Codex `/goal`**（codex-backend runner,FLY-512 §1.5 有精确蓝图):thread-scoped 持久目标 + 事件驱动续跑 + 证据驱动完成。

### 1.2 可行性（已核实）

- ✅ **注入点存在**:runner 启动是 `claude [options] [prompt]`(`TmuxAdapter.ts:705-773`),`ctx.prompt`(Blueprint)+ `--append-system-prompt-file`(`ctx.appendSystemPrompt`)都能塞「自续跑」指令。
- ✅ **`/loop`+`ScheduleWakeup` 在 runner session 里可用**——**本 FLY-818 runner 自身就有这两个能力**(活证据:我这个 session 就是 Bridge 起的 claude-tmux runner,skill 列表里有 `loop`、工具里有 `ScheduleWakeup`)。
- ✅ **与 Flywheel gate 天然互操作**:brainstorm/approve gate 的 CLI **阻塞当前 turn**(`checkDynamicTimeout` 把 pending-question 期间不计入 timeout)。gate 阻塞时 turn 没结束 → 不会排续跑 → 无冲突;gate 返回后自然继续。
- ✅ **天然抗 Bridge 重启**:`ScheduleWakeup` 是 runner 自己 session 内的;Bridge 重启时 runner tmux 还活着(HeartbeatService re-adopt),它的续跑独立 fire——**比 Bridge-side Monitor 更 robust**。
- ⚠️ **需一个便宜 spike 确认**:`ScheduleWakeup` 在**无人值守的 Bridge-spawned tmux runner** 里是否可靠 fire（`/loop` self-pacing 本为交互 session 设计;runner 是交互 tmux session,理应可用,但「无人值守可靠 fire」是**唯一没被现有生产证据覆盖**的点,值得 Phase-0 花 30 分钟真机验)。
- ❌ **backend 分裂**:`/loop` 只 claude;codex 要用 `/goal`(不同机制、主仓没接);agy/kimi 两者都没有。

### 1.3 复杂度 / 是否自造

- **代码最少**:主要是**一条 bootstrap 约定**(prompt / appendSystemPrompt 注入「自续跑契约」)+ **保留现有 stuck-detector 当安全网**。**不自造续跑引擎**——续跑智能 = 模型自己 + Claude Code 自带 `/loop`。
- 对齐 FLY-400「thinnest wrapper / everything is the model」——Anthropic 自己都不自造厚 harness。

### 1.4 风险（诚实列）

- **模型可能「自信地跑错方向」**(不是 blocked,只是理解偏了)。FLY-512/400 实锤:Sonnet 把目标理解太字面("让测试过"→hardcode)、多次 compact 后原始意图变弱会忘。**安全网(stuck-detector)只抓「无进展/续不动」,抓不到「有进展但方向错」**——但这一点 **Monitor-extension 同样抓不到**(它 nudge 得更盲),且现状(人工盯)也没解决;不是 /loop 独有的退步。用**goal 契约 + 「一次续跑 turn 无 tool call 就停」(防空转,FLY-512 §1.5)**+ **gate 仍阻塞**兜。
- **`ScheduleWakeup` 无人值守可靠性未被生产证据覆盖** → Phase-0 spike 是这条路的 go/no-go 闸。
- **不覆盖非-claude backend**。
- **续跑失控烧 token** → 用 budget(`budget.total`)/ turn 上限 / gate 阻塞 兜。

---

## 2. 路 B：`Monitor-extension`（Bridge 外部检测 + 审计 nudge 续跑）

### 2.1 是什么

扩展 FLY-368 机制:`RunnerIdleWatchdog` 短阈值扫 `running` runner,`quiet_unexplained`(goal 没完+无 question+真 idle)→ Bridge 发审计 `continue` nudge(`attemptRunnerRecoveryNudge`),有界 budget + backoff,耗尽/连续 K 次 fingerprint 不变 = 真卡住 → 经 FLY-368 升级。智能在 Bridge。

### 2.2 可行性

- ✅ 全部原语已存在(idle watchdog + quiet-classifier + 审计 nudge + AutoRepairBot + AlertChannelHub)。
- ✅ **backend-agnostic**:nudge = tmux `send-keys "continue"`,对任何 tmux runner(claude/codex/agy/kimi)都行——**唯一覆盖全 backend 的方案**。
- ✅ **外部观察**:fingerprint 能同时抓「无进展」(续不动)——可界定 runaway。
- ✅ 全审计 + gate 互操作已内建(nudge gate 2/3 对 pending-review/question fail-closed)。

### 2.3 复杂度 / 是否自造

- **中等代码**:新「短-idle auto-continue」路 + budget/backoff + escalation 接线 + **要跟 in-flight FLY-368 head 协调**(基于其分支或设计成能干净合并)。
- **是第二条控制环**:Bridge 用启发式(fingerprint/budget)判「该不该续」,**比模型自己的理解更粗**——**没那么对齐「everything is the model」**。

### 2.4 风险（诚实列）

- Bridge 盲 nudge "continue":runner 可能其实做完了只是没落 terminal marker → nudge 逼它做多余活(quiet-classifier `done_but_running`/`review_signal` 缓解、但不完美)。
- 抗 Bridge 重启不如 /loop-native 优雅(Bridge-side;虽有 re-adopt)。
- 跟 FLY-368 in-flight 撞车面。

---

## 3. 正面 reconcile：Annie 的「试 /loop」 vs FLY-512 finding F

FLY-512 research（Annie 委托)finding **F 有意不做**「Runner 层加 `/goal` 式**自主续跑到 done/合并**循环」,因跟 founder-only-authority + human-gated ship 冲突。**这跟 Annie 现在要试 /loop 矛盾吗?——不矛盾,而且能对上:**

- F 反对的是「**自主续跑到 done / 自合并**」——**无人值守一路跑到把代码合了**。
- Annie 的设计是「**自续跑到下一个 gate / PR 就停**」——**gate 仍阻塞**(brainstorm/approve gate 的 CLI 阻塞 turn),ship/merge 仍 founder-gated。runner 自续跑到「开 PR + 请 review」就撞 approve gate 停下,**永远到不了自合并**。
- 所以 Annie 版的 /loop **不触碰 F 反对的那条红线**;F 真正的深层要点(要借 `/goal` 的**契约结构**:outcome / verification surface / **blocked stop condition** / iteration policy / **无 tool-call turn 就停**)**正是本推荐里 /loop-native 要落的「goal 契约」**。

**换句话说:FLY-512 已经替我们把 /loop 该怎么安全地做想清楚了**——借契约、不借「跑到合并」的自主性。Annie 的直觉和前置研究在「Annie 版 = 续到 gate 停」这个精确定义下是一致的。

---

## 4. 对比总表

| 维度 | 路 A `/loop-native` | 路 B `Monitor-extension` |
|------|--------------------|--------------------------|
| 续跑智能在哪 | **模型自己**(thin wrapper,对齐 FLY-400) | Bridge 启发式(第二控制环) |
| 是否自造续跑引擎 | **否**(用 Claude 自带 `/loop`) | 是(新短-idle 续跑路 + budget) |
| 代码量 | **低**(bootstrap 约定 + 留安全网) | 中(+ 跟 FLY-368 协调) |
| backend 覆盖 | claude only（codex=`/goal`,agy/kimi 无) | **全 backend**(tmux send-keys) |
| 抗 Bridge 重启 | **强**(session 自持) | 中(Bridge-side) |
| gate 互操作 | ✅ 天然(gate 阻塞 turn) | ✅ 已内建(nudge gate) |
| 抓「续不动/真卡住」 | 靠保留的 stuck-detector | 内建(fingerprint) |
| 抓「方向错」 | 抓不到(但 B 也抓不到,现状也没解决) | 抓不到 |
| 失控烧 token 兜底 | budget/turn 上限/gate | budget/backoff |
| 未被现有证据覆盖的风险 | `ScheduleWakeup` 无人值守可靠性(spike 验) | Bridge 盲 nudge 逼多余活 |
| 对齐 Anthropic 哲学 | ✅✅ | 一般 |
| 对齐 Annie 偏好 | ✅✅(她首选) | —— |

---

## 5. 推荐（展开)

**混合:/loop-native 续跑主力 + 保留最小安全网,不自造 Bridge Monitor。**

### 5.1 为什么不是「纯 /loop 删掉 watchdog」

item A 的**真正硬要求**是「runner **真卡住**时 founder **可靠**知道」(不绕 Lead relay)。/loop-native 让 runner 自己续跑、自己在 blocked 时停下问——但**如果模型自信地跑错、或续不动却没意识到,没有外部观察者兜底**。所以 **watchdog 不能删**,但它的角色从「续跑器/idle 报警器」缩成**纯安全网**:只在「真卡住/续不动」时经 FLY-368 **直达 founder**。这既是 item A 的核心,也是 FLY-163 要补的洞。

### 5.2 为什么不是「先建 Monitor-extension」

- Annie 明确首选 /loop、且「好用就不用自造 Monitor」。
- /loop-native 代码更少、更抗重启、更对齐 Anthropic 哲学(FLY-400 背书)。
- Monitor-extension 的**唯一独占优势 = backend-agnostic**;但当前 idle-loop 问题主要发生在 claude runner(agy/kimi 是 no-transport pr_handoff、终态不 idle-loop;codex 可用 `/goal`),所以这个优势现在价值有限 → 留作**兜底 + 未来非-claude 覆盖**,不作为首发。

### 5.3 Phase 0 spike（go/no-go 闸,先做、便宜)

真机起 1 个 claude-tmux runner，bootstrap 注入「自续跑契约」，验四点(Anthropic「先在 1 个上验」纪律):
1. **自续跑**:一轮做完、goal 没完、无 question → 自己排下一轮续跑(不 idle 死在 prompt)。
2. **gate 停对**:撞 brainstorm/approve gate → 阻塞停下、不空转续跑。
3. **question 停对**:自己发起 blocking question → 停下等答、不盲续。
4. **`ScheduleWakeup` 无人值守可靠 fire**(这条是整条路的 go/no-go)。

- spike **过** → 走 5.4(/loop-native + 安全网),写 plan.md。
- spike **撞硬伤**(ScheduleWakeup 不可靠 / 循环控不住)→ 退回 5.5(Monitor-extension),写 plan.md。

### 5.4 若走 /loop-native（首选路的落地形状,plan.md 细化)

1. **goal 契约注入**(借 FLY-512 `/goal` 6 要素的精简版,写进 Blueprint/appendSystemPrompt):outcome（做完什么=到开 PR/下一个 gate)、verification（证据)、**blocked stop condition**(何时停下问)、**iteration policy**(「一次续跑 turn 无 tool call 就停,防空转」)。
2. **自续跑机制**:runner bootstrap 指示用 `/loop` self-paced（`ScheduleWakeup`）朝 goal 续跑,遇 gate/question 停。
3. **安全网**:保留 `StuckRunnerDetector`,把它的 `runner_stuck_escalation` 经 **FLY-368 AlertChannelHub 可靠直达 founder**(= item A / FLY-163)。**RunnerIdleWatchdog 的 idle 报警可调静**(续跑归 /loop、报警归 stuck-detector),避免双重打扰。
4. **byte-compat / 灰度**:默认行为可用 env 开关灰度(先单 runner 验、再放大)。

### 5.5 若退回 Monitor-extension（兜底路的落地形状)

= brainstorm gate 里我原提的方案:`RunnerIdleWatchdog` 短阈值 → `quiet_unexplained` → 审计 `continue` nudge(有界 budget+backoff)→ 耗尽/续不动 → FLY-368 升级 founder。基于/兼容 in-flight FLY-368 head。

---

## 6. 给 Lead / Annie 的一句话

> **/loop 能不能替掉看门狗?——能替掉「续跑」那半(claude runner 用自带 /loop 自己续,代码最少、最抗重启、最对齐 Anthropic 哲学);但替不掉「真卡住→可靠告诉 founder」那半(item A 的核心)——那半留给缩小成纯安全网的 stuck-detector + FLY-368 直达 founder。** 建议先花 30 分钟真机 spike 验 /loop 能不能干净套 runner:过就走 /loop-native、Annie 的首选;撞硬伤才退回自造 Monitor。**都不需要现在就自造一个新看门狗。**

---

## 来源诚实分层

- **代码审计**(高置信,file:line):TmuxAdapter 无 `--max-turns` + 注入点;RunnerIdleWatchdog 只 emit 不续;quiet-classifier verdict;attemptRunnerRecoveryNudge 门控;AutoRepairBot 只对长阈值 + 默认 OFF;FLY-368 AlertChannelHub。
- **活证据**:本 FLY-818 runner(claude-tmux)自身持有 `/loop` skill + `ScheduleWakeup` 工具。
- **前置研究**:FLY-512(Codex `/goal` 事件驱动续跑蓝图 + finding F)、FLY-400(thinnest wrapper / everything is the model),均 Annie 委托、已完成。
- **Phase-0 spike 结果(2026-07-03,已跑,全 PASS)**:1 个无人值守 claude session(隔离 tmux socket + `/loop` self-paced)—— ①自续跑 3 次 TICK(每轮~115s,零用户输入)②/③注入 STOP→下一轮写 STOPPED→停、无 runaway ④ScheduleWakeup 无人值守连 fire 3 次。**原先唯一没被生产证据覆盖的点(ScheduleWakeup 无人值守可靠性)已证实 → /loop-native go。** 原始证据见 `spike-evidence.txt`。保真:同 `claude` 二进制 + 同 `~/.claude`,测的正是 harness 自续跑原语,真 runner 一致;剩「怎么把 /loop 契约注入 runner bootstrap」= plan 层细节。
