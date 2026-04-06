# Exploration: Product Experience Deep Design — FLY-52

**Issue**: FLY-52 (Product Experience Deep Design — E2E User Flow Definition)
**Date**: 2026-04-03
**Status**: In Progress (Brainstorm)

---

## 1. Deep Research 总结

### 1.1 产品核心定位（从现有文档提炼）

Flywheel = **Annie 的私人 AI 开发团队**。

- **Annie**（老板）：设定方向、做关键决策、审批产出
- **AI Leads**（部门经理）：Peter（产品开发）、Oliver（运维）、Simba（参谋长/调度）
- **AI Runners**（工程师）：Claude Code sessions in tmux，执行具体编码任务
- **Discord**：办公室，所有沟通都在这里
- **Bridge**：基础设施（StateStore、Forum、审计、API）

**终极目标**：最小化 Annie 的注意力消耗 — Lead 能自己解决的就自己解决，只在真正需要人类判断时才 escalate。

### 1.2 现有架构（v1.x）

```
Linear issues → Bridge (Express API + SQLite StateStore)
                  → RunDispatcher → Blueprint → TmuxAdapter → Claude Code CLI (Runner)
                  → EventFilter → ClaudeDiscordRuntime → Discord control channel → Lead
                  → HeartbeatService → stuck/orphan detection
                  
Lead (Claude Code --agent) ↔ Runner: flywheel-comm (SQLite inbox/outbox)
Lead ↔ Annie: Discord (forum threads + chat channel)
Lead ↔ Lead: Discord (#geoforge3d-core text channel)
```

### 1.3 系统性问题（从 bug 模式提炼）

#### 问题 A：数据流在包边界断裂

FLY-24 案例：`issueTitle` 这一个字段需要穿透 5 层（EventEnvelope → DirectEventSink → StateStore → runs-route → RunDispatcher → Blueprint），6 个 commit 才修完。

**根因**：没有端到端的数据契约。每层对"我会收到什么参数"做了各自的假设，没有一个地方定义完整的数据流。

#### 问题 B：异步 fire-and-forget 竞态

ForumPostCreator 是 fire-and-forget 的。它可能在 EventFilter 读取 session 之前或之后写入 `thread_id`，导致同一个事件可能被分类为 "notify_agent" 或 "forum_only"。

**根因**：没有定义操作的顺序契约。

#### 问题 C：静默失败

多处 catch 块只 log warning 然后继续执行，导致问题隐藏到下游才爆发。

#### 问题 D：测试覆盖不均

| Package | 覆盖率 |
|---------|--------|
| core | ~29%（关键集成点未测试） |
| linear-event-transport | ~20% |
| flywheel-comm | ~50% |
| edge-worker | ~101%（好） |
| teamlead | ~96%（好） |

#### 问题 E：没有用户视角的文档

所有现有文档从系统视角写（"Bridge 调用 StateStore"），从未从 Annie 视角写（"Annie 看到什么、期望什么、等多久"）。

### 1.4 参考项目经验

| 项目 | 关键启示 |
|------|---------|
| **Ralph** | 极简编排（~100 LOC bash）、sentinel 完成信号、append-only learning log |
| **Auto-Claude** | 循环修复检测（Jaccard）、failure 分类 + 恢复决策树、recovery hint injection |
| **Cyrus** | Flywheel 的 fork 基础，覆盖 ~60% 需求（Linear fetch + session + PR flow） |
| **Agent Frameworks 2026** | 共识：managed memory、tool governance、tracing/evals 是 table-stakes |
| **Multi-Agent Best Practices** | Tool-driven > prompt-driven、避免 agentic monolith、specialize by role |

### 1.5 现有已定义的 User Flow

1. **Core Loop**: Linear issue → DAG → Blueprint → Runner → PR ✅ 基本能用
2. **Lead Phase 1 MVP**: Thread-based notifications + in-thread actions ✅ 部分实现
3. **Spin Pipeline**: brainstorm → research → plan → implement → PR → ship ✅ Manual skill
4. **Orchestrator**: Parallel multi-agent execution ✅ 实现但问题多
5. **Daily Standup**: 3AM cron → Lead 汇报 ✅ 实现

### 1.6 未定义的关键流程

- Annie 视角的完整交互体验（从给指令到看到结果）
- 错误情况下 Annie 看到什么、应该做什么
- Lead 自主决策的边界和 Annie 的可见性
- Multi-Lead 协调的具体用户体验
- Lead context window 溢出时的用户体验
- Runner 卡住/失败时的恢复流程（Annie 视角）

---

## 2. Brainstorm Q&A

> 规则：每个问题都从 Annie 的使用体验出发，不从系统实现出发。
> 答案会直接影响架构决策。

### Q1: 产品定位 — 你和 Lead 的关系模型

**背景**：这决定了 Lead 的行为模式（主动性、汇报频率、自主决策范围）。

**问题**：你跟 Lead 的关系，更像哪一种？

- **A）老板 ↔ 下属**：你给方向和决策，Lead 负责执行和汇报。你不关心执行细节，只关心结果。Lead 应该尽量少来烦你。
- **B）协作伙伴**：你和 Lead 一起讨论方案、一起解决问题。Lead 是你的 "thinking partner"，你希望它主动分享它看到的东西、提出建议。
- **C）工具 + 助手**：你给精确的指令，Lead 精确执行。你期望高可控性，不希望 Lead 有太多 "自主判断"。
- **D）混合模式**：在不同场景下是不同的关系。

如果是 D，请描述在什么场景下是哪种。

**Annie's Answer**: **D）混合模式，但有进化路径**：

- **Phase 1（协作伙伴）**：一开始更像 B。Lead 作为 thinking partner，主动分享想法、给出建议，一起讨论方案。
- **Phase 2（老板↔下属）**：随着 Lead 越来越清楚 Annie 想要的结果，关系过渡到 A。Annie 给方向和决策，Lead 负责执行和汇报，很少需要再来问意见。

**关键 implication**：Memory/learning 机制是产品核心能力，Lead 必须能从过往交互中学习 Annie 的偏好和决策模式，逐步减少需要确认的事项。这不是锦上添花，是产品定位的基础。

---

### Q2: 沟通节奏 — Annie 的一天

**背景**：这决定了通知策略、standup 时间、响应 SLA。

**问题**：描述你理想中跟 Flywheel 团队共事的一天：

- 你大概什么时候会看 Discord？（早上？随时？特定时间段？）
- 你希望一天被打扰几次？（0？1-2？随时都可以？）
- 当你不看 Discord 的时候，Lead 应该怎么办？（自己判断继续？全部暂停等你？积攒问题一次性问？）
- 你觉得一个 "理想的早上" 应该是什么样的？（打开 Discord 看到什么？）

