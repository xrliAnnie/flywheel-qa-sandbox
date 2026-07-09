# FLY-353 架构进化(Managed Agents + openclaw + Raft)— 调研

Issue: FLY-353 (https://linear.app/geoforge3d/issue/FLY-353/架构进化-research-综合-managed-agents-openclaw-raft-精进-flywheel-系统架构)
日期: 2026-07-08
基于: exploration.md(现状审计)、brainstorm gate 已确认方向(Q1=build-ready PRD、Q2=phased、三 verdict 全过、FLY-916 并进不重开)

> 本文是**综合调研**:深读三输入 → 映射 Flywheel 真实代码 → 提炼"抄什么/不抄什么" → 收敛出
> session-log 解耦的设计空间与建议。产品决策 / build-issue 拆分收敛在 `plan.md`(PRD)。
> 外部事实均已核实(Anthropic 工程博客 + openclaw 文档);现状代码事实见 exploration.md。

---

## 1. 研究问题与方法

**核心问题(Annie / Cass 定):** 三个参考(A Managed Agents / B openclaw / C Raft)的共通模式,
指向 Flywheel 下一步该做的**最高杠杆架构进化**是什么、怎么落地?**重点 = session-log 解耦。**

**方法:** ① 深读每个参考的**真实架构**(不是二手转述);② 逐项映射 Flywheel **现有代码**(避免
"对着博客设计");③ 对每条给出**抄 / 不抄 + 为什么**;④ 收敛 session-log 的设计空间 + tradeoff。

**一句话答案(调研后):** 三者里**只有 A 指向一个我们真缺的新能力**(context 外、Flywheel 拥有、
可 replay 的 runner 工作记忆日志);B 基本印证"我们的编排已在正道",只值得学 1-2 个点;C 已落地
FLY-1002。**所以 353 的主交付 = 抄 A 的 session-log,B/C 给结论即可。**

---

## 2. 输入 A — Anthropic Managed Agents(核心可抄)

### 2.1 架构(已核实,anthropic.com/engineering/managed-agents)

三层**彻底解耦**,各自"cattle not pets"(独立、可替换、非宠物):

| 层 | 是什么 | 关键接口 / 语义 |
|---|---|---|
| **brain** | "Claude and its harness" —— 做决策的那部分 | 无状态;随时从 session 重建 context |
| **hands** | sandbox + 工具 —— 执行动作 | 统一接口 **`execute(name, input) → string`**;harness 对 custom tool / MCP server / 自有工具**一视同仁**,"doesn't know whether the sandbox is a container, a phone, or a Pokémon emulator" |
| **session** | **"the append-only log of everything that happened"**,在 Claude context window **之外** | `emitEvent(id, event)` 写入;`getEvents()` 取**位置切片**(slice);rewind(回退到某刻之前几条事件);`wake(sessionId)`(harness 崩溃后重启读取);`getSession(id)` |

关键设计点:

- **harness 不再住在 container 里**,而是**像调别的 tool 一样调 container**(`execute`)。→ inference
  不用等 container provision → **p50 TTFT 降 ~60%、p95 降 >90%**(博客数据)。
- **brain 无状态**:context 不是"进程内攒着的",而是 harness **每次从 session 日志按需读切片、
  transform 后喂给 Claude**。→ brain 可随时被杀+重建,context 不丢。
- **hands 不绑 brain**:"no hand is coupled to any brain, brains can pass hands to one another" →
  多 brain 协作、传工具。
- **崩溃存活**:`wake(sessionId)` + `getSession(id)` 让 session 在 harness crash 后仍能续 —— **这是
  "从日志重建"的落地形态**。
- **安全**:凭证存 vault,绝不进跑不可信代码的 sandbox。

### 2.2 映射 Flywheel(逐层对号)

| Managed Agents | Flywheel 现状 | 差距 |
|---|---|---|
| **brain** | runner = tmux 里 claude/agy/kimi/codex 进程,已 **agent-agnostic**(4 个 adapter) | brain 层我们已经做对了 —— 但"记忆恢复"仍钉在各 vendor 原生 transcript/session 身份上(claude `--resume`/`--session-id`、codex `threadId`、agy·kimi 无)= vendor lock-in |
| **hands** = `execute(name,input)→string` | 工具已是 execute 式:flywheel-comm / MCP / bash / git;runner 通过它们动作 | hands 层基本对齐,无需大改 |
| **session** = append-only 日志 + getEvents/rewind/slice/wake | **缺**。现有三样都不是(见 exploration §0/§2):Claude Code jsonl(vendor 私有)、progressResume(粗粒度)、session_events(编排事件) | **这就是 353 要补的那一层** |

**结论:Flywheel 已经天然是 brain/hands 解耦的形态,唯独缺 session 层。** 补上它,brain 就能真正
无状态 —— 这正是"最高杠杆"的技术根据:我们不是要重构 brain/hands,只要**补一层日志**。

### 2.2.1 编排:我们用不用 DAG?动态 vs 静态(Annie 在 336 问,grounded 核代码)

- **我们有 DAG 代码,但 dormant。** `packages/dag-resolver`(Kahn 拓扑排序 Linear `blockedBy`)是 v0.2
  老架构(老图「Linear→DAG resolver→sessions」);但 grounded 核代码:整图自动执行的 `DagDispatcher`
  在**生产 Bridge 路径 0 处实例化**(全仓 `new DagDispatcher` 生产路径无命中)→ 事实上没在跑。
- **当前真实派活 = 动态、Lead 驱动、逐 issue。** `RunDispatcher`(FLY-22,`/api/runs/start`)一 issue 一次
  触发;`AgentDispatcher.dispatch({issueLabels, owningDept})` 按 label/部门动态选 role;issue 内编排 =
  三段式(design→impl→QA)。谁跑/何时跑 = Lead(Cass 分诊 / Tadashi 派)/ founder **现场决定**。唯一起
  作用的"依赖" = Linear `blockedBy`,由**人读了判断**,不是自动 DAG 执行器 gate。
- **vs homerail 静态 DAG(general pattern,已核实;homerail 具体实现 UNKNOWN 未查到官方文档):** 静态 DAG =
  Planner 预规划整图 → Executor 照图走 → 依赖预声明。**我们相反:没有"先规划整图再自动执行",每次派活现场
  动态、人在环。** "是否已很像 homerail":表面像(有 dag-resolver 包 + Linear blockedBy),实质不像 —— 分水岭
  是"谁决定执行/何时决定":静态 DAG 预先/自动,我们现场/Lead 动态。**不该被归成静态 DAG 那一类。**

### 2.3 补上 session 层 → 一箭治三痛(为什么是最高杠杆)

| 痛 | 现状(exploration 详) | 有了 session-log 后 |
|---|---|---|
| **respawn 丢状态**(FLY-939 病根) | 被迫 "wake-not-respawn + 全程 keepalive",靠**保活**兜底;保不住就出重复 runner 乱象 | `wake(sessionId)` 式重建 → **respawn 本身安全**;keepalive 从**正确性依赖**降级成**性能优化** |
| **context 饱和**(FLY-916 一侧 + 活 runner) | 活 runner 填满只能靠 Claude Code **有损 auto-compact**(vendor 黑盒);Lead 带多 session 也吃 context | 可**主动 slice** 日志、重派 fresh runner 从切片重建;Lead 可消费**日志衍生的压缩摘要**(facade) |
| **重启丢 WIP**(与 FLY-978 同源) | Bridge 重启可能打断收尾 / 丢运行中状态 | 运行中状态在 context 外日志里 → 重启不丢(与 978 的 durable finalization 互补:978 保收尾、353 保运行中) |

**这三痛今天是分头治的(939 保活 / 916 树+facade / 978 收尾状态机),session-log 是它们共同的
缺失底座。** 补上底座,三条各自的方案都会变轻、变稳。

> **⚠️ Annie co-eval 收窄(2026-07-08,已认同、贯穿):上表的"缺"要按场景读,不是笼统"我们缺 session"。**
> 我们用 Claude Code,brain/hands/session 原生就有(transcript = session、`--resume` 续、auto-compact)。
> 所以 session-log **不是"我们缺 session"**,是**"要不要 Flywheel 自己 OWN 这条 log"** —— 只在 3 场景才多出
> 价值:**① Codex/kimi(无 Claude 原生 session 层)· ② 跨 agent 查询/切片(916 主动 slice/facade)· ③ 多机
> (单机 tmux 保活 OK、多机不行,tmux send-keys 跨不了主机)**。对 **Claude+单机**,原生够用、这条不必做。
> 上表三行里,939/978 在**单机**多靠 tmux 保活 + durable finalization 已能兜;真正只有踩到上面 3 场景,自己
> own 才是解。→ **本 research 不再把 session-log 当"必做候选#1",改成"这 3 场景才需要,按场景定值不值"。**

### 2.4 与 FLY-916(Lead scale / 树+facade)的关系 —— 并进不重开

Lead 带 5-6 session 就吃力(FLY-916),解法是**树状 Lead + facade 压缩层**(Lead 只看摘要不看每个
runner 细节)。**facade 的"摘要"从哪来?** —— 正是从 runner 的 **session-log slice + 摘要**。所以:

- **session-log = facade / 树的底料**(可 slice、可摘要的结构化日志才能压缩上报);
- 353 **不重做** FLY-916 的树/看门狗设计(那是 916 自己的活),只在 PRD 里点明"session-log 是它的
  前置底座",并把 916 作为 session-log 的**头号消费者**记录下来(Lead 已确认:916 并进这条别重复开)。

---

## 3. 输入 B — openclaw(benchmark 对照,大概率不抄架构)

### 3.1 事实(已核实,docs.openclaw.ai + 多篇 2026 指南)

- 开源;late Jan 2026 一周 **10 万 GitHub star**;**Feb 2026 被 OpenAI 收购**。
- **Gateway** = 常驻 daemon(Linux systemd / macOS LaunchAgent):管消息渠道连接、路由消息到 agent
  session、调度。
- **Heartbeat**:可配,默认 **每 30min**(Anthropic OAuth 时每小时)。每跳读 workspace 里的
  **HEARTBEAT.md 清单**,判断有没有要做的事;无事回 `HEARTBEAT_OK` → Gateway **静默吞掉**不投给你 →
  让 agent"感觉主动"而非被动。
- **20+ 消息平台**,24/7 无人值守。

### 3.2 逐条 benchmark(Flywheel vs openclaw)

| openclaw 能力 | Flywheel 对应 | 判断 |
|---|---|---|
| Gateway 常驻 daemon | **Bridge**(launchd,KeepAlive) | ✅ 对齐 |
| 多渠道(20+) | Discord / Linear / GitHub transport | ✅ 对齐(渠道数少但形态一致) |
| session 持久化 | **StateStore**(better-sqlite3+WAL,FLY-663 后)+ CommDB | ✅ 对齐 |
| queue / 调度 | **DAG resolver** + dispatch | ✅ 对齐 |
| auth failover | **codex-with-fallback**(5 账号轮转) | ✅ 对齐,甚至更成熟 |
| **Heartbeat = 主动清单推理**(HEARTBEAT.md) | **HeartbeatService**(5min tick)= **存活探测/健康** | ⚠️ **形态不同 —— 可学点** |

### 3.3 可学的 1-2 个点(诚实、聚焦)

**可学点 ①(主要)—— heartbeat 从"存活探测"升级成"主动清单推理"。** 我们的 HeartbeatService 是
liveness/健康 tick(它活着吗?);openclaw 的 heartbeat 是**agent 自己读一份清单、判断"我现在该主动
做点啥吗"**。Flywheel 里"主动"目前靠 **scheduled-issue / cron + Lead patrol**(如 xiaohongshu-learning
定时 issue、daily standup)。→ **建议:不新造 heartbeat 引擎**(会和现有 scheduled-issue 重复),但可以把
"主动清单"模式**作为 Lead 层的一个轻 pattern** 借鉴(Lead 定期自问"我这摊有没有该主动推进/该报的")。
**这条是 nice-to-have,不进 session-log MVP。**

