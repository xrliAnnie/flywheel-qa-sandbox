# Exploration: Project doc-flow baseline — RPCI 文档管理作为 Flywheel 新项目可选标配 — FLY-205

**Issue**: FLY-205 (Project doc-flow baseline — RPCI 文档管理作为 Flywheel 新项目可选标配(含已有项目补装))
**Date**: 2026-06-04
**Status**: Complete（审计 + 5 轮 brainstorm 收口，结论见 Part C）

---

## Part A — 现状审计（实测，非印象）

### A.1 GeoForge3D doc 树现状

**规模**：`product/doc/` 共 653 个文件，其中 495 个 `.md`。

**部门树**（每部门 md 数）：

| 部门 | md 数 | stage 子目录 |
|------|------|-------------|
| backend | 167 | exploration/{archived,backlog,new}, research/{archived,new}, plan/{archived,backlog,draft,new}, feedback/{claude,codex,gemini}, backlog |
| frontend | 102 | exploration, issues, plan/{**archive,archived**,draft,new}, research, test-reports |
| designer | 78 | exploration, **handoff**, plan, research, **spec**, **assets**（设计部门多 3 个独有 stage）|
| archive(根级) | 58 | 史前文档堆（Cursor 时代，命名带空格）|
| orchestrator | 26 | diagnostics, feedback, plan/{archived,backlog,draft,inprogress}, prompt |
| product | 23 | exploration, feedback, output, research（**没有 plan 目录**）|
| qa | 23 | exploration, plan/{archived,draft,inprogress,new}, research, test-reports — **research/new、plan/draft/new/inprogress 全部为空**（结构建了没用上）|
| retro | 11 | 平铺 |
| architecture / legal | 1+1 | 平铺 |

**命名混乱实测**（495 个 md 按文件名分类）：

| 模式 | 数量 | 例子 |
|------|------|------|
| `v{X.Y.Z}-` 前缀 | 220（其中 **159 个不含 GEO id**）| `v1.3.4.5-implementation-summary.md` |
| `GEO-{N}-` 前缀 | 109 | `GEO-333-char-limit-backend.md` |
| 数字序号前缀 | 37 | `001-...` |
| 文件名带空格 | 21 | `Stage 4 Cursor Plan & My Plan.md` |
| 其他（无前缀）| 108 | `handoff.md`, `direction-a.md`, `HMAC_ISSUE_SUMMARY.md` |

**结论：issue 号是唯一稳定主键的判断成立** —— v 前缀文件 72% 根本没有 issue id，无法回溯；带 GEO id 的文件无论目录怎么挪都能定位。

**结构级不一致**：
- `frontend/plan/` 下 **`archive/` 和 `archived/` 两个目录并存**（1 个文件在 archive，几十个在 archived）。Flywheel 自己用 `archive/`，GeoForge3D 主体用 `archived/` —— 两 repo 间也不一致。
- 同名文件跨 stage 重复 15+ 例（`GEO-308-stub.md` 同时在 exploration 和 research；`v3.32.1-GEO-308-dynamic-qa-v2.md` **同时在 plan/draft 和 plan/new**）—— promotion 是 copy 不是 move，状态产生二义。
- 各部门 stage 子目录集合各不相同（product 没 plan，designer 多 spec/handoff/assets，orchestrator 多 prompt/diagnostics）。

**De-facto 模板**（抽样 3 stage 真实文档）：

- **Exploration**（`GEO-333`，151 行）：`# Exploration: {title}` + 粗体字段（Issue/Domain/Date/Depth/Mode/Status）+ 编号 sections（0. Product Research → 1. Affected Files → 2. Architecture Constraints …）
- **Research**（`GEO-388`，96 行）：**两种元数据格式并存** —— GEO-388 用 YAML frontmatter（status/issue/domain/exploration），GEO-333 系用粗体字段。正文 = Problem → Root Cause → 实测事实。
- **Plan**（`GEO-306`，637 行；`GEO-335`，209 行）：header 粗体字段（Goal/Architecture/Research doc/Linear Issue/Status/Codex Review 轮次）+ Scope Boundaries + Mermaid gantt + phase 分解。