**Annie's Answer**:

- **查看频率**：随时有空都会看 Discord，没有固定时间
- **早会流程（核心 flow）**：
  1. 凌晨 3AM：Simba 做 triage，看接下来一天做什么，跟 Peter/Oliver 讨论方案
  2. 早上：Annie 醒来查看方案，讨论确认
  3. Finalize 后：Lead 调用 Runner 执行 issue
  - **现状**：早会机制已有但不工作（3AM 什么都没跑）
- **被打扰频率**：现在随时都可以，有问题就来问。以后会自然减少，不需要硬性限制次数
- **Annie 离线时**：全部暂停等待。Annie 回来后问还有什么问题，逐一解决
- **理想的早上**：打开 Discord 看到 Simba 的 triage 结果 + Lead 讨论后的方案，Annie review 后 finalize，然后执行

**关键 implication**：
- 早会 flow（Simba triage → Lead 讨论 → Annie 审批 → 执行）是**日常核心流程**，必须可靠
- **不需要额外的 pending questions 队列** — Discord unread messages 本身就是队列。Lead 在 chat 中提问，Annie 回来看 unread 逐一回复即可
- 目前体验是同步的：Annie 是瓶颈（by design），Lead 不应在 Annie 不在时做重大决策

---

### Q3: Lead ↔ Annie 沟通 — 当前最大痛点

**背景**：你说这一块问题最大。我需要理解具体痛在哪里。

**问题**：能具体描述几个让你觉得 "这东西又出 bug 了" 或 "体验很差" 的场景吗？比如：

- Lead 没回复你？回复了但答非所问？
- Lead 汇报的信息不对？格式混乱？
- Lead 没有在你期望的时候通知你？
- 你给了指令但 Lead 没执行？或执行错了？
- 其他？

越具体越好，最好举真实发生过的例子。

**Annie's Answer**: 问题非常多，基本上什么错误都有。以下是从 Linear tickets + git history 中找到的具体问题：

#### 已修复但暴露出系统性问题的 bugs：

| # | Issue | 问题 | 严重度 |
|---|-------|------|--------|
| 1 | GEO-199 | **Lead 不回复 Annie 消息** — 发完通知后就不响应了，Annie 怎么问都没反应 | Critical |
| 2 | GEO-252 | **事件通知到不了 Lead** — Bridge 用错 bot token，消息投递到黑洞 | Critical |
| 3 | GEO-266 | **Lead 指令没有真正执行** — Annie 让 Lead 暂停 Runner，Lead 说"已暂停"，实际 Runner 根本没停 | Critical |
| 4 | FLY-25 | **关键告警静默丢失** — Runner 卡住了但 Lead 没收到通知（fire-and-forget delivery） | Critical |
| 5 | GEO-261 | **完成通知丢失** — Runner 成功出 PR 了但 Lead 没收到 session_completed | High |
| 6 | GEO-297 | **Lead 之间无法沟通** — Discord plugin 把所有 bot 消息过滤了 | High |
| 7 | FLY-24 | **没有创建 Forum Post** — Runner 启动后 Annie 看不到执行线程 | High |
| 8 | FLY-29 | **Typing 指示器不停** — Lead 不回复时 typing 一直显示，Annie 分不清在想还是断了 | High |
| 9 | GEO-283 | **Typing 指示器消失** — Lead 思考超过 10s 后 typing 消失，Annie 以为 bot 挂了 | Medium |
| 10 | GEO-285 | **Lead 忘记自己是谁** — context compact 后丢失身份和 channel 规则 | Medium |
| 11 | GEO-294/FLY-27 | **报告格式不一致** — Simba triage 每次从零生成 CSS，质量不稳定 | Medium |

#### 仍然 OPEN 的问题：

| # | Issue | 问题 | 严重度 |
|---|-------|------|--------|
| 12 | FLY-51 | **Runner 完成后 tmux 自动关闭** — Annie 无法查看 Runner 的执行输出 | Critical |

#### 系统性根因总结：

**Lead ↔ Annie 沟通从未被设计为双向可靠的。** 系统优先考虑 "把信息发出去"，而不是 "确保对方收到并可以行动"。具体表现为：
1. 消息投递是 fire-and-forget（投了就算成功，不管对方收没收到）
2. Lead 没有持续监听能力（通知完就断连）
3. 缺乏可靠的双向通道（Lead→Annie 勉强能用，Annie→Lead→Runner 整条链路断裂）
4. 没有定义"成功沟通"的标准（消息发了≠收到了≠理解了≠执行了）

---

### Q4: 任务派发 — Annie 怎么给活

**背景**：这决定了 Lead 如何理解和分解 Annie 的意图。

**问题**：你通常怎么给 Lead 派任务？

- **A）直接指定 issue**："Peter 跑 FLY-38"
- **B）描述需求**："Peter，我需要一个 cold start 脚本，让 Lead 重启后能自动恢复状态"
- **C）给方向**："Peter，Runner 经常卡住，想个办法解决"
- **D）以上都有**

对于每种方式，你期望 Lead 做什么？
- 直接执行？
- 先跟你确认理解？
- 先给你一个方案再执行？

**Annie's Answer**:

**不会直接指派 issue 给 Lead。** 正常流程是：

1. 创建 Linear issue（Annie 描述需求 → Lead 创建 issue）
2. Simba 做 triage（早会），确定优先级
3. Annie 确认后，Peter 抓取几个 issue 派发给不同 Runner 执行
4. 偶尔 Annie 会直接说 "Peter 跑某个 issue"，但这是例外

**Lead 的角色明确**：
- Lead 是**调度员/项目经理**，不是技术执行者
- Lead 不需要给方案 — 方案是 Runner 的事
- Lead 做的是：创建 issue、派发 Runner、跟踪状态、向 Annie 汇报
- Lead 不做 brainstorm、不写代码、不做技术决策

**新需求流程**：Annie 描述需求 → Lead 创建 Linear issue → 进入正常 pipeline（不会跳过 issue 直接让 Lead 去做）

**关键 implication**：
- Lead 的 prompt/agent 定义需要明确 "你是调度员，不是工程师"
- Lead 不需要理解技术细节，需要理解优先级、资源分配、沟通
- 现有的 agent.md 中可能有过多的技术能力定义，需要精简
- Runner 才是做 /brainstorm → /research → /write-plan → /implement 的角色

---