**可学点 ②(次要)—— 长跑无人值守的质量纪律。** 注:小红书 n04 那个"跑 4 天 / 633 commit / 12.9 亿
token 自重构"是**某次 demo run**,**不是 openclaw 的架构特性**。它体现的长跑质量靠的是**编排纪律**
(图编排 / YAML 分层解耦 / Scorecard 证据链审计 / 打回-扇出-汇聚),而 Flywheel 已经有对应物
(three-stage pipeline / codex design+code review / auto-QA / founder gate)。→ **不抄**,但印证"证据链
审计 + 打回复验"是长跑质量的关键,我们该继续加固(这已在 FLY-942 watchdog / auto-QA 线上)。

### 3.4 B verdict

**openclaw = benchmark 印证 Flywheel 编排已在正道,不重写编排层。** 唯一可行动的轻量借鉴 = heartbeat
主动清单 pattern(Lead 层,非 MVP,记进 PRD 的 "future / 不做" 清单)。**不为 B 开 build issue。**

---

## 4. 输入 C — Raft(引用,不重复)

- Raft(raft.build)= Flywheel 形态的产品化竞品;其 stale-snapshot 解法(**version-check + staged-draft**)
  = 我们的"提交副作用前 re-read + 软 claim"防撞车。
- **已落地 issue:FLY-1002**(Bridge primitive,Tadashi 在建);竞品分析见 **FLY-909 / FLY-1001**。
- **353 只引用,不重复任何 Raft 竞品 / 防撞车工作。** C verdict = 已在做,353 无新活。