**冗余点（与 Linear 重复）**：
1. frontmatter 里 Issue id / title / date / Linear URL / priority —— Linear 全有。
2. **状态三重记账**：目录位置（`plan/new/`）+ frontmatter `Status: codex-approved` + Linear state，三处要手动同步，实测经常脱节（draft 和 new 同时存在同一文件）。
3. Codex Review 轮次记录写在 plan header（"Round 1 — CHANGES REQUESTED (6 issues)…"）—— 审计价值有，但 PR/issue comment 里也有一份。
4. 文档体内 `**Research doc:**` 相对路径引用 —— 文件被 git mv 进 archived 后引用全部断链（实测 GEO-306 plan 引的 research 路径已不存在于 `research/`，在 `research/archived/`）。

**文档量级**：exploration ~150 行、research ~100 行、plan 200-1000 行。

### A.2 Flywheel Runner 提示词管线（注入点全图）

**关键发现：有两套并存的提示词世界，生产用的是第二套。**

**世界 1 — Cyrus 遗产（Linear webhook 路径，生产基本不走）**：
- `packages/edge-worker/prompts/*.md`：builder(191行)/debugger(128行)/scoper(95行)/orchestrator(290行)/graphite-orchestrator(362行) + `standard-issue-assigned-user-prompt.md`（issue 上下文模板）。
- 路由：`PromptBuilder.determineSystemPromptFromLabels()` —— issue label 匹配 `repository.labelPrompts.{debugger|builder|scoper|orchestrator}`（`~/.flywheel/config.json` EdgeConfig per-repository），命中加载对应 `.md` 做 system prompt；`orchestrator` label 是硬编码兜底。
- 内容：纯 Cyrus 风格（"Task orchestrator" 模式），**grep 全部 5 个模板，零 RPCI / brainstorm / research / plan 字样**。
- 钩子：`promptTemplatePath`（user prompt 模板覆盖）、`appendInstruction`（追加 `<repository-specific-instruction>`）。

**世界 2 — 生产路径（Lead spawn Runner 实际走的）**：
```
Lead → POST /api/runs/start (runs-route.ts)
     → RunDispatcher → Blueprint.run() (edge-worker/src/Blueprint.ts)
     → system prompt 内联拼装（L416-680）→ tmux Claude Code session
```
- **基础 system prompt 内联硬编码 6 步**（L419-425）：`1. Read codebase → 2. Implement TDD → 3. branch+commit → 4. PR → 5. CI → 6. wait` —— **没有任何 B/R/P 阶段**。
- **stage 遥测已存在**：`flywheel-comm stage set <stage>`，合法 stage 枚举 = `brainstorm, research, plan, design_review, implement, test, code_review, pr_created, approve, ship, completed`（GEO-292）。但 prompt 明说 "skip stages that don't apply" —— **跳不跳是 Runner 自己判断，没有 Lead 判断这一环**。
- **checkpoint gate 已存在**（FLY-47）：`.flywheel/config.yaml::checkpoints` 注入 brainstorm / question / approve_to_ship 三种 gate（brainstorm gate 阻塞到 Lead 确认）。Blueprint 只特判这三个名字。
- **agent.md 机制已存在**（FLY-137 v1.27.2 / GEO-274）：
  - 项目声明：`.flywheel/config.yaml::agents.{name}.agent_file` → `.flywheel/agents/<dept>/<file>.md`（或顶层 catch-all）+ `match.labels` + `default_agent`。
  - 调度链：Lead 显式 `agentName` override → label 匹配（先部门子目录再顶层）→ `default_agent` → **shipped 兜底 `<flywheel-repo>/agents/generic-executor.md`**。
  - 注入方式：agent 文件内容作为 `## Agent Role` **前置**在基础 system prompt 之前（40KB 截断），`domain_file` 可加注领域知识。
  - **这就是 issue 共识 #4 说的 "Agent Tag → agent.md" 机制，已经在生产**（sub 的 content-executor.md 就是这么跑的）。
- **SkillInjector 已存在**：spawn 前向项目 `.claude/skills/` 写入 SKILL.md 模板（test/lint/build 命令），git exclude 处理好了 —— **是现成的"向项目注入 skill 文件"通道**。