### Q5: 任务派发 — Lead 怎么分配给 Runner

**背景**：这是第二大痛点。

**问题**：当 Lead 决定要启动一个 Runner 去执行任务时，你期望：

- **A）完全自主**：Lead 自己决定什么时候启动、分配给谁、怎么跑。你只看最终结果（PR 或失败汇报）。
- **B）通知即可**：Lead 告诉你 "我准备启动 Runner 跑 FLY-38"，你不需要确认，但你知道发生了什么。
- **C）需要确认**：Lead 问你 "可以启动 Runner 跑 FLY-38 吗？"，你说 "好" 才跑。
- **D）取决于任务类型**：小 bug 自己跑，大 feature 先确认。

如果是 D，怎么定义"大"和"小"？

**Annie's Answer**:

**Lead 启动 Runner 时的通知机制（双轨）**：

1. **Forum 轨**：每个 issue 开始跑后，在 Forum 创建一个 post。中间重要的 status update 同步到 Forum post
2. **Chat 轨**：在 Chat 告诉 Annie "这个 issue 开始了" + Forum post link。中间有问题在 Chat 里问（是否同一个 thread 待定）

**Annie 在执行过程中必须参与**：

- Runner 不靠谱，Lead 也不靠谱，不能完全放手
- Runner follow /spin 流程，中间很多 interactive 步骤需要 Annie 回答
- **完全不是放手到出结果的模式**

**核心生命周期（Annie 视角）**：

```
Lead 启动 Runner
  ↓
Forum post 创建 + Chat 通知 Annie
  ↓
Runner 执行（/spin flow: brainstorm → research → plan → implement）
  ↓ （中间 Runner 有问题 → Lead 转达 → Annie 在 Chat 回答）
Runner 创建 PR
  ↓
⚠️ HARD GATE: Runner 必须停下来，通过 Lead 问 Annie 是否 approve
  ↓
Annie review PR（可能发现问题 → 让 Runner 修 → 再 review → loop）
  ↓
Annie 说 "OK, ship it"
  ↓
Runner 执行 ship PR（merge + CI）
  ↓
Runner 执行归档、清理等后续操作
  ↓
Runner 才可以被关掉（tmux 关闭）
  ↓
Lead 更新 status
```

**关键规则（已在 memory 中，不应重复问）**：
- PR merge 前必须 Annie approve — 没有例外
- Runner 不能在 Annie approve 前关掉 — 必须保持 tmux 开着等修改指令
- Lead 不能提前 shutdown — 等 Annie 确认 ship → 执行 merge + cleanup → 才 shutdown

**待定**：中间的 status update 是在 Chat thread 里告诉 Annie，还是 Annie 去 Forum post 看。

---

### Q6: 结果交付 — Annie 想看到什么

**背景**：Runner 完成后，Annie 需要看到什么才能做决策。

**问题**：当一个任务完成时（Runner 产出了 PR），你希望 Lead 怎么跟你汇报？

- 只说 "FLY-38 完成了，PR #123" ？
- 还是你希望看到：改了什么、为什么这么改、有什么风险、测试结果？
- 你会自己去看 PR diff 吗？还是你希望 Lead 帮你做 code review 的摘要？
- 你需要 Lead 给你一个 "建议"（approve/需要修改/需要讨论）吗？

**Annie's Answer**: 

---

### Q7: 失败处理 — Annie 的期望

**背景**：目前失败场景的处理是最混乱的部分。

**问题**：当 Runner 跑失败了（测试不过、代码写错、卡住了），你期望：

- Lead 自己先尝试修？试几次？（1 次？3 次？直到成功？）
- 什么时候应该来告诉你？（第一次失败就说？试了 N 次都不行才说？）
- 告诉你的时候，你希望看到什么信息？（失败原因？Lead 的分析？建议的下一步？）
- 你通常会怎么回应？（"再试一次"？"换个方案"？"算了先放着"？）

**Annie's Answer**:

**重试策略**：
- Runner 失败后可以自己重试，先分析问题再重跑
- 最多试 3 次，还不行就告诉 Annie
- 告诉 Annie 时需要说明：具体怎么失败的、为什么、之前做过哪些尝试、为什么还是失败

**新增架构需求：QA Agent（GEO-308）**

Annie 发现 Runner 自己写、自己测非常不科学，需要独立的 QA Agent：
- **原则**：自己写的代码不能自己测
- **GEO-308** 描述了 5-phase QA Agent：Analyst → Planner → Sentinel（质量门禁）→ Executor → Analyzer
- 关键设计：读 plan + OpenAPI spec 生成测试、regression 先跑、retry 基于上次失败调整而非全部重来、QA 只报 bug 不修 bug
- **Flywheel 需要支持这种 multi-agent 执行模式**：Lead 派发 Main Runner + QA Runner，两者协作

**更新后的执行生命周期**：

```
Lead 启动 Main Runner
  ↓
Runner 执行（brainstorm → research → plan → implement → PR）
  ↓
⚠️ QA Agent 独立测试 Runner 的产出
  ↓
QA 报告 → Lead 汇总 → 通知 Annie review
  ↓
Annie review PR + QA 结果
  ↓ （有问题 → Runner 修 → QA 重测 → loop）
Annie 说 "OK, ship it"
  ↓
Ship PR → cleanup → Lead update status
```

**关键 implication**：
- Flywheel 的 Runner 模型需要从 "单 Runner 执行" 扩展到 "Main + QA 协作执行"
- Lead 需要能编排多个 Runner 的协作流程
- QA Agent 的测试结果需要能影响 PR 是否可以 ship

---

### Q8: 可见性 — Annie 需要的 Dashboard

**背景**：这决定了我们需要建什么样的可视化。

**问题**：除了 Discord 消息，你还需要什么其他方式来了解团队状态？

- 你需要一个 web dashboard 吗？如果需要，你想在上面看到什么？
- 你需要 Daily Standup 吗？现在的 standup 格式有用吗？
- 你需要看到 Runner 的实时执行过程吗？（tmux 窗口）还是只看结果就好？
- 你需要成本/资源监控吗？（几个 Runner 在跑、CPU 占用等）

**Annie's Answer**:

- **Web Dashboard**：暂时不需要，Discord 够用
- **Session Monitor**：需要。想知道：
  - 现在有哪些 Session 在跑
  - 哪些 Runner 在跑
  - 它们对应哪个 Linear issue
  - 现在到什么状态了
  - **核心担忧**：很多 Session 可能一直卡在那里，Annie 不知道 → 需要卡住检测 + 通知
