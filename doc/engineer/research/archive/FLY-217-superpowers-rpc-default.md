# Research: Runner 默认走 Superpowers RPC flow(无 agent.md 时)— FLY-217

**Issue**: FLY-217
**Date**: 2026-06-05
**Source**: Linear FLY-217(Annie intent + 5 research 问题);关联 FLY-205(doc-flow)、FLY-214/216(skill 库)
**Status**: Complete(audit + 5 问答 + 选型建议)— 待与 Annie brainstorm 选型,不在 research 阶段单方拍架构

---

## 0. 结论先行(TL;DR)

1. **Superpowers 已经在本机装好,而且很可能已经对 Runner 生效了。** 它是一个 Claude Code **plugin**(v5.1.0,来自 `obra/superpowers`),在 `~/.claude/settings.json::enabledPlugins` 里 **user 级启用**。它的 RPC flow 不是"调一条命令触发",而是**靠两个机制自动触发**:① 一个 `SessionStart` hook,在每次 `claude` 启动(startup/clear/compact)时把 `using-superpowers` skill 正文注入成 `additionalContext`;② 一堆带"**You MUST use this**"强触发 description 的 skill(brainstorming / writing-plans / test-driven-development …)。生产 Runner 是用 `TmuxAdapter` 以**普通 `claude` 交互进程**(同一个 macOS 用户、`--append-system-prompt-file`、无禁插件 flag)拉起的,所以它天然继承 user 级 plugin → **superpowers 的 hook 对 Runner 也会 fire**(real-run 待验证,但代码路径上成立)。

2. **因此 FLY-217 的真问题不是"怎么给 Runner 装 superpowers",而是三件:**
   - **(A) 对齐 gate 语义**:superpowers 的 `brainstorming` 有一道 `<HARD-GATE>`,要求"**人类在对话里批准设计**才能写代码"。Flywheel Runner 是自治跑的,"批准"走的是 `flywheel-comm gate brainstorm`(Lead 在 Discord 确认,命令返回值带回对话)——**两套 gate 指的是同一件事,但通路不同**。直接放任 superpowers 原样跑,Runner 可能卡在"等人类在对话里点头"而那个人不存在。
   - **(B) 对齐文档落点**:superpowers 把 spec 写到 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`;FLY-205 doc-flow 要求写到 `<dept>/doc/<ISSUE>-<slug>/`。冲突,但可由 prompt/CLAUDE.md 覆盖(superpowers 明文"user 偏好覆盖默认落点")。
   - **(C) 分发到别的机器**:本机已装,但别的机器没有 = Runner 啥也拿不到。这是 FLY-216 的活,**但 superpowers 不该收进 flyview-skills 库**(下详)。

3. **选型方向(待 Annie 拍)**:倾向 **"拥抱 + 收编"**——承认 superpowers 已经在场,与其压制不如把 Flywheel 自己的 gate 当作 superpowers 的"人类批准"通路接上去,让无 agent 的 Runner 默认走 superpowers 的 RPCI;agent.md 存在时按 agent 走(superpowers 自己的优先级规则就让位 CLAUDE.md/AGENTS.md)。但这要求**先在 Flywheel 这种"无人在对话里"的自治语境里实测 superpowers 的 HARD-GATE 行为**——这是最大未知。备选是"自己实现 RPCI、把 superpowers 当灵感不当依赖"(Flywheel 现在的 generic-executor.md 已经是这条路的雏形)。

---

## 1. Superpowers 是什么(问题 1)

### 1.1 装在哪、什么形态

本机存在**两份** superpowers,同源 `obra/superpowers`:

| 形态 | 路径 | 版本 | 谁在用 |
|------|------|------|--------|
| **Claude Code plugin**(live) | `~/.claude/plugins/cache/superpowers-dev/superpowers/5.1.0` | 5.1.0 | **Claude Code**(本机所有 claude session,含 Runner)。`enabledPlugins["superpowers@superpowers-dev"]=true` |
| git clone(Codex 侧) | `~/.codex/superpowers/`(symlink `~/.agents/skills/superpowers` → `…/skills`) | 5.0.7 | Codex / `~/.agents` 体系。FLY-214 审计提到"superpowers(14 个子 skill)"即指这份 canonical |

marketplace:`superpowers-dev`(`known_marketplaces.json` → repo `obra/superpowers`)。官方还有 `superpowers@claude-plugins-official` 渠道。

形态结论:**它是 plugin,不是单个 skill,也不是裸目录。** plugin 内含 `skills/`(14 个子 skill)、`hooks/`(SessionStart)、`commands/`、`agents/`。每个子 skill 是标准 `SKILL.md`,在 Claude Code 里以 **namespace** 暴露(`superpowers:brainstorming` 等)——namespace 让它不与项目同名 skill 冲突(FLY-214 research ④ 已记)。

### 1.2 RPC flow 怎么触发(自动 vs 指令)

**自动,靠 hook + 强 description,不需要谁喊一声"走 RPC"。** 链条:

```
claude 启动(startup|clear|compact)
   └─ SessionStart hook(plugin 注册在 user settings)
        └─ 注入 using-superpowers 正文为 additionalContext:
             "<EXTREMELY_IMPORTANT> You have superpowers …
              如果有 1% 可能某 skill 适用,你必须调它 </…>"
   └─ 之后每条用户消息,agent 自查:"有 skill 适用吗?" → 有就 Skill(...) 调起
        brainstorming → writing-plans → using-git-worktrees →
        subagent-driven-development/executing-plans → test-driven-development →
        requesting-code-review → finishing-a-development-branch
