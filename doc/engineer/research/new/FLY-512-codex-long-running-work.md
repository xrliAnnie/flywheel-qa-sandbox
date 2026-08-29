# Research: OpenAI「Codex maxxing long-running work」→ 对 Flywheel 的启示 — FLY-512

**Issue**: FLY-512
**Date**: 2026-06-23
**Source**: Annie 分享 `openai.com/index/codex-maxxing-long-running-work/`（同内容镜像:`developers.openai.com/blog/run-long-horizon-tasks-with-codex` + openai-cookbook 的 `using_goals_in_codex.ipynb` + `Build_iterative_repair_loops_with_Codex.ipynb`）
**Status**: Complete

> 一句话:OpenAI 这套「让 Codex 跑 25 小时不间断」的方法,核心不是更聪明的模型,而是**把开放式工作变成一串可验证的检查点 + 把目标/计划/状态写进可反复回看的文件 + 完成必须靠证据而不是模型自觉**。Flywheel 作为长时 agentic 编排系统,这几条里**我们一半已经做得更硬 —— 证据驱动「done」是系统级硬门(不是 prompt 级自觉)、不自合并、跨进程崩溃恢复、并行 fan-out、批处理 checkpoint(小红书引擎);真正值得抄的是另一半 —— 单 Runner 会话内反复回看的「活文档项目记忆」(4 文件法)+ 写代码 Runner 的 mid-task 断点续跑(这套 checkpoint 纪律我们在小红书引擎已验证,只是没搬到写代码的 Runner)**。

---

## 0. 这篇研究怎么读

- **Part 1** = OpenAI 那套做法的提炼(已抓到原文,逐技法记录,带原始数字)。
- **Part 2** = 对标 Flywheel 现状(Lead 指定的 4 处真实机制 + context/orchestration,带 file:line)。
- **Part 3** = 可执行改进点(优先级排序,每条可转 Linear issue)。
- 配套**互动 HTML 报告**给 Annie:`doc/engineer/research/new/FLY-512-codex-long-running-work.html`。

来源诚实分层在文末。

---

## Part 1 — OpenAI 怎么「maxx」长任务

### 1.1 实验本身(锚定数字)

- Derrick Choi 用 **GPT-5.3-Codex「Extra High」推理** 跑了一次 **~25 小时不间断**的会话。
- 消耗 **~13M tokens**,产出 **~30,000 行代码**,**从零**造了一个设计工具(画布编辑 / 实时协作 / 图层 / 对齐吸附 / 历史快照 / 回放时间线 / 原型模式 / 评论 / 导出 JSON·React·Tailwind 等 10 大功能区)。
- 引用 METR 的基准:前沿 agent 能独立完成的任务长度有「**~7 个月翻倍**」的趋势线 —— 论点是「**持续连贯的时长**」正在变成新的能力维度,不只是单点智力。

> 启示锚点:长任务成功**「与其说靠一个巨型 prompt,不如说靠模型所在的那个 agent loop」**。这句话对 Flywheel 直接成立 —— 我们的价值就在 loop(编排/续跑/验证)而非单次 prompt。

### 1.2 Agent Loop 结构(可持续的纪律循环)

Codex 在一个有纪律的循环里运转:

```
Plan → Edit code → Run tools(test/build/lint) → Observe → Repair failures → Update docs/status → Repeat
```

这个 loop 之所以能撑长程,靠三样东西:
1. **真实反馈**(跑测试/构建/lint 拿到客观信号,不是模型自我评价);
2. **外部化状态**(repository、文件、worktree —— 状态在磁盘上,不在上下文里);
3. **时间可操纵性**(人可以在 milestone 处插手steer,不必重置进度)。

### 1.3 项目记忆:4 个文件(核心做法)

把「目标 / 计划 / 执行规则 / 状态」**写进 markdown 文件**,让 Codex 反复回看 —— 这是整篇里被点名的**最重要的技法**。四文件分工:

| 文件 | 目的 | 内容 |
|------|------|------|
| **Prompt.md**(规格) | 冻结目标、防 scope 漂移 | goals + non-goals;硬约束(性能/确定性/UX/平台);明确交付物 checklist;"Done when" 验收标准 |
| **Plan.md**(里程碑) | 把开放工作拆成可验证检查点 | 颗粒化 milestone(一个 loop 内可完成);每个 milestone 的验收标准 + 验证命令;架构设计笔记;**决策记录**(防来回摇摆 oscillation) |
| **Implement.md**(执行规则) | 把 runbook 操作化 | 指明 plan.md 是 source of truth;**每个 milestone 后强制验证**;限制 scope 的约束;文档更新要求 |
| **Documentation.md**(状态/审计日志) | 让人可异步检查 + 共享记忆 | 当前 milestone 状态;决策理由;执行说明 + 冒烟测试;已知问题 + follow-up |

要点:
- **Prompt.md 冻结「不变的目标」**,Documentation.md 记「变化的状态」—— 一静一动分离。
- 状态可被人**异步检查**(inspectable audit trail),不必盯着 Runner 看。

### 1.4 验证策略:每个 milestone 都验,坏了先修再前进

每个 milestone 上做:**lint(`npm run lint`)+ 类型检查(TS)+ 单测 + 构建验证 + 导出验证(JSON/React 输出)**。
关键纪律:**验证失败时先修好再推进下一个 milestone,不忽略失败往前冲**。

### 1.5 `/goal` 命令:thread-scoped 的持久目标契约(最深的一块)

Codex CLI v0.128.0+ 引入 `/goal` —— 把一个 thread 变成围绕**既定结果**持续工作的循环。这是「长任务怎么续跑」的官方答案,细节对 Flywheel 极有参考价值:

**Goal 是什么**:一个**带完成条件的持久目标** —— 「什么应当为真 / 怎么验证成功 / 哪些约束必须保持」。不是「无边界的后台自治」,而是**用户控制的、有 scope 的完成契约**(可 pause / resume / clear / complete / 按预算停)。

**心智模型**:
```
普通 prompt:  ask → work → result → wait
Goal:         work → check → continue or complete
```

**一个强 Goal 定义 6 件事**:
1. **Outcome** —— 完成时什么为真;
2. **Verification surface** —— 用哪个 test/benchmark/报告/产物/命令输出来证明;
3. **Constraints** —— 工作中什么不能回退;
4. **Boundaries** —— 可用哪些文件/工具/数据/仓库;
5. **Iteration policy** —— 每次尝试后怎么决定下一步;
6. **Blocked stop condition** —— 何时该停下并报告「当前限制下没有可行路径」。

**模板**:
```
/goal <期望终态> verified by <具体证据> while preserving <约束>.
Use <允许的输入/工具/边界>. Between iterations, <如何选下一步>.
If blocked or no valid paths remain, <报告什么 + 需要什么才能解锁>.
```

**架构关键(这点最值得抄)**:
- Goal 是**持久化的 thread 状态**,**不是全局记忆、也不是 project 级指令** —— 目标属于「相关上下文所在的那个 thread」(它检查过的文件、跑过的命令、产生的 diff、看过的日志、推理轨迹)。
- 状态机:`active / paused / complete / budget-limited`。
- **续跑是事件驱动,不是死循环**:只在安全边界续 —— 一个 turn 完成后、无 pending 工作、无排队的用户输入、thread 空闲时。
- **保守 dispatcher**:plan-only 工作不触发续跑;中断会 pause;resume 会恢复目标;**如果一次续跑 turn 没有任何工具调用,就抑制下一次自动续跑(防空转 spin)**。
- **完成必须证据驱动**:不能因为「模型觉得大概做完了」就标 complete,必须对照具体证据(文件/测试/日志/benchmark 输出/产物)核验。
- **预算 ≠ 完成**:到预算上限时停下、总结进度与 blocker、指出下一步 —— 不当作完成。
- **工具契约有界**:模型只能「发起 Goal」和「在证据支持时标完成」;pause/resume/clear/预算转移留给用户或系统控制。

**研究类 Goal 的纪律**(对标我们的 research runner 很贴):先定证据标准 —— 建 claim 清单 → 把 claim 映射到证据 → 实现可做的 → 标记 blocker → 产出一份**区分「已确认 / 仅支撑 / 被阻塞 / 仍不确定」四档**的审计,而不是把它们压平成一句「成功」。