**对 team-lead 初查结论的核对**：
- ✅ 无 superpowers：全仓 grep（packages/ + apps/，排除 node_modules）零命中。
- ✅ label 模板（builder/debugger/orchestrator）是 Cyrus 遗产、无 RPCI。
- ⚠️ **一个重要 nuance**：shipped 兜底 `agents/generic-executor.md`（92 行）**已经写了** "Skills you can assume exist: brainstorm / research / write-plan / implement / codex-design-review / codex-code-review" 和 stage 上报约定 —— 即 **B/R/P 的"流程骨架"在兜底 agent prompt 里已有雏形**。缺的是：① 这些 skill 在新项目里**实际不存在**（只有 flywheel/GeoForge3D 有，且是 `.claude/commands/` 人用命令）；② **完全没有文档管理层**——文档放哪、怎么命名、跟 branch 走、ship 后归档，全部空白；③ 项目自己的 agent.md（如 sub content-executor）一旦接管，generic 的流程约定就不生效了。
- ✅ RPCI 今天只活在交互式 session 的 repo 约定（CLAUDE.md + slash commands），Runner 侧无文档产出约束。

**张力点（brainstorm 要解决）**：`doc/architecture/product-experience-spec.md` §4.1 写 Runner 执行流程 "**不可跳过任何阶段**"，与 FLY-205 共识 #3（简单 issue 可由 Lead 判断跳过）冲突 —— spec 需要随本 issue 修订。

### A.3 Onboarding / 补装路径现状

**两个配置世界**（一个 doc-flow 功能两边都要碰）：

| 配置 | 位置 | 管什么 | docFlow 标志放哪 |
|------|------|--------|----------------|
| `ProjectEntry` | `~/.flywheel/projects.json`（机器本地，不进 repo）| Lead/Discord 路由（leads, chatChannel, generalChannel, canSpawnRunners）| 不适合——不随 repo 走 |
| `FlywheelConfig` | `<project>/.flywheel/config.yaml`（**进 repo，随 worktree 走**）| Runner 侧行为：agents, default_agent, checkpoints, skills, runners | **天然位置**（如 `doc_flow:` 顶层 key）|