- **Daily Standup**：有用，保留
- **Runner 实时执行**：
  - 每次 Runner 开始跑时把 Terminal 打开就行
  - 大多数时候不需要看实时过程，只看**中间重要节点的汇报 + 最终结果**
  - Terminal 开着，Annie 想看就点进去，不想看就不管
- **资源监控**：需要，但是 advanced feature，之后再做

**关键 implication**：
- Session 状态概览可以通过 Lead 在 Discord 汇报实现（不需要单独的 dashboard）
- **卡住检测是刚需** — Lead 必须能发现 Runner 卡住并主动通知 Annie
- Terminal 自动打开功能已有（GEO-277），保持即可
- 中间节点汇报 = Lead 需要定义哪些是 "重要节点"（开始、PR 创建、QA 完成、失败、卡住）

---

### Q9: Multi-Lead 协调

**背景**：目前有 Peter（产品开发）、Oliver（运维）、Simba（参谋长）。

**问题**：

- 三个 Lead 的分工你满意吗？还是想调整？
- 当你在 #geoforge3d-core 说话时，你期望谁回应？（Simba 调度？被叫名字的那个？都可以？）
- Lead 之间需要互相沟通吗？（比如 Peter 完成了一个 feature，Oliver 需要部署它）
- 如果 Lead 之间有分歧（不太可能，但假设），谁做决定？

**Annie's Answer**:

**分工满意，清晰明确**：
- **Simba**：Chief of Staff + PM 角色，所有 Lead 的总 Lead
- **Peter**：产品开发 Lead
- **Oliver**：运维 Lead
- 未来会增加：Finance Lead、Marketing Lead 等。Simba 始终是总 Lead

**Core 频道回应规则**（已有定义，确认）：
- 没指定谁 → Simba 回应
- 指定了 Peter/Oliver → 被指定的人回应

**Lead 间沟通：需要，Core Room 就是为此而建**：
- Daily Standup：Simba 查看 issue → 跟 Peter/Oliver 商量 → 达成 finalized plan
- 跨部门协作：产品需要运维配合、运维需要产品协助 → 在 Core Room 互相沟通
- 模式：Lead 主动呼叫其他 Lead，明确彼此需要做什么

**多项目扩展**：
- 每个项目一套独立体系（自己的 Chief of Staff + 各 Lead）
- 不考虑跨项目共享
- Flywheel 作为基础设施支持多项目，但每个项目的 Lead 团队独立

**关键 implication**：
- Flywheel 需要支持 **N 个项目 × M 个 Lead** 的扩展模型
- Lead 间的沟通协议需要定义清楚（Core Room 的交互规范）
- Simba 作为总 Lead 有特殊权限：triage、跨部门协调、plan finalization
- 新 Lead 类型（Finance、Marketing）不一定需要调度 Runner，可能有不同的工具和职责

---

### Q10: 优先级和自主性边界

**背景**：Lead 应该有多大的自主决策权。

**问题**：以下哪些事情 Lead 可以自己决定，哪些必须问你？

| 场景 | 自己决定？问 Annie？ |
|------|---------------------|
| 选择哪个 issue 先跑 | |
| Runner 跑失败，决定重试 | |
| Runner 跑失败 3 次，决定放弃 | |
| 发现 issue 描述不清楚，自己补充细节 | |
| 发现两个 issue 有依赖关系，调整执行顺序 | |
| 发现一个 issue 太大，建议拆分 | |
| 合并一个低风险的 PR（只改了测试/文档） | |
| 合并一个改了核心逻辑的 PR | |

**Annie's Answer**:

**Issue 优先级和派发**：
- Simba triage 后确定优先级，分派给 Peter/Oliver
- 每人同时 3-5 个 issue 并行跑
- 依赖关系应该在 Simba 派发时就搞清楚；搞不清楚的在跟 Peter/Oliver 商量时对齐
- 派发后直接全开跑，不需要逐一确认

**自主性边界表**：

| 场景 | 决策权 | 说明 |
|------|--------|------|
| 选择哪个 issue 先跑 | ✅ Lead 自己决定 | Simba triage 后派发，依赖关系提前对齐 |
| Runner 失败，重试（≤3次） | ✅ Lead 自己决定 | 不用问 Annie |
| Runner 失败 3 次，放弃 | ❌ 必须问 Annie | 大概率不能放弃，重新试 |
| Issue 描述不清楚，补充细节 | ❌ 必须问 Annie | **绝对不要自己补充，想的都是错的** |
| 发现依赖关系，调整顺序 | ❌ 必须问 Annie | |
| Issue 太大，建议拆分 | ❌ 必须问 Annie | |
| 合并低风险 PR（测试/文档） | ❌ 必须问 Annie | |
| 合并核心逻辑 PR | ❌ 必须问 Annie | 更要问 |

**关键 implication**：
- Lead 的自主权非常有限 — 只有 "执行已确认的计划" 和 "失败重试" 可以自主
- **所有涉及判断的事情都要问 Annie** — 不能自作主张
- 这跟 Q1 的 Phase 1（协作伙伴）一致：现阶段 Annie 需要高度参与
- "绝对不要自己补充细节" 是硬规则 — Lead/Runner 对产品意图的理解不可信
- 未来 Phase 2 随着信任建立，部分决策权可能下放（但现在不是时候）

---

## 3. 深入问题（Q11+）

### Q11: 早会流程细节

**问题**：Simba triage 后怎么跟 Peter/Oliver 讨论？finalized plan 长什么样？Annie 在哪里看？怎么通知开工？

**Annie's Answer**：

全部在 Core Room 完成，不需要额外的结构化机制：
- Simba triage 完 → 在 Core Room @Peter @Oliver 讨论
- 讨论过程就在 Core Room 进行（已经做过了，格式没问题）
- Annie 醒来直接去 Core Room 看讨论记录和 finalized plan
- Annie 说 OK → Simba 在 Core Room 通知 Peter/Oliver 开工

**关键 implication**：
- **Core Room 是所有协调的中心** — 不需要额外的系统/dashboard/通知机制
- 早会流程完全基于 Discord 自然对话，不需要结构化的 API 调用
- 这意味着 Lead 间的沟通能力（bot-to-bot messaging）是基础设施级别的需求

---

### Q12: Runner 执行中的 Interactive 节点

**问题**：Runner 有问题时，是 Runner → Lead → Annie（Lead 做传话筒），还是 Runner 直接问 Annie？

**Annie's Answer**：

**A）Runner → Lead → Annie，Lead 做传话筒。**

Annie 没有时间跟每一个 Runner 说话。做这套系统就是因为需要 Lead 做统一入口，Annie 只跟 Lead 沟通。