**何时不该用 Goal**:一行小改、简单解释、短 review、只要一个答案就停的问题;终点模糊时(「make this better」给不出完成条件);以及——别用 Goal 掩盖不确定性(数据可能拿不到就在 Goal 里说清)。

### 1.6 迭代修复环 Review → Repair → Validate(对标我们 QA-fix loop)

cookbook 的 `Build_iterative_repair_loops_with_Codex` 给了一个闭环修复的标准结构,三相之间用**机器可读 JSON 结构化交接**:

| 相 | 做什么 | 不做什么 |
|----|--------|----------|
| **Review** | 读产物、返回结构化 findings(issue 类型 + 严重度,JSON) | **不执行验证、不改文件**(判断与求解分离) |
| **Repair** | 收 findings + 业务规则 + 上轮验证反馈;复制一份产物来改;只改最关键的;返回变更摘要 | **不假设改成功了**(由 Validate 决定) |
| **Validate** | 端到端执行;跑领域检查;按 rubric 打分;返回 remaining delta | 不靠假设,只靠执行证据 |

**收敛/停止条件**(防无限环):① 验证全过(无 remaining delta);② **最大迭代数(通常 3 轮)**;③ delta 稳定(剩余项不再变化);④ 收敛停滞 → **触发人工 review**。
**分阶段修复策略**:不是每个问题都要一轮修完;**每轮只解决「最重要的剩余问题」**,次要的带到下轮。
**证据驱动迭代**:后面的轮次看到的 delta 更具体;「运行时和裁判反馈变成有用的修复指令」而非假设。
**审计轨迹**:每轮写 `record.json`(review findings + repair 摘要 + validate 结果),让维护者明白「为什么继续、为什么停、哪个产物可以 review」。
**先定业务规则/契约**:修复开始前定好共享契约(目标 API、读者体验标准、质量判据),agent 才不会从零猜每条产品需求。

> 通用化:这套「**判断与证明分离、按证据迭代、保留审计轨迹**」适用于任何「agent 产出可被可信反馈衡量」的领域 —— 代码现代化、文档刷新、合规更新、协议优化。

### 1.7 一句元结论

这代表一个转变:**从「单次 prompt / 紧贴的结对编程」转向「在护栏内把大块工作委托给 agent,人在 milestone 处 steer 而非逐行盯」**。

---

## Part 2 — 对标 Flywheel 现状

### 2.0 Flywheel 现状速记(带 file:line)

- **Runner 生命周期** = 13 阶段流水线(`started→onboard→brainstorm→research→plan→design_review→implement→test→code_review→pr_created→approve→ship→completed`,`packages/flywheel-comm/src/commands/stage.ts:71-87` + `packages/teamlead/src/bridge/stage-utils.ts:13-43`)+ Bridge 侧 9 状态 FSM(`packages/core/src/workflow-fsm.ts:120-154`)。完成路由 `auto_approve / needs_review / blocked / no_code / pr_handoff`(`packages/flywheel-comm/src/commands/complete.ts:20-36`)。
- **编排** = label 驱动派发(`packages/edge-worker/src/AgentDispatcher.ts:1-230`)→ Blueprint spawn Runner(`packages/teamlead/src/bridge/run-dispatcher.ts`)。DAG resolver 存在但是 legacy(`DagDispatcher.ts`,生产不用)。
- **记忆** = 文件式:**Runner 被指示在会话内自行读取仓内 CLAUDE.md**(`packages/edge-worker/src/Blueprint.ts` 注入「读 CLAUDE.md」指令;`packages/edge-worker/src/PreHydrator.ts` 只拉 Linear issue metadata 作种子 —— **并不把 CLAUDE.md 内容当持久记忆注入**)+ Linear issue = 唯一目标真相。StateStore 只存决策元数据,不存对话历史(`packages/teamlead/src/StateStore.ts:27-142`)。
- **崩溃恢复** = fail-close marker(`complete.ts:373-411`)+ 启动重放(`complete-marker-reconciler.ts`)+ durable launch claim(`run-dispatcher.ts:45-49`)+ heartbeat。
- **self-ship** = human-gated 两步:`needs_review → awaiting_review`(绑定 `pr_head_sha` + `review_question_id`)→ founder `:cool:` / `verify-approval` → `approved_to_ship` → Runner merge → 写 `land-status.json` → 证据(`landingStatus.status=merged`)驱动 finalization(`event-route.ts:538-940` + `post-ship-finalization.ts`)。**Flywheel 无 push token、main 有 branch protection、founder 是唯一可合并者(FLY-175)**。