---

## 5. 综合 —— Flywheel session-log 解耦的设计空间

以下是 session-log 的关键设计子问题 + 各选项 tradeoff。**本节只摆选项与倾向,拍板在 plan.md。**

### 5.1 归属与形态:Flywheel 拥有的 append-only runner 事件日志

- **要点:** 日志必须是 **Flywheel 拥有 + 结构化 + 可查询/slice**,而不是复用 Claude Code 私有 jsonl。
  因为 (a) 跨 vendor(agy/kimi/codex 没有同款 transcript);(b) Bridge 要能 getEvents/slice/摘要给
  facade;(c) 要和 Flywheel 的 FSM / 收尾 / watchdog 打通。
- **与 Claude Code jsonl 的关系(选项):**
  - **(取代)** 完全自建、不依赖 vendor transcript —— 最干净、最 agent-agnostic,但要自己捕获所有事件,
    改动最大。
  - **(镜像/桥接)** MVP 先**桥接**:runner 通过 flywheel-comm 把关键事件 `emitEvent` 到 Flywheel 日志
    (工具调用摘要 / 阶段产物 / 决策 / 关键消息),vendor transcript 仍作 vendor 自己的 resume 底料。→
    **倾向此项做 MVP**:增量、字节兼容、低风险;后续可逐步把 vendor transcript 的角色削弱。