**关键 implication**：
- Lead 是 Annie 和所有 Runner 之间的**唯一通信通道** — Annie 永远不直接跟 Runner 对话
- Lead 必须能准确转达双方的意图（不能丢信息、不能曲解）
- Lead 可能同时管理多个 Runner 的问题 → 需要能区分和跟踪每个 Runner 的对话上下文
- 延迟是可以接受的，但信息准确性不能妥协

---

### Q13: Lead 传话的方式

**问题**：Runner 有问题时，Lead 在哪里跟 Annie 说？Forum thread 还是 Chat？

**Annie's Answer**：

**双轨分离**：
- **Forum post thread**：重要节点 update（research 完成、plan 完成等），Lead 直接更新到对应 issue 的 thread 里。**不需要通知 Annie**，Annie 大多数时候不看，需要时自己去翻
- **Chat**：真正有问题需要 Annie 决策时，Lead 在 Chat 里问。多个 Runner 的问题都在 Chat 里统一问，说清楚是哪个 Runner/issue 的问题

**多 Runner 并行时**：Peter 在 Chat 里统一跟 Annie 沟通，标明 "Runner A 问了 XX" / "Runner B 问了 YY"，不需要分散到各自的 Forum thread

**关键 implication**：
- **Forum = 异步日志**（Lead 写，Annie 按需看）
- **Chat = 同步决策通道**（Lead 问，Annie 必须回答才能继续）
- Lead 需要有能力汇总多个 Runner 的问题，在一个 Chat 中清晰地呈现给 Annie
- Lead 的角色更像 Claude Code 的 Agent Team Lead — 汇总下属问题、统一向上汇报

---

### Q14: 标准化通知协议（Generic Pattern）

**背景**：Annie 指出这些通知行为应该是 generic 的，所有 Lead、所有 issue 都走同一套。

**Annie's Description**：

每次 Runner 开始跑一个 issue，都有一个标准流程：
1. **Forum 轨**（异步日志）：
   - Runner 开始 → 创建 Forum post
   - 中间重要节点 → update 到同一个 Forum post thread
   - 最终结果 → update
2. **Chat 轨**（同步通知）：
   - Lead 告诉 Annie："XX 开始跑了，Forum link 是 YY"
   - 有问题需要决策 → Lead 在 Chat 继续 update / 提问
   
这是**所有 Lead 的标准行为**，不因 Lead 身份或 issue 类型而变。

**关键 implication**：
- 这个通知协议需要被定义为 Lead 的核心行为规范，写入 common-rules
- Forum post 的生命周期 = issue 的执行生命周期
- Chat 通知的触发点需要明确定义（哪些节点通知、哪些只在 Forum 更新）

---

### Q15: 通知触发点定义

**问题**：哪些节点 update Forum？哪些在 Chat 通知 Annie？

**Annie's Answer**：

| 节点 | Forum update | Chat 通知 Annie |
|------|-------------|----------------|
| Runner 开始执行 | ✅ 创建 post | ✅ 告诉 Annie + link |
| Brainstorm 完成，需要 Annie 输入 | ✅ update | ✅ 在 Chat 问 Annie |
| Research 完成 | ✅ update | ❌ 不通知 |
| Plan 完成，需要 Annie review | ✅ update | ✅ 在 Chat 问 Annie |
| 实现开始 | ✅ update | ❌ 不通知 |
| PR 创建完成 | ✅ update | ✅ 在 Chat 告诉 Annie + 请求 review |
| QA 测试完成（通过） | ✅ update | ❌ 不通知 |
| QA 测试完成（失败） | ✅ update | ✅ 在 Chat 说 |
| Annie approve 后 ship 完成 | ✅ update | ✅ 在 Chat 确认 "已 ship" |
| **Runner 跑完了（整个 issue 完成）** | ✅ update | ✅ **在 Chat 告诉 Annie** |
| Runner 失败（重试中，≤3次） | ✅ update | ❌ 不通知 |
| Runner 失败 3 次 | ✅ update | ✅ 在 Chat 告诉 Annie |

**Chat 通知的核心原则**：需要 Annie 输入/决策 → Chat 通知；不需要 → Forum update 即可。

**补充细节**：
- Plan 完成后需要先跑 Codex Design Review，review 通过后再来 update/问 Annie
- QA 测试完成 → 在 Chat 同步 Annie "可以看结果了"
- Runner 跑完（issue 完成） → Chat 通知

---

### Q16: Forum Post 内容格式

**问题**：Forum post 创建时和 update 时的内容格式？

**Annie's Answer**：

**创建时（Runner 开始执行）**：
- ✅ Issue title + status
- ✅ Linear ticket link（附在里面，Annie 想看可以直接打开）
- ❌ Issue 描述（不需要，有 Linear link 就够了）
- ❌ 执行计划、预估时间（不需要）
- ⚪ Runner ID（暂时不需要，以后可能用到，可以保留）

**中间 update**：
- 每完成一个阶段（brainstorm/research/plan），如果已经 commit & push 到 PR 了，附上 **GitHub link** 指向那个 doc
- 让 Annie 能直接点开看 doc 内容
- 这是 nice-to-have，不是现在最重要的

**关键 implication**：
- Forum post 保持简洁：title + status + Linear link
- 中间 update 的价值在于提供**可直达的链接**（Linear、GitHub），不是文字描述
- Lead 需要知道怎么构造 GitHub link（branch + file path）

---

### Q17: Lead 自身的可靠性

**问题**：Lead 挂了（crash、context 爆、断连）时，Annie 期望什么？

**Annie's Answer**：**A）自动恢复。** Lead 自动重启，恢复之前的状态，继续工作。

**关键 implication**：
- Lead 需要 crash recovery 机制（已有 GEO-285 的 supervisor + bootstrap，但需要稳定可靠）
- Lead 重启后必须能恢复：正在管理的 Runner 列表、待回答的问题、进行中的对话上下文
- 这是基础设施级别的要求 — Lead 挂了不应该需要 Annie 干预

---

### Q18: "做好了" 的定义 — Annie 理想中的一天

**Annie's Answer**（想到哪说到哪，不一定完整）：

#### 理想的一天

**早上醒来**：
- Core Chat 里 Simba 和其他 Lead 已经讨论好了今天的 plan
- Annie 看了觉得没问题，他们就分头开始，不同 Lead 让不同 Runner 跑 issue