### 2.1 Lead 指定的 4 处机制 × OpenAI 对标

#### ① FLY-349 引擎 checkpoint/resume — vs Codex milestone 检查点

**现状**(`scripts/fly349-engine/checkpoint.py`,实读):per-note 持久状态机。每个 note 有 `stages = (fetched, downloaded, analyzed, judged, issue, attached)`,终态 `(done, degraded, skipped, failed)`;状态原子落盘(temp+rename,0600);`load_state` 遇 corrupt → 备份为 `.corrupt` + 重新开始(不崩 runner);`add_note` 幂等(resume 保留进度);`bump_attempt` 有 retry cap → 终态 `failed`;resume = 读 state + 跳过 done note + 继续。批 10/batch,batch 状态 `pending→running→reported→reviewed`。

**对标 OpenAI**:这正是 OpenAI 「把开放工作拆成可验证检查点、失败先修再前进」的**批处理版,且我们做得更硬**——OpenAI 的 milestone 检查点靠模型自觉 + markdown 记录;我们这层是**确定性代码 + 原子持久 + 幂等 resume + 损坏自愈 + retry 上限**。
**判定:✅ 已对齐且更强(在批处理域)。** 缺口:这套优秀的 checkpoint 纪律**只活在小红书引擎里,没有泛化到写代码的 Runner**(见 ②/Part 3)。

#### ② Runner 层 FSM / context / 恢复 — vs Codex /goal 状态机 + compaction

**现状**:
- FSM 转移由事件驱动且严格校验(`event-route.ts:538-940`,session_completed 分支带 route guard + FSM 合法性校验)。
- **崩溃恢复是「重放完成事件」级,不是「mid-task 续跑」级**:审计原文「Runner resumes from scratch on retry — no mid-task resumption with partial progress saved internally」。即 Runner 跑到一半挂了,fresh Runner 是**从整个 issue 重头来**,不读「我做到哪个 milestone 了」。
- **context 管理**:无 Flywheel 级 compaction、无 PostCompact hook(`Blueprint.ts` 不调;StateStore 无 context-budget 列)。**完全信任 Claude Code 原生 context 管理**(Opus 1M)。

**对标 OpenAI**:Codex /goal 是 thread-scoped 持久状态(`active/paused/complete/budget-limited`)+ 事件驱动续跑(只在 thread idle 安全边界续,无工具调用就抑制下次防空转)+ **把目标/计划/状态外化到文件,正是为了 compaction 后不丢目标**。
**判定:🟡/🔴 混合。** FSM 校验严谨(✅);但 **(a) 无 mid-task 续跑(🔴 比 ① 自己的引擎弱);(b) 无 context-compaction 存活机制(🔴)**——这对 25h 级长跑是真风险(Anthropic 自己在 FLY-400 视频里也承认「多次 compact 后原始意图变弱、会忘」)。我们靠 1M 窗口扛着,但没有「外化状态 + compaction 后重新定向」的兜底。

> 注意一个反差:**我们在小红书引擎里做了教科书级的 checkpoint/resume(①),却没把同样的纪律用到核心的写代码 Runner 上(②)**。这是 Part 3 的最大 borrow。

#### ③ Mufasa / Writer-Agent 的 set-goal — vs Codex /goal 持久目标契约

**现状**(诚实核对):主仓 codebase **没有** `/goal` 式的「thread 持久目标命令」(审计确认)。FLY-358 Writer Agent 的「set-goal → mobilize sub-agents」是**一次性任务分解 + 子 agent 扇出**的写作引擎模式(在 flywheel-skills 仓的 writing-engine,非主仓),**不是**一个「持续到证据说完成、带预算/续跑/证据闸」的持久契约。Flywheel 里「持久目标」的真实承载是 **Linear issue**(单一真相,跨 Runner 重试都在)。