```

每个子 skill 的 `description` 是强触发措辞(例:brainstorming = "**You MUST use this before any creative work**…")。`using-superpowers` 自身还带一张 **Red Flags 表**,专门堵 agent"这个太简单不用 skill"的理由。

**关键标记 `<SUBAGENT-STOP>`**:using-superpowers 开头写"如果你是被派去执行某个具体任务的 **subagent**,跳过本 skill"。Flywheel Runner 是 **top-level claude 进程**(tmux 里独立 session,不是 Claude Code 的 Task 子代理)→ **不命中 SUBAGENT-STOP → using-superpowers 会跑**。(注意:如果将来 Runner 改成被某 Lead 用 Task/Agent 工具派生的子代理,这条会让它跳过——是个要记住的边界。)

### 1.3 和 FLY-205 的 gate 对齐 / 冲突

| superpowers 行为 | FLY-205 / Flywheel 对应 | 关系 |
|---|---|---|
| `brainstorming` 有 `<HARD-GATE>`:**人类在对话里批准设计**前不许写码,**每个项目无论多简单都要走** | Flywheel `brainstorm` checkpoint(`flywheel-comm gate brainstorm`,Lead 在 Discord 确认);doc-flow-rules 明文"brainstorm gate、approve gate、**executor 自带的硬性确认环节,任何档位都照常执行**" | **概念对齐**(都要求设计先过人)。**通路冲突**:superpowers 等"对话里的人",Flywheel 的人在 Discord、批准经 `flywheel-comm` 命令返回。需要把 gate 命令返回值"翻译"成 superpowers 眼里的"用户批准"。 |
| 写 spec 到 `docs/superpowers/specs/<date>-<topic>-design.md` | doc-flow `<dept>/doc/<ISSUE>-<slug>/exploration|research|plan.md` | **落点冲突**。但 superpowers 明文"user 偏好覆盖默认落点"→ 可用 CLAUDE.md/AGENTS.md/appended-prompt 改写。 |
| "每个项目都要 brainstorm,**simple 不能跳**" | docTier=`none`(简单档)只控**文档产出**,gate 不跳 | **不冲突**(见问题 4):superpowers 是"怎么 brainstorm 的方法",docTier 是"要不要落文档"。两轴正交。 |
| `test-driven-development`(RED-GREEN-REFACTOR) | generic-executor.md 已要求 TDD;`flywheel-tdd` skill | 对齐,几乎重合。 |
| `using-superpowers` 优先级:**用户指令(CLAUDE.md/AGENTS.md)> superpowers skill > 默认** | Flywheel 的 `--append-system-prompt` + 项目 CLAUDE.md | **这是和解的钥匙**:Flywheel 的注入 prompt 天然高于 superpowers,可以合法地"指挥" superpowers 怎么落地。 |

---

## 2. 接入点:无 agent.md → fallback 在哪(问题 2)

### 2.1 dispatch 那一支

`packages/edge-worker/src/AgentDispatcher.ts` —— 确定性 3 步:

1. `dispatchByName(name)`:Lead 显式传 `agentName` 时的 override。
2. `dispatch({issueLabels, owningDept})`:2a 本部门 label 匹配 → 2b 顶层 catch-all label 匹配。
3. **fallback**:
   - 3a 项目 `default_agent`(若声明且存在);
   - 3b **`shippedGenericResult()`** —— `matchMethod: "shipped-generic"`,`agent_file: "agents/generic-executor.md"`,`agentFileRoot: "flywheel"`(指向 Flywheel 仓根,所以新项目零配置也能拿到)。

**"无 agent" 的判定 = `dispatchResult.matchMethod === "shipped-generic"`。** sub / JoyCon 现在就是命中这支(它们没有 `.flywheel/agents/*.md`)。

### 2.2 prompt 怎么拼的(改哪里)

`packages/edge-worker/src/Blueprint.ts` 每次 spawn 把 `systemPromptLines` 拼成 `--append-system-prompt`,顺序:

```
[onboard preamble] → [DOC-FLOW 块(FLY-205,config 门控)] → [6 步 base flow]
→ [ask/inbox 说明] → [FLY-208 REPORT-BACK + MERGE AUTHORITY 硬规则]
→ [每个 checkpoint 的 gate 说明(brainstorm / approve_to_ship / …)]
→ [stage/completion 上报]
最后:agentContext(= agent_file 正文,如 generic-executor.md) 前置在 baseSystemPrompt 之上
```

**已存在的事实**:`agents/generic-executor.md`(无 agent 的 fallback 正文)**已经用散文写了一套 RPCI 风格流程**:onboard → brainstorm(明文"即使看起来简单也不跳")→ research → write-plan → implement(TDD)→ design_review/code_review gate。它**不是强制机制**,而是靠 Runner 自觉 + Flywheel 的 `flywheel-comm` gate 系统兜。换句话说:**Flywheel 已经有"无 agent 默认 RPCI"的雏形,只是纯 prompt 散文,没接 superpowers 的 skill 引擎。**

**要默认走 superpowers RPC flow,可改的位置(从小到大):**
- **最小**:在 generic-executor.md 里把"brainstorm / research / plan / implement"几句改成"**调起 `superpowers:brainstorming` / `superpowers:writing-plans` / `superpowers:test-driven-development`**,并把 superpowers 的'用户批准'理解为通过 `flywheel-comm gate` 取得"。零代码,纯改一个 md 文件(还在 Flywheel 仓里,跟着 Bridge 走)。
- **中**:Blueprint 在 `matchMethod==="shipped-generic"` 时额外 unshift 一段"SUPERPOWERS RPC(no-agent default)"块,显式把 superpowers 子 skill 映射到 Flywheel 的 stage/gate(类似现在 DOC-FLOW 块的注入方式)。
- **大**:把 superpowers 的"人类批准"通路真正接到 `flywheel-comm`(让 brainstorming 的 HARD-GATE 走 gate 命令而不是等对话)。这要么靠 prompt 指令(便宜),要么要碰 superpowers 本体(不建议——它是第三方、94% PR 拒绝率、明文拒 fork 改动)。

---

## 3. 分发:走 flyview-skills 还是别的(问题 3)

**建议:不把 superpowers 收进 flyview-skills 库;按"第三方 plugin、独立渠道"分发。** 三条理由,都有实据:

1. **flyview-skills 已经把 `superpowers` 列进 `blocklist.txt`(第 60 行)。** 库的命名纪律:user 级 skill 会**遮蔽**项目级同名;`superpowers` 已作为 canonical 装在 `~/.agents/skills/superpowers`,库里再发同名 = 直接冲突。
2. **flyview-skills 是 first-party 能力库**(video-watch / founder-html-delivery / flywheel-land)——自己写、走自己 PR + CI 五道门。superpowers 是**第三方 plugin**,有自己的 marketplace、自己的 `/plugin update`、自己的 hooks/commands(库的 README 明说"只有 SKILL.md 正文是 live 的,plugin 的 hooks 不算")。把它塞进库 = 既违反库的"first-party"边界,又丢掉它的 hook(RPC 自动触发恰恰靠 hook)。
3. **superpowers 仓 CLAUDE.md 明文拒绝 fork-specific 改动 / 拒绝把它当依赖塞别处**。我们应当**消费**它,不该**搬运**它。

**那它怎么上别的机器?** 两个干净选项(待 Annie 拍):
- **(i) 进机器 bootstrap**:在 `computer-bootstrap` skill / 各机 launchd 里,除了 `skills-sync.sh`(flyview-skills),再加一步**确保 superpowers plugin 已装且 enabled**(`/plugin install superpowers@…` 或等价的 marketplace add + enable;并往该机 `~/.claude/settings.json::enabledPlugins` 写 `true`)。它的更新走 `/plugin update`,与 flyview-skills 的每日 sync 并行、互不耦合。
- **(ii) 仅 Flywheel 自管**:如果只想让 **Runner** 有、不想全机器都有,可在 Runner 的 worktree 注入层(SkillInjector / `.claude/settings.json`)启用——但 plugin 不像 skill 那样能简单按 worktree 投放(plugin 是 user 级安装 + 全局 enable),所以 (i) 更顺。

**和 FLY-216 链的配合**:FLY-216 负责 first-party skill 的"库 → sync → 各机 ~/.agents/skills"链;superpowers 走**平行的 plugin 渠道**,在同一个机器 bootstrap 时间点装好即可。两条链不交叉(一条 skills CLI,一条 plugin marketplace),正好对应 FLY-214 的分层:能力可以来自库,也可以来自第三方 plugin,**Flywheel 只是消费者**。

---

## 4. docTier(简单可跳)与 superpowers 强制 RPC 怎么共存(问题 4)

**两者正交,可共存——关键是看清它们各自管什么轴。**

- **docTier 管"要不要落文档"**(full = 探索+调研+计划三份齐;plan_only = 只 plan;none = 零文档)。doc-flow-rules.md / Blueprint 注释**两处都明文**:docTier 只控 DOCUMENT OUTPUT,`brainstorm gate、approve gate、executor 自带的硬性确认环节任何档位都照常执行,不因 none 而跳过`。
- **superpowers 管"怎么做这件事"**(brainstorming 的方法、TDD 的纪律)。它的 HARD-GATE"simple 也要 brainstorm"——指的是**过程**(设计先过人),不是**产出**(必须写 spec 文件)。

**所以兼容规则可以这样定(待确认):**

| docTier | brainstorm gate | superpowers brainstorming 方法 | 落不落 spec 文件 |
|---------|----------------|-------------------------------|-----------------|
| full | 跑 | 跑(完整) | 落到 `<dept>/doc/<ISSUE>-<slug>/`(**覆盖** superpowers 默认的 `docs/superpowers/specs/`)|
| plan_only | 跑 | 跑 | 只落 plan.md |
| none | **跑**(不跳) | 跑,但**设计 inline 呈现给 gate**,**不写 spec 文件** | 不落 |

**唯一真冲突点**:superpowers brainstorming 的 checklist 第 6 步"**写 spec 文件并 commit**"是硬步骤。docTier=none 时我们不想要文件。和解:用更高优先级的 Flywheel prompt 指令明文"docTier=none 时跳过 spec 文件落盘步骤,把设计直接放进 brainstorm gate 消息"。superpowers 自己的优先级规则(用户指令 > skill)允许这种覆盖。

**"有 agent.md 走 agent、没有走 superpowers"这个分支逻辑在哪实现?** —— 微妙,要说清:
- superpowers 是**全局 hook 触发**,对**所有** Runner(有没有 agent.md)都会注入。它**不是**一个你 per-Runner 开关的东西。
- 真正的"分支"是 **prompt 优先级**:有 agent.md 时,`agentContext`(agent 正文)前置在 base prompt 之上,且 superpowers 明文让位 AGENTS.md/CLAUDE.md → **agent 自己的流程压过 superpowers**(只要 agent.md 写了自己的流程)。无 agent.md 时,走 generic-executor.md + base flow → 此时我们让它**显式拥抱 superpowers**。
- 落地实现 = 在 Blueprint 用 `matchMethod` 判:`shipped-generic`(无 agent)→ 注入"按 superpowers RPC 走"的引导块;否则(有 agent)→ 不注入该引导(或注入"你的 agent 流程优先,superpowers 仅作可选工具")。**这就是那条分支。**

---

## 5. sub / JoyCon 落地后 Runner 长什么样(问题 5,推演)

sub / JoyCon 现状:无 `.flywheel/agents/*.md` → dispatch 命中 `shipped-generic` → 跑 generic-executor.md。两个项目都**启用了 doc-flow**(FLY-205 sub#17/#18 已搬家)。接入 superpowers 默认流程后,一个 sub Runner 处理一个 issue 的推演:

```
1. claude 启动 → superpowers SessionStart hook 注入 using-superpowers
   + Flywheel --append-system-prompt(onboard preamble + DOC-FLOW + base + gates + REPORT-BACK)
2. onboard preamble:stage set onboard → 跑 onboard skill → stage set brainstorm
3. Runner 自查"有 skill 适用?" → 命中 superpowers:brainstorming
     - 探索 codebase、一次问一个澄清问题
     - 提设计 → 到 HARD-GATE:这里**必须接上 flywheel-comm gate brainstorm**
       (而不是等对话里的人)→ Lead 在 Discord 确认 → 命令返回 → Runner 把它当"用户批准"
     - 设计落到 sub/doc/<ISSUE>-<slug>/exploration.md(docTier=full 时;覆盖 superpowers 默认落点)
4. superpowers:writing-plans → plan.md → stage set design_review --plan … → Codex 设计审查 gate
5. superpowers:using-git-worktrees(可能与 Flywheel 自己的 worktree 创建重叠——要去重)
6. superpowers:test-driven-development(RED-GREEN-REFACTOR)实现
7. superpowers:requesting-code-review → PR → stage set pr_created → Codex code review
8. approve_to_ship gate(FLY-191 非阻塞流):verify-approval → ship → merged 落地信号 → completed
9. FLY-208 REPORT-BACK:用 flywheel-comm ask 回报 Lead(不能用 SendMessage)
```

**推演里暴露的需要实测/对齐的点(real-run 清单):**
- (a) **superpowers HARD-GATE 在"无对话人类"语境下到底怎么表现**:会卡死等批准?还是会因为 Flywheel prompt 说"用 gate 命令"而正确改道?——**最大未知,必须真跑一次看。**
- (b) **worktree 双创建**:superpowers `using-git-worktrees` vs Flywheel 自己的 worktree 创建,会不会打架。
- (c) **第一回合被 superpowers bootstrap 吃掉**:hook 注入后 agent 第一条回复常用来"宣布 skills",要确认不会干扰 Flywheel 的 onboard preamble 时序。
- (d) **落点覆盖是否真生效**:superpowers 是否听话写到 doc-flow 路径而非 `docs/superpowers/specs/`。
- (e) **subagent-driven-development**:superpowers 想 spawn 子代理并行做任务——在 Runner(本身已是被编排的单元)里再 spawn 子代理,和 Flywheel 的 load/并发纪律是否冲突(今晚机器就因 load 156 差点 crash)。

---

## 6. 给 Annie 的选型(不在 research 单方拍,带去 brainstorm)

三个方向,推荐 **B**,但 B 的前提是先做 §5 的 real-run(尤其 (a))验证 superpowers 在自治语境下不卡死:

| 方向 | 做法 | 优点 | 风险 |
|------|------|------|------|
| **A. 压制** superpowers,保留 Flywheel 自有流程 | 在 Runner prompt 明确"忽略 superpowers,按 Flywheel 的 generic-executor + gate 走" | 零新依赖、行为完全可控、不赌第三方 | 等于不要 superpowers;Annie 的诉求("默认走 Superpowers RPC")没满足;而且 superpowers 已全局开,"压制"也要写明 |
| **B. 拥抱 + 收编**(推荐) | 承认 superpowers 已在场;无 agent 时 generic-executor.md 显式调 superpowers 子 skill;把 superpowers 的"用户批准"接到 `flywheel-comm gate`;落点用 prompt 覆盖到 doc-flow 路径 | 直接满足 Annie 诉求;复用 superpowers 成熟的 RPCI 引擎(brainstorming/TDD/review 都是调好的);改动小(主要改 generic-executor.md + 一段 Blueprint 注入)| 依赖第三方 plugin 的行为;HARD-GATE 在自治语境的表现未实测(最大未知);superpowers 升级可能改行为 |
| **C. 自研 RPCI**,superpowers 当灵感 | 把 superpowers 的流程吸收进 Flywheel 自有 skill(或加进 generic-executor.md),不依赖 plugin | 完全自主、和 gate 天然贴合 | 重复造轮子;维护成本;Flywheel 现在的 prompt-散文流程其实已是半个 C,真要强制还得自己写 skill 引擎 |

**B 的最小切片**(若选 B):先只改 `agents/generic-executor.md`(纯 md,跟 Bridge 走,零代码)把流程指针指向 superpowers 子 skill + 写清 gate 映射 + 落点覆盖 → 在 sub 或 JoyCon 真跑一个简单 issue → 看 §5 清单。验证通过再考虑 Blueprint 的 `matchMethod` 注入块。

**要 Annie 拍的几个点(plain language)**:
1. superpowers 已经在你机器上、而且大概率已经悄悄对 Runner 生效了——你是想"正式拥抱它"(B),还是"先按住、用我们自己的流程"(A)?
2. superpowers 要写设计文档到它自己的目录,我们 FLY-205 要写到 `部门/doc/issue号/`——确认让我们的路径覆盖它?
3. superpowers 的"写代码前必须有人批准设计"这一关,你希望走我们现有的 Discord gate(Lead 确认),对吧?(而不是 superpowers 默认等"对话里的人")
4. 别的机器:superpowers 当独立 plugin 在装机时一起装(不进 skill 库),OK?
5. 简单档(none)时:还要不要 superpowers 强制 brainstorm?(建议:过程要、但不落文档文件)

---

## 7. 关键事实索引(便于 plan 阶段引用)

- plugin 启用:`~/.claude/settings.json::enabledPlugins["superpowers@superpowers-dev"]=true`
- 触发 hook:`~/.claude/plugins/cache/superpowers-dev/superpowers/5.1.0/hooks/{hooks.json,session-start}`(SessionStart,matcher `startup|clear|compact`,注入 `using-superpowers` 为 `additionalContext`)
- 子 skill:`…/5.1.0/skills/{using-superpowers,brainstorming,writing-plans,test-driven-development,…}/SKILL.md`(14 个,namespace `superpowers:*`)
- canonical(Codex 侧):`~/.codex/superpowers/`(v5.0.7)← `~/.agents/skills/superpowers` symlink
- 无 agent fallback:`packages/edge-worker/src/AgentDispatcher.ts::shippedGenericResult()` → `matchMethod==="shipped-generic"` → `agents/generic-executor.md`
- prompt 拼装 + 注入点:`packages/edge-worker/src/Blueprint.ts`(DOC-FLOW 块 line ~537;gate 块 line ~691;agentContext 前置 line ~864)
- 现有 RPCI 雏形(散文):`agents/generic-executor.md`
- doc-flow 三档 + "gate 任何档不跳":`packages/teamlead/lead-rules-base/doc-flow-rules.md`;Blueprint DOC-FLOW 注释 line ~534
- 分发链:`~/Dev/flyview-skills/`(README + `machine/skills-sync.sh` + `blocklist.txt` 第 60 行 `superpowers`);plan `doc/engineer/plan/new/v1.34.0-FLY-216-…md`
- superpowers 优先级规则(和解钥匙):`using-superpowers/SKILL.md` §Instruction Priority(用户指令 > skill > 默认)