### 5.2 事件粒度

- **turn 级**(每轮对话一个事件)—— 轻、够重建"做到哪一步 + 关键决策",接近 progressResume 的升级。
- **tool-call 级**(每次工具调用一个事件)—— 重、可精确 rewind/replay,但量大(踩 §5.4 存储雷的风险高)。
- **倾向:MVP = turn 级 + 关键里程碑事件**(阶段转换 / 决策 / gate / 产物),够"细粒度死后重建"且
  可控量;tool-call 级 replay 留给 phase 2 若需要。

### 5.3 与现有 progressResume 的关系

- **不并存两套。** MVP 的 session-log = progressResume 的**细粒度升级 + 存储形态升级**:
  - progressResume 现在 = progress.md cursor(阶段/chunk)+ committed docs;
  - session-log MVP = 结构化事件流(含 progressResume 已有的阶段/chunk 信息 + 关键决策/产物指针),
    **重建时读日志切片**而不是只读一个 cursor 文件。
- **保留 progressResume 的 fail-closed 护栏**(resume-mode.ts:StateStore effectiveStage 与 ledger
  一致才跳过 gate;stale/篡改的日志绝不能越过强制 brainstorm/design gate)—— 这条安全语义**必须继承**。

### 5.4 存储介质(独立于 Bridge StateStore —— product/operational 边界)

> **事实纠偏:** StateStore **不再是 sql.js**。FLY-663 已迁到 native better-sqlite3 + WAL(增量写、
> 无全库 export、save() 现为 no-op),旧 sql.js WASM corruption(save() 每写全库 export() → 堆碎片化)
> 是**历史根因**、已结构性根治。所以"别塞进 StateStore"**不是"引擎会崩"**。

- **仍然独立存储,但理由是 product/operational:** 语义分离(StateStore 装编排事件 session_completed/
  stage_changed,别混进 runner 工作记忆)/ retention 隔离(工作记忆随 runner 生命周期清)/ blast radius
  有界 / 别让高频 runner-memory 写抢共享 Bridge DB 的 WAL/锁。