**对标 OpenAI**:Codex /goal 的 6 要素(Outcome / Verification surface / Constraints / Boundaries / Iteration policy / Blocked stop condition)是**单会话内**的持久契约;Linear issue 承载的是**跨会话**的目标,但**缺 /goal 的「verification surface + blocked stop condition + iteration policy」这几个让 agent 自己知道「怎么算完成 / 何时该停下报阻塞」的字段**。
**判定:🔴 缺口(但部分是有意为之)。** 我们有跨会话的耐久目标(issue),但 issue 描述通常**不含**「用什么证据验证完成、卡住时停下报什么」的结构化契约——这正好是 OpenAI 强 Goal 的精华,且**可以低成本注入**(见 Part 3 的 status doc)。**有意为之的部分**:我们不想要 /goal 的「自主续跑到 done」——那跟 founder-only-authority + 「人在 milestone steer」冲突;我们要借的是它的**契约结构**,不是它的**自主循环**。

#### ④ self-ship durable marker 续跑 — vs Codex 自合并 + 证据完成

**现状**:见 2.0。关键是**证据驱动完成是系统级硬门**:`event-route.ts:643-740` 强制 `status=completed` 必须有 `landingStatus.status=merged` 证据;`verify-approval`(`wake.ts`)把批准**绑定到精确 `pr_head_sha`,不匹配 fail-closed**;evidence gap(approved 但无 merged 证据)打 `fly208_evidence_gap` marker。崩溃恢复:fail-close marker + 启动重放 + durable launch claim 防 re-spawn 竞态。

**对标 OpenAI**:Codex /goal 说「完成必须证据驱动」——但那是**prompt 级指令,模型自我执行**;Codex 还能**自合并**(用 token/签名)。
**判定:✅ 我们更强 + 有意更保守。** 我们把「证据决定 done」从 prompt 升级成**服务端不可绕过的闸**(这是 Flywheel 相对 OpenAI 玩法的最大结构性优势);并**故意不自合并**(branch protection + 无 push token + founder-only-authority)——在「大规模自治」的安全维度上,这比 Codex 自合并更稳。durable marker 续跑则覆盖了 Codex /goal 的 thread 状态续跑覆盖不到的**跨进程/跨 Bridge 重启**场景。

### 2.2 另外两轴:QA-fix loop + 并行

#### QA-fix loop — vs Codex Review→Repair→Validate

**现状**:Bridge 在 `pr_created` 注入 Codex code-review gate 指令(`event-route.ts:108-221`),Runner 跑 `/codex-code-review`、迭代到 Codex 返回 `APPROVED`、写 `.flywheel/runs/<execId>/codex/code-review.json`、再 `await-codex-gate`。design_review 阶段同理。
**缺口**(审计原文):**Bridge 不跟踪 round 数**;无机器可读 findings 在「相」之间的结构化交接;无逐轮 `record.json` 审计;无「收敛停滞 → 触发人工」的显式条件(靠 Runner 自己 loop)。
**对标 OpenAI**:repair loop 有 JSON 结构化交接 + 通常 3 轮上限 + delta 稳定 + 停滞→人工 + 逐轮 record.json。
**判定:🟡 可借鉴。** 我们有 review loop 的骨架(且用真 Codex 而非 self-judge,这点更强),但缺**有界性 + 可审计性**(round 计数 / record.json / 停滞升级)。

#### 并行 / fan-out

**现状**:多 Runner(每 issue 一个)+ 多 role(FLY-59,main+qa+...,各自 worktree+tmux 窗)+ worktree 隔离。
**对标 OpenAI**:/goal 是**单 thread**;OpenAI 这篇没强调 fan-out(FLY-400 的 Anthropic 视频才强调)。
**判定:✅ 我们更强。** Flywheel 的并行是结构性的,OpenAI 长任务这篇是单线程深跑。

### 2.3 三档总表