**执行过程中**：
- 所有 issue 的 Terminal 会在 Annie 电脑上打开（可以看，大多数时候不看）
- 重要状态在 Forum post 持续 update（开始、结束、中间节点）
- 有问题需要 Annie 决策时，Lead 在 Chat 里跟 Annie 交流

**Lead 完成分配的 task 后**：
- Lead 问 Simba "这些都做完了，还有什么新的？"
- Simba 继续 triage，Lead 接新 task
- 形成持续的执行循环

#### ⚠️ 关键纠正：Lead 不是传话筒

**Annie 明确要求：不要把 Lead 写成一个只会传话的 "小瓜"。Lead 是一个活灵活现的真正的 Lead。**

Lead 的角色是**全能型部门经理**，而不是调度员：
1. **能做决策**：随着时间推移，Lead 应该能自己回答越来越多 Runner 的问题，决定产品走向和技术走向
2. **有 Memory**：Lead 需要从过往交互中学习 Annie 的决策模式，逐步减少问 Annie 的频率
3. **有 Codebase Context**：Lead 能看到所有代码，特别是自己负责领域的代码
4. **灵活通用**：Annie 可能随时问各种灵活的问题 — 创建 issue、triage、关/开 terminal、debug、解决问题
5. **能下场**：有时 Lead 自己需要下场 debug、解决问题，不是什么都推给 Runner

**agent.md 必须保持 generic** — 不能写死成只做调度的角色。Lead 本质上是一个有能力、有判断力的部门负责人。

> ⚡ 这跟 Q4 "Lead 是调度员" 的简化理解有冲突 — **正确的理解是：Lead 在任务派发这个具体场景下是调度员，但整体上是全能型 Lead，有能力也被期望做很多事情。**

#### Runner 执行的原子性

Runner 必须走完完整的 /spin flow，不能中途退出：
1. brainstorm → research → plan → implement → PR
2. PR 创建后 **必须停下来等 Annie approve**
3. Annie approve 后才 ship PR
4. Ship 完成后才做 archive、cleanup、shutdown
5. 整套 flow 是**原子化的完整 workflow**

#### QA/Test Agent

已在 GEO-308 描述。Runner 自己写、自己测不科学，需要独立的 QA Agent 来验证改动是否正确。减少 "每个东西都需要 Annie 来判断是否正确" 的负担。

#### 资源与扩展

**短期（现在）**：
- 单机运行，有性能瓶颈
- 需要 monitoring：内存、CPU、GPU 状态
- 需要知道 "现在还能跑多少 issue" → 用于调度决策

**中期/长期（跑通之后）**：
- Multi-machine / 云端执行
- 一台电脑带不起太多 Runner
- 设计上需要考虑 scale 的可能性（不需要现在实现，但架构不能堵死）

#### 需要深入讨论的 Topic

Annie 明确指出以下两个 topic 值得单独深入讨论：
1. **Lead Memory 机制** — 怎么学习、怎么积累、怎么影响决策
2. **Lead 决策模型** — 什么时候自己决定、什么时候问 Annie、怎么逐步提升自主性
3. **Simba 的角色定义** — 不是傻瓜 PM，是真正的 Chief of Staff

#### Simba 同样适用 "不要写成傻瓜" 原则

**Annie 明确要求**：Simba 也不是一个只会做 triage 的傻瓜 PM。

- Simba 要保持 **generic**，能进化
- Simba 要有自己的 **Memory**
- Simba 要像一个**真正的 Chief of Staff** — 有判断力、有全局视野、能协调、能决策
- 跟 Peter/Oliver 一样，agent.md 不能写死成只做 triage 的工具人

**所有 Lead（Peter、Oliver、Simba、未来的 Finance Lead、Marketing Lead）的共同原则**：
- 保持 generic，不写死角色
- 有 Memory，能学习
- 像真人一样有判断力，能成长
- 现在需要多问 Annie（Phase 1），但目标是逐步自主（Phase 2）

**项目模板化**：
- 当前的 Simba/Peter/Oliver 结构是 GeoForge3D 的实例
- 未来每个新项目都会有类似架构：1 个 Chief of Staff + N 个 Department Leads
- 具体 Lead 角色（Product/Ops/Finance/Marketing）根据项目需求而定
- 先不考虑跨项目共享

---

### Q19: Lead 学习的来源

**问题**：Lead 从哪里学习 Annie 的决策偏好？

**Annie's Answer**：**D）以上全部**
1. 跟 Annie 的所有对话
2. 观察 Annie 的行为（approve/reject/修改）
3. Annie 主动教的东西

三个来源都重要，没有明确的优先级区分。

---

### Q20: Lead 学到的东西怎么体现？

**问题**：Lead 学到偏好后怎么应用？

**Annie's Answer**：**C）取决于信心**。

- 高信心（多次观察到一致行为）→ 自动应用，不问 Annie
- 低信心（不确定）→ 先问 Annie 确认

**关键 implication**：
- 这正好是 CIPHER 引擎的设计理念 — Beta-Binomial 统计 + 信心区间
- 需要定义 "高信心" 的阈值（CIPHER 用 50+ samples + 90% confidence）
- Lead 自动应用时应该是 transparent 的 — 事后 Annie 应该能看到 Lead 做了什么决定、基于什么

---

### Q21: Lead 自动决定后的透明度

**问题**：Lead 高信心自动做了决定，Annie 需要知道吗？

**Annie's Answer**：**C）每次都在 Chat 里告诉我。**

**关键 implication**：
- 即使是高信心自动决策，Lead 也必须在 Chat 通知 Annie
- Annie 现阶段需要完全的可见性 — 不存在 "悄悄做了就行" 的决策
- 这跟 Q1 的 Phase 1（协作伙伴）一致：先建立信任，Annie 全程可见
- 未来信任建立后，可能降级为 B（Forum 记录）或 A（不通知），但现在是 C

---

### Q22: Lead 做错决定后的纠正方式

**问题**：Lead 自动做了错误决定，Annie 怎么纠正？

**Annie's Answer**：**B）告诉它做错了 + 解释为什么。**

**关键 implication**：
- Lead 的学习模型必须支持 **因果推理**，不只是 "对/错" 的二元标签
- Memory 需要存储：决定是什么 + Annie 的纠正 + **为什么错了**
- 这意味着 CIPHER 的 `decision_reviews` 表需要扩展：不只是 approve/reject，还要有 reasoning 字段
- Lead 下次遇到类似场景时，应该能 recall "上次这么做了但 Annie 说不对，原因是 XX"

---

### Q23: Lead Memory 的边界

**问题**：有没有不希望 Lead 记住/学习的东西？

**Annie's Answer**：

