# FLY-353 架构进化(Managed Agents + openclaw + Raft)— 探索(current-state 现状审计)

Issue: FLY-353 (https://linear.app/geoforge3d/issue/FLY-353/架构进化-research-综合-managed-agents-openclaw-raft-精进-flywheel-系统架构)
日期: 2026-07-08
基于: 无(本 issue 是从小红书 8 方向收敛出的架构 research;consolidate 原 FLY-334/335/370)

> 说明:本文是**现状代码审计**(我的功课),不是 research 正文、更不是 PRD。目的是让"抄
> Managed Agents 的 session-log"这条建议**建立在 Flywheel 真实代码事实上**,而不是凭空对
> 着博客设计。深度调研收敛在同文件夹 `research.md`,产品决策 / PRD 收敛在 `plan.md`。

---

## 0. 一句话结论(审计后)

Flywheel **已经有三样"像 session-log 的东西",但没有一样是** Managed Agents 意义上的
"runner 自己拥有、context 外、细粒度、可 replay 的工作记忆事件日志"。三样各自只覆盖一小块:

| 现有物 | 是什么 | 缺什么(相对 Managed Agents session-log) |
|---|---|---|
| Claude Code 原生 `session-<id>.jsonl` transcript | vendor 私有对话流,`--resume <id>` 恢复 | 不是 Flywheel 拥有 / 不跨 vendor(agy/kimi/codex 各不同或没有)/ Flywheel 查不了、slice 不了 / 与编排解耦不了 |
| FLY-795 `progressResume`(progress.md + committed docs) | 粗粒度、文档级的"死后重派"重建 | 粗粒度(cursor + 阶段产物,不是完整工作状态)/ 只覆盖"死了再派",不覆盖活 runner context 饱和 |
| Bridge `session_events` 表(StateStore) | append-only,但记的是**关于** session 的**编排**事件 | 记的是 session_completed / stage_changed 等编排信号,**不是** runner 自己的推理 / 工具调用 / 中间产物 |

**净缺口 = 没有 Flywheel 拥有的、context 外的、可 replay 的 runner 工作记忆日志。** 这正是
FLY-353 判断"最高杠杆"的那条:补上它 → 无状态 runner 可安全 respawn + 从日志重建 → 一箭同
时缓解 context 饱和(FLY-916 一侧)、respawn 丢状态(FLY-939 的病根)、重启丢 WIP。

---

## 1. Annie / Cass 的判断(原话摘要)

Cass deep-dig 把三个参考的共通模式提炼成 Flywheel 下一步架构进化:

- ① **解耦 session / 记忆 —— 最高杠杆。** 把 runner 的记忆 / 事件从 context 里拆出来、做成
  context 外的 **append-only 事件日志**(抄 Managed Agents)→ 无状态 runner 可安全 respawn +
  从日志重建 → **一箭治** context 饱和(FLY-916)+ respawn 丢状态(FLY-939)+ 重启丢 WIP。
- ② **stale-snapshot 处理**(Raft 的 version-check + staged-draft)= 我们的防撞车(FLY-1002,
  **已在做**)。
- ③ **always-on + heartbeat + failover**(openclaw = 我们已有那套,可 benchmark 对照)。

Annie 要 HL 的活:research 上面 3 个输入 → 综合提炼 → 出『Flywheel 系统架构进化』的 PRD /
决策(**重点:session-log 解耦怎么落地**)。research 后若判断某条不做,直接说明。

**我审计后的判断:这个方向诊断准。** 下面把三条落到具体代码 / 现状。

---

## 2. 现状:Runner 的"记忆"今天到底存在哪里、怎么重建

### 2.1 三层"记忆",全都不是 Flywheel 拥有的可 replay 日志

**(a) Claude Code 原生 transcript(vendor 私有)。** 每个 runner = tmux 里一个 `claude` CLI
进程。Claude Code 自己把整条对话流写成 `~/.claude/projects/<proj>/session-<id>.jsonl`,
`--resume <sessionId>` 恢复(`ClaudeCodeAdapter.ts:95` `args.push("--resume", resumeId)`;
`ClaudeRunner.ts:468` 从 stream 里捕获 `message.session_id`)。

- 这是**唯一**真·细粒度的完整工作记录 —— 但它是 **Claude Code 私有格式、Claude Code 拥有**。
- **不跨 vendor**:agy(`AntigravityTmuxAdapter`)、kimi(`KimiTmuxAdapter`)、codex
  (`CodexTmuxAdapter`)注释都明写"没有 claude 的 `--session-id`";它们的 resume 语义各不同
  (codex 用 `codex exec resume <threadId>`,agy/kimi transport=none 干脆走 `pr_handoff`
  终态、不进 respawn 环)。→ Flywheel 已经是 agent-agnostic 的了,但"记忆恢复"仍钉在各 vendor 的
  原生 transcript / session 身份上(claude headless `--resume` / claude 交互式 `--session-id` /
  codex `threadId` / agy·kimi 无),**这是 vendor lock-in 的一处**。
- **Flywheel 查不了 / slice 不了它**:Bridge 拿不到这条 jsonl 的结构化视图,无法做
  "getEvents / rewind / slice / 摘要给 Lead"这类操作。

**(b) FLY-795 `progressResume` —— 粗粒度、文档级的"死后重派"重建。** 当 teamlead 给一个
**已死**的 runner(显式 terminate / reboot / handoff)重新派活,Blueprint 前置一段 RESUME 指令
(`edge-worker/src/resume-mode.ts`),让新 runner:

1. 读 `progress.md` 的 cursor(current phase / chunk 状态 / next step);
2. 读 branch 上 committed 的 exploration/research/plan(方法 + 已锁决策);
3. 只有当 StateStore 权威 `effectiveStage` 与 ledger phase **一致**(且已到 implement/qa)
   时,才发"跳过 onboard/brainstorm"的授权层(`resume-mode.ts` fail-closed 设计,防 stale/
   篡改的 progress.md 越过强制 gate)。

→ 这是**重建"我做到哪了"**,不是**重建"我当时在想什么、工具调用到哪一步"**。它靠**阶段产物 +
一个 cursor 文件**,粒度是"阶段/chunk",不是"事件"。而且只在**死了再派**时触发。

**(c) Bridge `session_events`(编排事件,不是工作记忆)。** `StateStore.ts:859` 建
`session_events` 表(append-only,`insertEvent` / `getEventsByExecution`),但装的是
`session_completed` / `stage_changed` / `three_stage_fix_round` 这类**编排层**事件 —— Bridge
用它驱动 FSM (`applyTransition`) 和收尾。**它记录的是"这个 session 发生了什么外部可见的里程碑",
不是 runner 内部的推理 / 工具调用 / 中间产物。** 它已经证明了"append-only 事件日志在 Flywheel 里
是成立的工程形态" —— 但它不是 runner 工作记忆。

### 2.2 活 runner context 饱和:今天完全没治

`progressResume` 只覆盖"死了再派"。一个**活着**的 runner context 填满时,Flywheel 层面**没有任何
处理** —— 只能靠 Claude Code 自己的**有损 auto-compact**(把老对话压成摘要)。后果:

- compact 是 vendor 黑盒、有损,Flywheel 既控不了也看不到丢了什么;
- 长任务(FLY-909 那种多轮竞品 research、或本 issue 这种大 research)后期质量会因 context
  被压而下滑;
- 没有"主动 slice / 主动重建一个 fresh runner 从日志接着干"的手段。

### 2.3 respawn 丢状态 → 现有对策是"绝不 respawn"(FLY-939,已 Done)

FLY-939(PR #482)的病根原话:phase session **没有保活 + wake,而是到处 respawn**
(QA-fail rework 新 spawn 而非 wake 原 parked implement;重启 reconcile 又 spawn 一批 → 重复
runner)。它的修法是 **wake-not-respawn**:所有需要重跑/复验的路径都必须**唤醒那个常驻 parked
的 phase session,绝不 spawn 新的**;配 FLY-887 phase-session-keepalive 全程保活。

- **关键洞察(FLY-353 的杠杆点):** "绝不 respawn"是一个**绕过式**修法 —— 因为 respawn 会丢
  状态,所以被迫**永远把那个进程 kept alive**。这让系统被"必须保活一堆常驻 session"绑住
  (正好又喂大了 FLY-916 的 Lead 负担)。**如果状态在 context 外的可 replay 日志里,respawn
  本身就是安全的** → 就不必强求"绝不 respawn",keepalive 的脆弱性(保不住就出乱象)也随之下降。
- 也就是说:session-log 解耦 **不是要推翻 FLY-939**,而是把它从"靠保活兜底"升级成"respawn
  安全、保活变成优化而非正确性依赖"。

### 2.4 重启丢 WIP + 收尾被重启打断(与 FLY-978 同源)

FLY-978 exploration 已经详审:Bridge 是 launchd 常驻,几乎每个 flywheel 代码 PR merge 都会重启
一次;`restart-services.sh` 的 idle-wait 甚至可能**打断正在收尾的清理级联**(claim 已插 → 重启
后 replay 被丢 → 永久 ghost)。这条痛点 FLY-978 从"收尾状态机 durable/resumable"一侧治;
FLY-353 从"runner 工作状态 durable(在 context 外日志里)"另一侧治 —— **两者互补**:978 保
"收尾不丢",353 保"运行中状态不丢"。

---

## 3. 三个参考的现状对照(审计视角,细节留给 research.md 深挖)

### 输入 A — Anthropic Managed Agents(原 FLY-334)= 核心可抄

三层解耦:**brain**(Claude+harness,无状态,随时从 session 重建 context)/ **hands**(工具,
`execute(name,input)→string`)/ **session**(append-only 事件日志,**在 context 外**,支持
getEvents / rewind / slice)。brain 间可传 hands。宣称效果 p50 TTFT −60%、p95 −90%。

- **对 Flywheel 的直接映射:** brain = runner(claude/agy/kimi/codex 进程);hands = 工具
  (flywheel-comm / MCP / bash);session = **我们缺的那层**。Flywheel 已经把 brain 做成
  agent-agnostic(§2.1),差的正是那条**自己拥有的 session 日志**。
- **核心可抄 = session 事件日志。** 这是 FLY-353 的主交付物候选。research.md 要核实:事件
  schema 长什么样、rewind/slice 的语义、如何做到 brain 无状态重建、跟 Flywheel 现有
  `session_events` 表能不能同构 / 复用。

### 输入 B — openclaw 无人值守编排(原 FLY-335)= benchmark 对照,大概率不抄

always-on daemon + heartbeat + 多渠道 + session 持久化 + queue + auth failover —— **几乎逐条
对应 Flywheel 已有的**:launchd 常驻 Bridge + `HeartbeatService`(5min tick)+ Discord/Linear/
GitHub 多 transport + StateStore 持久化 + DAG queue + codex 多账号 failover(`codex-with-fallback`)。

- **审计判断:B 大概率是"benchmark 印证我们已在正道",不是"抄一个新架构"。** research.md 的活
  = 逐条 benchmark(我们 vs 它),找出**它做得比我们好的长跑质量保障点**(它宣称跑 4 天自重构),
  以及**我们已经领先的点**。产出应是"对照表 + 该学的 1-2 个具体点",而不是重写编排层。

### 输入 C — Raft(原 FLY-370)= 已收敛,本 issue 只引用

stale-snapshot 解法(version-check + staged-draft)已落成防撞车 **FLY-1002**(Tadashi 在建);
竞品分析见 **FLY-909/1001**。**本 issue 不重复 Raft 竞品/防撞车工作,只在 research.md 引用**,并
说明"③ Raft 这条已经在做,353 不重开"。

---

## 4. 边界事实(设计 session-log 时要尊重的现有合同)

- **agent-agnostic 是硬约束。** 任何 session-log 设计**不能钉死 Claude Code**;要能覆盖
  agy/kimi(transport=none,走 pr_handoff)/ codex(thread resume)。这既是约束、也是
  session-log 的**最大卖点**(把"记忆恢复"从 vendor 原生 transcript / session 身份里解放出来)。
- **Bridge StateStore 现在是 native better-sqlite3 + WAL(FLY-663),不是 sql.js。** 早年的 sql.js
  WASM corruption(save() 每写全库 export() → 堆碎片化撞穿,memory
  `reference_statestore_sqljs_corruption_root_cause`)是**历史根因**、已被 FLY-663 结构性根治。
  → 所以"session-log 别塞进 StateStore"的理由**不是"引擎会崩"**,而是 product/operational:语义分离
  (StateStore 装编排事件)/ retention 隔离 / blast radius / 别让高频 runner-memory 写抢共享 Bridge DB。
  存储介质是 research.md 的关键子问题(独立 append-only jsonl / better-sqlite3 索引层 / 别的)。
- **founder-gated ship / merge 不变**(founder-only-authority)。session-log 是运行时机制,
  不碰授权语义。
- **FLY-978 的 durable finalization 是 sibling,不是本 issue。** 353 管"运行中工作状态",978
  管"收尾"。两份 PRD 要 cross-ref,别 drift、别重叠。
- **字节兼容 / 渐进落地。** Flywheel 的惯例是新机制默认 off、reverse-compat sentinel 保护
  (FLY-205/175 等)。session-log 这么底层的改动**必须**能默认关、灰度开,不能一刀切换。

---

## 5. 设计空间(留给 research.md 深挖 + plan.md 拍板,本文不定案)

- **A. session-log 的归属与形态:** Flywheel 拥有的 append-only 事件日志 —— 事件 schema、粒度
  (turn 级?tool-call 级?)、存储介质(独立文件 / per-runner sqlite / 复用 `session_events`)、
  与 Claude Code jsonl 的关系(取代?镜像?桥接?)。
- **B. 无状态重建怎么落:** fresh runner 如何从日志 replay 出可继续工作的 context;和现有
  `progressResume`(粗粒度)如何合并 —— 是 progressResume 的细粒度升级,还是并存两层。
- **C. context 饱和的主动处置:** 有了日志,能不能主动 slice + 重派 fresh runner(而不是等
  vendor 有损 compact)。这条直接接 FLY-916 一侧。
- **D. 覆盖 respawn 安全 → 对 FLY-939 keepalive 的影响:** respawn 变安全后,keepalive 从
  "正确性依赖"降级成"性能优化",这条要写清楚(别让人误以为要推翻 939)。
- **E. openclaw benchmark 的可行动结论:** 逐条对照后,明确 1-2 个"该学的长跑质量点",其余
  说明"我们已领先 / 不抄"。
- **F. 落地范围与 phasing:** 这是底层大改。第一刀切多小(MVP:先只做"日志 + 死后重建的细粒度
  升级"?还是连 context 饱和主动 slice 一起?),怎么灰度、怎么 reverse-compat。

---

## 6. 关联 issue 一族

- **要治的痛:** FLY-916(Lead scale / context 饱和一侧,tree+facade 消费 session-log 的摘要)·
  FLY-939(respawn 丢状态,已 Done 的 wake-not-respawn,353 让 respawn 变安全)· FLY-978(重启
  丢 WIP / 收尾,sibling,durable finalization 一侧)。
- **已在做、只引用:** FLY-1002(Raft 防撞车)· FLY-909/1001(Raft 竞品)· FLY-887(phase
  keepalive)。
- **consolidated 进本 issue(原独立):** FLY-334(Managed Agents)· FLY-335(openclaw)·
  FLY-370(Raft)。
- **实现交接:** research + PRD 定案后,build issue 给 **Tadashi**(Flywheel 标签)。