| OpenAI 技法 | Flywheel 现状(file:line) | 档 |
|---|---|---|
| 证据驱动完成(prompt 级) | **系统级硬门** evidence gate + pr_head_sha 绑定(`event-route.ts:643-740`,`wake.ts`) | ✅ 更强 |
| /goal 自主续跑 / 自合并 | **有意不做**:founder-only-authority + branch protection + 无 push token | ✅ 更保守(安全更强) |
| milestone 检查点 + 失败先修(批处理) | FLY-349 引擎 `checkpoint.py` 确定性持久状态机 | ✅ 更强(限批处理域) |
| 跨会话耐久目标 | Linear issue = 单一真相 + durable marker 续跑(跨进程/Bridge 重启) | ✅ 对齐+更强 |
| 并行探索 / fan-out | 多 Runner + 多 role + worktree 隔离 | ✅ 更强 |
| **4 文件项目记忆(活文档,会话内反复回看)** | **无**:Runner 被指示读仓内 CLAUDE.md(Blueprint 注入读取指令,非内容持久注入);无 Runner 维护的 status/plan/audit 活文档 | 🔴 缺口 |
| **mid-task 续跑(从检查点恢复)** | **无**:Runner 崩溃从整个 issue 重头跑(引擎层有、Runner 层没有) | 🔴 缺口 |
| **/goal 的契约字段(verification surface + blocked stop + iteration policy)** | issue 通常不含这些结构化字段 | 🔴 缺口(部分有意) |
| **Review→Repair→Validate 的有界+可审计**(round 计数 / record.json / 停滞→人工) | review loop 有骨架,但无 round 计数 / 逐轮审计 / 停滞升级 | 🟡 可借鉴 |
| context-compaction 存活(外化状态防漂移) | 无 Flywheel 级 compaction / PostCompact;信任 1M 原生窗口 | 🟡 可借鉴 |

---

## Part 3 — 可执行改进点

> 排序原则:杠杆 = 影响 ÷ 工作量。每条标注可转的 Linear issue 雏形。**贯穿主线:把已经在 FLY-349 引擎里验证过的 checkpoint 纪律,泛化到写代码的 Runner;借 OpenAI 的「活文档 + 证据契约」,但不借它的「自主续跑」(那跟我们的人类把关模型冲突)。**

### P1 — keystone(高杠杆,建议先做)

**A. 每个 Runner 维护一份「活状态文档」(Living Run Doc)= OpenAI 4 文件法的 Flywheel 版**
- 做法:Runner spawn 时在 worktree 建 `.flywheel/runs/<execId>/RUN.md`(或 `STATUS.md`),含四块(对应 Prompt/Plan/Implement/Documentation):**① 冻结规格**(issue 目标 + brainstorm 结论 + non-goals + 验收「done when」);**② milestone 计划**(每个 milestone 带验证命令 + 验收标准);**③ 执行约束**(scope 边界);**④ 滚动状态/决策日志/已知问题**。Runner 在**每个 milestone 后更新**它,**compaction 后 / resume 后先重读它**。
- 为什么是 #1:一举解决三件事 —— 防漂移(冻结规格)、context-compaction 存活(状态外化到文件)、async 可检查(Annie/Lead 不盯 pane 就能看进度)。这正是 OpenAI 点名的「最重要技法」,而我们目前唯一缺的就是这个「会话内活文档」层。
- 成本:中。主要是 prompt/Blueprint 注入 + 一个文件约定,无新基建。
- Linear 雏形:**「Runner Living Run Doc — 会话内活文档(spec/plan/status)+ compaction 重定向」**。

**B. mid-task 续跑:fresh Runner 从 RUN.md 恢复,不从头重跑**
- 做法:基于 A。Runner 崩溃/Bridge 重启后,新 Runner 读 `RUN.md` 的 milestone 状态,**跳过已完成 milestone**,从断点继续 —— 把 FLY-349 引擎 `checkpoint.py`(skip-done + 幂等 + retry cap)的纪律泛化到代码 Runner。
- 为什么:审计实锤「Runner 崩溃从整个 issue 重头跑」是当前最大的「长任务浪费」。25h 跑到 20h 挂掉重来 = 灾难。
- 成本:中(依赖 A 先落地);可复用引擎层已验证的 checkpoint 模式。
- Linear 雏形:**「Runner mid-task resume — 从 Living Run Doc 断点续跑(泛化 FLY-349 checkpoint 纪律)」**。

### P2 — 高价值跟进