**不应泛化的内容**：
- 心情不好时做的极端判断 → 不应成为长期原则
- 特殊情况下的例外决定 → 不应泛化到一般场景
- 但怎么判断"这是例外还是新规则" → 是一个开放问题

**跨 Lead 隐私**：
- 理论上没有不能共享的场景，不是大问题

**敏感数据过滤（真正的硬需求）**：
- mem0 里**不应该**存储：PII、信用卡信息、API Token 等敏感内容
- 需要有过滤机制，在写入 memory 之前检测和移除敏感数据

**关键 implication**：
- Memory 写入需要 **PII/secret 过滤层** — 在 mem0 add 之前检测敏感内容
- "例外 vs 新规则" 的判断可以用 CIPHER 的统计方法缓解 — 单次偏离不会改变统计分布，需要多次一致行为才会形成 pattern
- 当 Lead 发现 Annie 的行为跟以往 pattern 不一致时，**Lead 应该主动问**："这是你的新标准，还是这次的特殊情况？"
- Annie 说 "新标准" → 更新 memory/pattern
- Annie 说 "特殊情况" → 不更新，标记为 exception

---

### Q24: Lead 决策权的扩展路径

**问题**：什么条件下愿意给 Lead 更多决策权？

**Annie's Answer**：**B + C + D 的组合。**

- **准确率**：Lead 的决定跟 Annie 一致率够高
- **感觉**：Annie 主观觉得它靠谱了
- **按场景逐步放**：先放小的（test-only PR），观察没问题再放大的

**关键 implication**：
- 不是一刀切的 "Phase 2 开关"，是渐进式的、按场景的权限扩展
- 系统需要跟踪每个 **场景类型** 的准确率（不是总体准确率）
- 需要有机制让 Annie 显式 "解锁" 某类决策权（比如 "以后 test-only PR 你自己 approve 就行"）
- "感觉" 意味着不能纯靠数字 — Annie 可能在数据还不够时就觉得可以放手，也可能数据够了但还是不放心
- CIPHER 的 maturity levels（exploratory → tentative → established → trusted）可以作为参考指标呈现给 Annie，但最终决定权在 Annie

---

### Q25: Lead 的 Codebase 理解程度

**问题**：Lead 需要对 codebase 理解到什么程度？

**Annie's Answer**：**A）架构级别。**

知道哪些模块在哪、大致做什么、依赖关系。不需要读具体代码。

**关键 implication**：
- Lead 不需要深入代码细节 — 技术判断和实现是 Runner 的事
- Lead 的 codebase context 可以是精简的架构概览（CLAUDE.md + 模块结构），不需要 load 具体源码
- 这对 context window 管理是好消息 — Lead 不需要为了理解代码而消耗大量 context
- 架构知识可以写入 Lead 的 memory 或 common-rules，不需要每次从代码中读取

---

### Q26: Runner 执行流程（/spin）确认

**现有 /spin 流程**：
```
Step 0: Onboard（读 issue + CLAUDE.md + 创建 worktree）
  → Brainstorm（interactive，Annie 必须 approve）
  → Research
  → Plan → Codex Design Review
  → Implement（含 Codex Code Review）
  → Ship（archive → :cool: CI merge → bookkeeping → cleanup）
```

**Annie 的确认 + 补充**：
- 流程大概率不需要变，只是把 "Runner 直接问 Annie" 改成 "Runner → Lead → Annie"
- /compound 目前不在 spin 里 — 待定是否加入
- Onboarding 有（Step 0）

---

### Q27: QA Agent 在流程中的位置

**Annie 提供了 Mermaid 流程图**（/tmp/geo308-qa-flow.mmd）：

**QA Agent 介入时机**：PR 创建 + Codex Review 之后，Annie review 之前（即 **B 的变体**）

**完整流程（Main Agent + QA Agent 并行）**：

```
Main Agent（自己的 worktree）:
  实现新功能 → 创建 PR → Codex Review → Pre-merge 🧪
    → 等 QA 结果
      → QA 报 bug → 修 bug + push → 继续等
      → QA PASS → 等 Annie ship 审批

QA Agent（独立 worktree）:
  Step 1: Onboard — 读 main agent plan + qa-context.md
  Step 2: 分析 + 计划 — 分类改动类型 → 写 test spec → Sentinel 质检
  Step 3: Research（可选）— 读 OpenAPI spec、历史经验
  Step 4: 写 + 跑测试 — ad hoc tests → 迭代循环直到全 PASS
    → bug → 通知 main agent 修
    → 全 PASS →
  Step 5a: 更新 skill 文件 → push 到 main agent branch
  Step 5b: 跑回归测试 — 验证新旧 test case 都过
  Step 5c: 收尾 — 更新 qa-context.md → 归档
```

**文件系统交互**：
- `qa-context.md`：QA Agent 读写，跨 session 积累测试知识
- `test-reports/`：QA 测试报告
- skill SKILL.md：QA 永久更新测试 skill

**关键 implication**：
- QA Agent 是独立 worktree，不在 Main Runner 的 session 里
- QA 发现 bug → 通知 Main Agent 修 → 修完后 QA 重测 → 形成循环
- QA PASS 是 Annie review 的前置条件
- Lead 需要能编排这个 Main + QA 的协作循环

---

### Q28: Lead 管理 Main + QA 的协作

**问题**：Lead 在 Main + QA 协作中的角色？

**Annie's Answer**：**B）Lead 做中间人。**

**已有设计确认（GEO-308 qa-parallel-executor.md）**：
- QA Agent 所有结果通过 `SendMessage` 发给 Lead
- QA 发现 bug → Lead 转给 Main Agent → Main 修完 → Lead 发新 SHA 给 QA
- QA PASS → Lead 获得 qa_result artifact → Lead 通知 Annie review
- Lead 对全过程保持了解

**这与 Claude Code Agent Team 的协调模式一致**：Lead 是 team coordinator，所有 worker 间通信经过 Lead。

**Flywheel 需要支持的能力**：
- Lead 能启动 Main Runner + QA Runner（两个独立 worktree）
- Lead 能在两者之间传递 SHA、bug report、fix notification
- Lead 能判断何时 QA 循环结束（qa_result = PASS）
- Lead 能在 QA PASS 后触发通知 Annie 的流程

---

### Q29: Discord 消息格式偏好

**问题**：Lead 消息的格式偏好？

**Annie's Answer**：**C）信息清楚就行，不要结构化卡片。**

- 更喜欢像跟真人说话的感觉
- 不要规定死消息必须长什么样
- **反感结构化模板** — Lead 不是机器人发通知，是人在跟你说话