**今天没有 onboarding 脚本**：`scripts/` 里无 project-setup 类脚本；FLY-189（joycon）/ FLY-190（sub）的 onboarding 是 worker 按 design doc 手工执行的（写 config.yaml + agents/*.md + projects.json + launchd plist）。

**首批补装目标现状**（只读勘察，未碰）：

| 项目 | `.flywheel/` | doc 树 | 备注 |
|------|------------|--------|------|
| sub | ✅ config.yaml + `agents/content-executor.md` | 无 `doc/`；自有 `docs/`, `research/`, `references/`, `brief/` | **content-executor.md 已自带 B/R/P 硬 gate 协议**（FLY-190 设计时写进去的）——补装 = 给它接上文档落盘约定 |
| joycon-typeless | ❌ **main 上完全没有** | 自有 `docs/`, `notes/`, `log.md` | Hiro Lead 只在 projects.json；repo main 已分叉 + vault 分支有未提交改动（**本 phase 不碰**）|
| GeoForge3D | ✅ config.yaml（checkpoints 3 gate）+ agents | A.1 的 653 文件大树 | 是模板来源，不是补装对象 |

**Lead 跳过判断的注入点**：`packages/teamlead/lead-rules-base/*.md`（FLY-26 分层 + FLY-175 `founder-only-authority.md` 先例）—— 每个 Lead role 经 `claude-lead.sh --append-system-prompt-file` 加载，新增一个 base 文件即对所有 Lead 生效，缺文件时向后兼容（不报错）。

### A.4 Flywheel 自身 doc 树（"单树简化形态"的现成参照）

- `doc/engineer/{exploration,research,plan,implementation,deep-research,onboarding}` + `doc/qa/` + `doc/architecture` + `doc/retro` —— **单 engineer 树**（无 backend/frontend/designer 分部门），365 个 md。
- 同样的命名病早期也有：`plan/archive/` 里 `v0.1.0-core-loop.md` 等无 issue id；后期收敛到 `v{ver}-FLY-{N}-{slug}.md`。
- stage 目录命名用 `archive/`，GeoForge3D 用 `archived/` —— 模板要拍一个。
- CLAUDE.md 里程碑表 ~80 行且每 ship 一条无限增长（issue 已点名的"膨胀病"；FLY-198 已拆过一次）。

### A.5 补充审计 — Lead 信息与 department 现状（Round 4 前置，2026-06-04）

**Lead 信息今天分四处**：

1. **`<repo>/.lead/<lead-id>/{identity.md, agent.md}` + `.lead/shared/*.md`**（进 repo，版本管理）— Lead 身份与项目级规则。GeoForge3D：`.lead/{product-lead,ops-lead,cos-lead,shared}`（identity 98 行 + agent 511 行 + shared 336/676 行）；sub：`.lead/sub-lead/`；joycon：`.lead/joycon-lead/`（**在 `worktrees/flywheel-main` worktree 上**，因 main 分叉）。加载链：claude-lead.sh 按 `identity.md` > `agent.md` 优先级 copy 到 `~/.claude/agents/<lead-id>.md`（GEO-246/286 + FLY-26）。
2. **`~/.flywheel/lead-workspace/<lead-id>/`**（机器本地，不进 repo）— Lead session 工作目录（GEO-285/286 决定与产品 repo 隔离）。三个项目五个 Lead 全部如此（manifests 实测）。
3. **运行记忆** = mem0（GEO-203 双桶）+ `~/.claude/projects/<workspace>/memory/`（机器本地，不进 repo）。
4. **`~/.flywheel/manifests/<project>-<lead-id>.json`** — 运行时清单（workspace/botTokenEnv/pid）。

**department 建模现状**：`LeadConfig.department` 可选字段已存在（FLY-137 v1.27.2），缺省时回退 `match.labels[0]` 小写。实测 projects.json：**只有 joycon-lead 显式写了 `department: "product"`**；sub-lead 缺省（回退会推出 "sub"，与 Annie 想要的 "content" 不一致——补装时要显式写）；GeoForge3D 三个 Lead 全缺省（回退 product/operations/pm，恰好对）。`.flywheel/agents/<dept>/` 子目录调度（AgentDispatcher）也按同一 department 概念工作。

**GeoForge3D 佐证**：repo 顶层就是 `product/ marketing/ operations/` 三部门制（各部门 `<dept>/doc/`）——Annie 的 department 心智模型来源。小项目（代码在 repo 根）装不下"部门拥有整个顶层目录"的形态，轻量版 = `doc/<department>/`。

### A.6 审计总结 — 设计要回答的问题清单

1. **模板形态**：GeoForge3D 部门树（重，qa 空目录证明会过度建）vs Flywheel 单 engineer 树（轻，单人项目够用）→ baseline 默认哪个？是否做成可选层级？
2. **命名**：issue-ID-only（共识 #1 已定）→ `{ISSUE}-{slug}.md`；目录统一 `archive/` 还是 `archived/`；stage 集合统一成哪几个（draft 要不要、backlog 要不要）。
3. **元数据**：frontmatter 砍到什么程度（状态只留目录位置一处？Linear 链接要不要留——离线可读性 vs 重复）。
4. **执行机制**：doc-flow 规则注入走哪条通道——agent.md 前置（per-agent）、Blueprint 基础 prompt（全局）、SkillInjector 注入 skill、还是 `doc_flow:` config 开关控制 Blueprint 条件注入（最像现有 checkpoints 模式）。
5. **Lead 跳过判断**：判断标准、知会 Annie 的形态（Discord 消息?  events?）、Annie 否决后补文档的通路。
6. **补装**：sub/joycon 各自已有自组织目录（docs/, research/, notes/）——补装是新建标准树还是接纳现有目录映射。
7. **spec 修订**：product-experience-spec §4.1 "不可跳过任何阶段" 需按共识 #3 改写。

---

## Part B — Brainstorm 纪要（与 Annie，≥3 轮）

> 进行中 — 每轮问题与结论追加于此。

### Round 1（2026-06-04）

问了三题：Q1 树形态（单树 vs 部门树）、Q2 stage 子目录收敛（5→4→3）、Q3 元数据精简。

**Annie 回复**：
1. **Q2 方向性转向（本轮最重要结论）**：stage 状态目录的历史动机 = "Runner 跑断了重连时知道做到哪"（存档/恢复功能）。这个问题现在变小了，所以 **"甚至可能不需要记录这些 stage，直接把那些文件记录下来就够了"** → 设计空间必须加一个比收敛激进得多的候选：**完全没有状态子目录**（状态唯一看 Linear；完成的要不要挪 archive/ 也存疑）。
2. **Q1/Q3 表述失败**："默认单树"、"frontmatter/元数据" 是黑话，Annie 没看懂（违反"不要工程黑话"规矩）。Round 2 必须实例驱动：真实目录树并排画出来；真实文档开头贴"现状 vs 精简后"对照，砍掉的每样东西逐条让她确认。
3. **格式纪律**：给 Annie 的展示不用管道表格（Discord 不渲染，FLY-206），目录树用 code block。

### Round 2（2026-06-04）— 全部拍板 ✅

实例驱动重问（三棵真实树 + 文档抬头对照）。**Annie 锁定**：

1. **文档放法 = 方案一：一个 issue 一个文件夹**。`doc/{ISSUE}-{slug}/{exploration,research,plan}.md` + `doc/retro/`。不分部门层（sub/joycon 单人项目）；不分状态子目录；进度唯一看 Linear。GeoForge3D 自己的大树保持现状不动。
2. **做完的 issue 文件夹不挪 archive/**（以后觉得乱再加）。
3. **文档抬头 = 标题 + 3 行**（她看过实际样例确认）：

```
# LEARN-21 深度睡眠包 — 实施计划

Issue: LEARN-21 (https://linear.app/.../LEARN-21)
日期: 2026-06-10
基于: 同文件夹的 research.md
```

保留：issue 号、Linear 链接、**显式日期（她明确要，不接受"看 git 就行"）**、上游文档行。砍掉：版本号前缀、Status 行、Codex 审查轮次记录。

### Round 5（2026-06-04）— 收口轮 ✅

议题：① GeoForge3D 顶层参照物钉死（单 git 仓库、部门优先、根放基础设施）② sub 搬 vs 不搬（成本实测）③ joycon 纯新增 ④ retro 位置。

**Annie 拍定（brainstorm 正式收口）**：
1. **sub 搬家：搬**（路 A，物理搬入 `content/`）。附带新要求：确认 sub 是否 git/GitHub 化，不是就转 —— **实测结果：sub 已是 git 仓库且有 GitHub 远端**（`github.com/xrliAnnie/sub`，PR #14/#15 已走 GitHub merge），joycon 同样（`github.com/xrliAnnie/joycon-typeless`）。**无需 git 化动作**，记录在案。
2. 新项目部门优先 baseline ✅、joycon 纯新增 doc PR ✅、retro 跟部门（`<部门>/doc/retro/`）✅。

### Round 4（2026-06-04）

议题：department 层目录设计（`doc/<department>/<issue>/`）+ Lead 信息沉淀位置 + spec 措辞 v2。

**Annie 拍定**：
1. Lead 档案（`.lead/<lead-id>/`，不动）与部门产出分开 ✅（"人事档案 vs 部门文件柜"模型成立）。
2. spec 措辞 v2 ✅（中等档也知会版本）。
3. Lead 代号不改名 ✅（joycon-lead / sub-lead 保持，部门归属用配置字段）。

**方向修正（→ Round 5 主题）**：她**不要** `doc/<部门>/`（doc 横切一层、部门在下）。要**部门优先的顶层结构**：仓库之下先按部门分，**每个部门目录里自己装 doc、code 和其它 artifacts，部门之间互相隔离，同一部门的所有东西都在一起**。参照物 = GeoForge3D 顶层。待解：① GeoForge3D 顶层实际形态钉死（git 边界、code/doc 共处方式）② sub/joycon 的 code 在仓库根 —— 物理搬 vs 只先放 doc 的成本/风险对比 ③ retro 在部门优先结构里的位置。

### Round 3（2026-06-04）

议题：① Lead 跳过判断交互（三档难度 + 非阻塞知会 mock）② sub/joycon 补装放哪（doc/ vs docs/issues/）③ spec §4.1 修订措辞。

**Annie 拍定**：
1. 简单档知会 = **发消息不等回复、随时可否决** ✅（不要先问后干）。
2. **中等档（只写 plan）也要知会**（否决了"中等不知会"的建议）——知会消息样式照简单档，注明"中等，只写 plan"。
3. joycon 补装 = **做成 PR 挂着**，她理顺 main/vault 分支后再合。
4. spec 三档措辞方向 OK（按中等档也知会微调）。

**方向性新输入（→ Round 4 主题）**：**department 概念成为每个 Flywheel 项目的统一结构**（像 GeoForge3D 的 product/operation）。即使项目现在只有一个部门也先立概念：JoyCon = product 部门、Sub = content 部门。她的判断：**Hiro/Asha 本质是 department lead 不是 project lead**，只是一项目一部门所以没显出来。待解：① `doc/<department>/<issue>/` 形态的目录设计（单部门项目要几乎无感）② **Lead 相关信息（identity/memory/feedback）沉淀在 repo 哪个文件夹**、和 doc/<department>/ 什么关系（她自知"有点难搞"，要不难搞的设计）。注意配置层对齐：projects.json 里 joycon 已有 department:"product"，sub 没写。


---

## Part C — 最终结论汇总（5 轮收口，design 合同）

### C.1 目录结构（部门优先）

```
<项目>/                          ← 一个 git 仓库(GitHub track)
├── <部门>/                      ← 顶层按部门分(product/ content/ …),部门间隔离
│   ├── doc/
│   │   ├── <ISSUE>-<slug>/      ← 一个 issue 一个文件夹,issue 号是唯一主键
│   │   │   ├── exploration.md
│   │   │   ├── research.md
│   │   │   └── plan.md
│   │   └── retro/               ← 部门自己的复盘
│   └── <代码/产物 …>            ← 同部门所有东西在一起
├── .flywheel/config.yaml        ← department 声明 + doc-flow 开关
├── .lead/<lead-id>/identity.md  ← Lead 个人档案(跟人走,与部门文件柜分开)
└── CLAUDE.md  README  worktrees/ ← 跨部门基础设施(根)
```

- **没有状态子目录**（draft/new/inprogress/archived 全砍）：进度唯一真相 = Linear；做完不挪 archive（以后觉得乱再加）
- 部门名机器自动填（owning-dept 解析已在生产），单部门项目无感
- 文档跟 worktree/branch 走，ship 时随 PR 进 main

### C.2 文档抬头（标题 + 3 行）

```
# LEARN-21 深度睡眠包 — 实施计划

Issue: LEARN-21 (https://linear.app/.../LEARN-21)
日期: 2026-06-10
基于: 同文件夹的 research.md
```

砍掉：版本号前缀、Status 行、Codex 审查轮次。**日期必须显式写**（Annie 明确要求）。

### C.3 三档难度 + 知会（Lead 判断）

```
复杂 → exploration + research + plan 三份齐全,缺一不可
中等 → 可只写 plan(必须知会,注明"中等,只写 plan")
简单 → 可零文档直接实现(必须知会,注明"简单,跳过文档")
```

- 知会 = Lead 在部门 Discord 频道发消息，**不等回复**，Runner 同时开干；Annie **随时可否决**（回消息 → Lead 让 Runner 补文档）；merge 永远等 Annie（FLY-175 不变）
- spec §4.1 "不可跳过任何阶段" 按上述三档措辞修订（v2 文本见 Round 4 纪要）

### C.4 Lead 信息位置（不动）

- `.lead/<lead-id>/` = 人事档案，跟人走，现有机制不动；Lead 代号不改名（joycon-lead / sub-lead 保持）
- 部门归属 = projects.json `department` 字段（joycon 已有 `"product"`；sub 补 `"content"`；GeoForge3D 三 Lead 靠 label 回退恰好正确，可顺手显式化）
- 运行记忆照旧机器本地 + mem0，不进 repo

### C.5 补装

- **sub：物理搬**（拍定）。`brief/ references/ research/ projects/ scripts/ docs/ nanobanana-output/` git mv 入 `content/`；新建 `content/doc/`；改 ~25 处路径引用（AGENTS.md / content-executor / config.yaml / sub-create skill）；收口标准 = 全仓搜旧路径零命中 + style-lint 与 sub-create 路径验证；合并后重启 Asha。**git/GitHub 已就绪无需动作**。
- **joycon：纯新增**。只加 `product/doc/`（纯新增文件，零冲突），PR 挂着等 Annie 理顺 main/vault 后合；物理搬家另立 issue。
- 新项目：onboarding 可选启用 doc-flow，脚手架从第一天就部门优先。

### C.6 实施覆盖面（plan 必须含）

① baseline 脚手架（新项目，部门优先）② Runner/Lead 规则接线（三档判定 + 知会通路）③ sub 补装（搬家 + config）④ joycon 补装（纯新增 doc PR）⑤ product-experience-spec §4.1 修订 ⑥ 文档抬头/命名规范落地（写进可注入的规则文件）