**C. 把 Codex review loop 形式化成有界 + 可审计的 Review→Repair→Validate**
- 做法:review 每轮写 `.flywheel/runs/<execId>/codex/round-<n>.json`(findings + repair 摘要 + validate 结果);Bridge/Runner 跟踪 round 数;设**软上限(如 3 轮)**;**停滞(delta 不再缩小)→ 触发人工**(走现成 `ask`/gate 升级)。
- 为什么:当前 review loop 无 round 计数、无逐轮审计、无停滞升级,理论上能无限循环 / 静默卡住(已有「codex review death detection」follow-up,task #25)。
- 成本:中。复用现有 codex/*.json 约定 + gate 升级机制。
- Linear 雏形:**「Codex review loop 有界化 + record-per-round 审计 + 停滞→人工升级」**。

**D. milestone-based plan:write-plan / implement 强制颗粒化 milestone + per-milestone 验证命令**
- 做法:在 `write-plan` skill / implement 阶段约定:plan 必须列出**可在一个 loop 内完成的 milestone**,每个带**验证命令**(lint/typecheck/test/build)+ 验收标准;implement 时**每个 milestone 后跑验证、失败先修再前进**。落进 A 的「② milestone 计划」块。
- 为什么:我们有粗粒度阶段门(design_review/code_review),但 implement 内部没有「milestone→验证→修→下一个」的细循环。OpenAI 的 plan.md 正是这个。
- 成本:低-中(主要是 skill/prompt 约定)。
- Linear 雏形:**「write-plan/implement 强制 milestone + per-milestone 验证门」**。

### P3 — 轻量 / 战略记一笔

**E. context-compaction 重定向 hook(轻量,配 A)**
- 做法:给 Runner 一条指令/hook:任何 compaction 后,先重读 `RUN.md` 的冻结规格 + milestone 状态再继续。Anthropic 自己承认「多次 compact 后意图变弱」——外化状态 + 强制重读是最便宜的兜底。
- 成本:低(一条 prompt 约定 + 可选 PostCompact hook)。

**F.(有意不做,记录理由)不在 Runner 层加 /goal 式「自主续跑到 done」循环**
- 我们刻意要人在 milestone/merge 处把关(founder-only-authority + approve gate)。一个「无人值守持续续跑」的循环跟这个模型冲突,也跟「pr_handoff / human-gated ship」冲突。**要借的是 /goal 的契约结构(A/D 已覆盖),不是它的自主循环。** 这条写进文档是为了防止有人误把「抄 /goal」理解成「让 Runner 自己一直跑到合并」。

### 一句话给 Annie

> OpenAI 这套长任务方法,**一半我们已经做得更硬**(证据驱动 done 是系统级硬门、不自合并、跨进程崩溃恢复、并行)——这验证了 Flywheel 的核心赌注是对的。**真正值得抄的就一个**:把目标/计划/状态写进一份 Runner **会话内反复回看的活文档**(P1-A),它一举解决防漂移 + compaction 存活 + 断点续跑(P1-B)+ async 可检查。我们甚至已经在小红书引擎里证明了这套 checkpoint 纪律能跑——只是还没用到写代码的 Runner 上。

---

## 来源诚实分层

- **OpenAI 原文直述**(高置信):25h/13M token/30k 行实验;4 文件项目记忆(Prompt/Plan/Implement/Documentation.md);每 milestone 验证;`/goal` 的 6 要素 + 状态机 + 事件驱动续跑 + 证据驱动完成 + 预算≠完成(逐字出自 `using_goals_in_codex.ipynb`);Review→Repair→Validate 三相 + 通常 3 轮 + record.json(出自 `Build_iterative_repair_loops_with_Codex.ipynb`)。
- **抓取说明**:Annie 给的 `openai.com/index/...` URL 对自动抓取返 403;内容来自官方同源镜像(developers.openai.com 博客 + openai/openai-cookbook 仓的两个 notebook,均为 OpenAI 官方)。`openai.com/index/harness-engineering/` 同样 403,未纳入(非必需)。
- **对标推断**(Part 2/3):基于 Flywheel codebase 审计(file:line)+ CLAUDE.md/MEMORY.md。凡推断处在正文标注。