**关键 implication**：
- Lead 的消息风格应该是**自然语言对话**，不是格式化的 status report
- 不要在 agent.md 里规定消息模板 — 让 Lead 用自然的方式表达
- 这跟 "不要把 Lead 写成传话筒小瓜" 一脉相承 — Lead 是活人，不是通知系统
- 但信息要完整（该有的 link、status、问题 要包含），只是表达方式要自然

---

### Q30: Lead 的语言

**问题**：Lead 用什么语言？

**Annie's Answer**：

| 场景 | 语言 |
|------|------|
| 跟 Annie Chat | 中文 |
| Forum post update | 英文 |
| Lead 之间沟通 | 随意，怎么方便怎么来 |
| Lead 跟 Runner 沟通 | 随意 |

**未来产品化考虑**：Chat 语言应该是 **configurable** 的（per-project 或 per-user 配置），但现在不是优先级。

---

### Q31: 边界问题

**31a）Runner 权限边界**：

Runner 基本没有太大的权限限制：
- ✅ Push 到 feature branch（用 worktree 隔离）
- ❌ 直接 merge PR（需要 Annie approve）
- ✅ 修改 CLAUDE.md
- ✅ 删文件、改 CI 配置
- **唯一硬边界**：修改限制在当前 repository 内，不要乱改其他地方。要改其他地方需要问 Annie。

**31b）并发 Runner 数量**：

单机目前大概能支持 **~10 个 Runner** 同时跑（包括 idle session）。具体上限需要实际测试。

**31c）Runner 跑太久**：

让 Lead 去看一下是什么情况，判断是否需要介入。不是直接 kill，而是 Lead 先诊断。

---

---

### Q32-Q35: 从 Linear Issue 分析发现的遗漏

通过分析所有 150 个 Flywheel 相关 Linear issue，发现以下我们没讨论到的重要 topic：

#### 待讨论的遗漏点

**32）成本/预算模型**：
- **Annie: 现在暂时不考虑成本**，能跑就跑
- 多个 issue 涉及 token budget、circuit breaker budget，但不是当前优先级
- 未来产品化时再考虑

**33）Context Window 管理**：

**Annie's Answer**：
- 还没开始真正用，不确定 auto-compact 会怎么样
- Lead 需要记住的事情其实没那么多（聊天 + 管理几个 Runner），context 消耗目前不大
- **但 Lead 设想是 24/7 不间断跑**，某个时间点一定需要做 context switching
- Claude Code 已有的 auto-compact 功能应该还不错
- 需要调研：Claude Code 现在的 Memory 功能有哪些可以 leverage？
- 外挂 mem0 Memory 是否需要在每次 auto-compact 后重新注入？需要看 Claude Code 源码确认它现在怎么处理
- **这个需要做 research**，不是现在就能回答的产品问题
- Claude Code 源码在 `/Users/xiaorongli/Dev/claude-code`，可直接研究 auto-compact + memory 实现

**34）安全 — Memory 中的敏感数据**：
- FLY-39: Secret Scanning for Memory（已创建 issue，Urgent）
- Q23 已讨论 PII 过滤，但 issue 中更具体：credential、API token 泄漏风险

**35）参考的外部项目**：
- **AgentsMesh**: daemon pattern for distributed execution（FLY-7 Remote Runner）
- **mem0**: Lead 长期记忆系统（已采用）
- **Claude Code internals**: 状态检测、memory extraction、context compaction、shutdown protocol
- 风险：紧耦合 Claude Code 内部实现，upstream 变化可能导致 break

---

## 4. Architecture Gap Analysis

对比产品体验需求（`doc/architecture/product-experience-spec.md`）vs 现有架构，结果如下：

| 产品需求 | 状态 | 根因 |
|---------|------|------|
| 早会流程（Simba triage → 讨论 → Annie 确认 → 执行） | ⚠️ 部分 | Simba agent 不存在；无自动化 triage |
| Lead ↔ Annie 沟通（Forum + Chat 双轨） | ✅ 可用 | 基础设施完整 |
| Runner 执行（/spin + Lead 管理） | ⚠️ 部分 | Lead 转达/inbox 逻辑缺失 |
| QA Agent 协作 | ❌ 缺失 | 未实现 |
| Lead Memory + CIPHER 学习 | ⚠️ 部分 | 基础设施完整；行为规则缺失 |
| Multi-Lead 协调（Core Room） | ❌ 缺失 | Simba agent 缺失；无 Core Room 逻辑 |
| Lead 可靠性（crash recovery） | ⚠️ 部分 | Bootstrap 存在；session resume 未实现 |
| Task 持续循环 | ❌ 缺失 | 无 Simba polling/分配逻辑 |
| Runner stuck 检测 | ⚠️ 部分 | 设计完成；circuit-breaker hook 未实现 |
| Forum + Chat 通知联动 | ⚠️ 部分 | 零件都有；Lead 编排逻辑缺失 |

### Gap 的根因分类

- **70% 是行为层（Lead identity.md）**：基础设施已建好，但 Lead 不知道自己该做什么
- **20% 是已设计未实现的功能**：FLY-9 circuit breaker、FLY-8 session resume
- **10% 是新功能**：QA Agent 编排、Simba triage 逻辑

---

## 5. Decision: Refactor vs Rewrite

### 结论：**在现有架构上补全，不需要推倒重来。**

**理由**：
1. **基础设施层（Bridge、StateStore、Discord、flywheel-comm、mem0、CIPHER）全部可用** — 这是 80% 的工作量
2. **数据流和集成点虽然有 bug（FLY-24 类型），但架构本身是对的** — 需要的是更严格的数据契约，不是重新设计
3. **最大的缺口是 Lead 的行为定义** — 这不是架构问题，是 "Lead 还不知道自己该做什么" 的问题
4. **v2.0 plan（FLY-31）的方向正确** — 两条并行 workstream（Runner 可靠性 + Context 智能）对齐了 gap

### 具体行动

**Phase 1（立即）**：
1. 完善 Lead identity.md — 把产品体验 spec 中的行为规范转化为 Lead 的规则
2. 创建 Simba agent — triage + 跨部门协调
3. 实现 FLY-9 circuit breaker

**Phase 2（4-5 月）**：
1. FLY-8 session resume
2. Lead 问题转达逻辑（Runner → Lead → Annie 链路）
3. QA Agent 编排
4. Task 持续循环

**Phase 3（5-6 月）**：
1. 早会完整自动化
2. CIPHER 驱动 Lead 决策
3. Phase 2 自主权扩展
4. 全链路集成测试