- **选项:** (a) per-runner **独立 append-only jsonl 文件**(Flywheel 拥有格式);(b) per-project /
  per-runner **独立 sqlite**(better-sqlite3,已在 audit.db / CommDB 用);(c) 现有 CommDB 加表。
- **倾向:独立 append-only jsonl 文件(a)做 MVP** —— append 天然便宜、无全库 rewrite、易 slice(按行/
  按 offset)、易 gc/rotate;需要查询聚合时再加 better-sqlite3 索引层。**独立于 Bridge StateStore。**
  (jsonl 自己的 durability/corruption 语义 —— 原子 append / torn-tail 恢复 / 0600 权限 / rotation ——
  是 PRD §5.3.1 的 build-ready 约束。)

### 5.5 agent-agnostic 覆盖

- 日志的 `emitEvent` 入口走 **flywheel-comm**(所有 vendor 都能调的 CLI)→ 天然覆盖 claude/agy/kimi/codex。
- **重建**不再依赖 vendor 原生 transcript / session 身份(claude `--resume`/`--session-id` / codex
  `threadId` / agy·kimi 无):fresh runner 起来时,Blueprint 注入"读你的 session-log 切片"(类似现在
  注入 progressResume),vendor 无关。→ **顺带拆掉 exploration §4 点出的 vendor lock-in。**

### 5.6 落地范围(phasing,Lead 已确认)

- **MVP(本 PRD 主体):** Flywheel 拥有的 append-only runner 事件日志(turn 级 + 里程碑,独立 jsonl,
  emitEvent 经 flywheel-comm)+ **细粒度死后重建**(升级 progressResume,继承 fail-closed 护栏)。
- **Phase 2(PRD 里点出、不在本 issue 建):** 活 runner **context 饱和主动 slice + 重派 fresh runner**;
  facade 消费日志摘要喂 FLY-916 的树。
- **Future / 不做:** openclaw heartbeat 主动清单 pattern(Lead 层轻借鉴,非 session-log);tool-call 级
  精确 replay(若 phase 2 证明需要再说)。

### 5.7 字节兼容 / 灰度

- 遵循 Flywheel 惯例:新机制**默认 off** + reverse-compat sentinel;`FLYWHEEL_SESSION_LOG=0` 逃生口;
  不配置 = 逐字现状(仍走 progressResume + 各 vendor 原生 session 行为)。**这么底层的改动必须能灰度、可回退。**

---

## 6. 收敛建议(喂给 plan.md 的 PRD)

1. **主交付 = 抄 A 的 session-log。** MVP 范围见 §5.6;三条 verdict:A 建、B 不建(只记 heartbeat 借鉴)、
   C 引用 FLY-1002。
2. **session-log = 三痛(FLY-939/916/978 各一侧)的共同缺失底座**;353 补底座,不替代它们的方案。
3. **关键工程约束进 PRD:** 独立 append-only jsonl(独立于 Bridge StateStore,理由 = 语义/retention/
   blast-radius,非 sql.js corruption §5.4)· emitEvent 经 flywheel-comm(agent-agnostic §5.5)· 继承
   progressResume 的 fail-closed gate 护栏(§5.3)· 默认 off 灰度(§5.7)。
4. **build-issue 拆分给 Tadashi**(plan.md §拆分):日志写入层 / 重建层(升级 progressResume)/ 存储与
   gc / 灰度开关与 reverse-compat / phase-2 占位(context 饱和 slice,不在本批建)。
5. **FLY-916 记为头号消费者**(并进本条不重开);FLY-978 记为 sibling(cross-ref,别 drift)。

---

## 7. 关联 issue

要治的痛:FLY-916(Lead scale,session-log 头号消费者,并进本条)· FLY-939(respawn,已 Done 的保活,
session-log 让 respawn 变安全)· FLY-978(收尾,sibling,durable finalization 互补)。
已在做只引用:FLY-1002(Raft 防撞车)· FLY-909/1001(Raft 竞品)· FLY-887(phase keepalive)。
consolidated:FLY-334(Managed Agents)· FLY-335(openclaw)· FLY-370(Raft)。实现交接:Tadashi。
