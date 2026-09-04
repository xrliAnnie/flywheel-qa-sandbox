# FLY-2147 runner 按角色+项目挂记忆目录 — 探索
Issue: FLY-2147 (https://linear.app/geoforge3d/issue/FLY-2147/2132b0-引擎能力runner-spawn-挂记忆目录角色项目)
日期: 2026-09-03
基于: 无(上游为 product/doc/FLY-1984-codex-home-identity/epic-prd.md §B + §卡在哪)

> 本文只回答三件事:现在到底是什么样(实测)、要做成什么样、有哪几条路可走及推荐哪条。
> 怎么改代码、改哪几行、测什么,在 plan.md。

---

## 1. 问题(PRD 原话的工程翻译)

PRD §B 要的是:**记忆跟着「角色 + 项目」走,不跟着一次性执行编号走**;一份很短的目录自动送到 runner 眼前,正文要用时再翻;第二次跑同一角色+项目能读到第一次写的;换 issue、换工作目录、删 worktree 都不影响。

PRD §卡在哪:runner 的 11 个启动参数没有一个用来挂记忆目录,所以 B 线全部落空。**B0 = 把这个能力加进 spawn 链路。**

Issue 附加的硬约束:Lead 侧索引超长会静默截断——B **不许照抄**这个形状,注入面必须**有界且可见**(超界要说出来)。

## 2. 现状(2026-09-03 本机实测,不是读文档)

### 2.1 runner 今天的记忆在哪

| 事实 | 证据 |
|---|---|
| Claude runner 的记忆目录 = `~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/`,**按仓库分,不按角色分** | 本 runner 的 system prompt 原文;PRD 事实底稿 n=4 个并行 runner 同路径 |
| worktree 删掉不会丢:slug 由 git 仓库派生,所有 worktree 共用主仓那一份 | 官方文档 memory.md「Storage location」+ 本机 231 个 worktree 目录 0 条记忆 |
| 该目录今天 573 个文件,索引 `MEMORY.md` 116 行 / 22,126 字节 | `ls \| wc -l` · `wc -lc` |
| 所有角色(eng_design / implement / qa / pm …)与 founder 本人在 `~/Dev/flywheel` 的会话**写的是同一份** | 同上;PRD 事实底稿「92 条提到 FLY 单号 ⇒ runner 在写」 |

⇒ **PRD 说「runner 没有记忆」在字面上不成立**,准确说法是:有,但**缺的是「按角色」那一格**——qa 读不到「所有 qa 学到的」,只能读到「所有人在这个仓学到的」混在一起的一份。

### 2.2 Lead 侧的记忆机制(要对齐的形状)

| 事实 | 证据 |
|---|---|
| Lead 用 Claude Code 原生 agent 记忆:agent 定义 frontmatter `memory: user` ⇒ `~/.claude/agent-memory/<lead-id>/` | `~/.claude/agents/flywheel-eng-lead.md` 第 5 行 `memory: user`;`claude-lead.sh:2535 --agent "$LEAD_ID"` |
| 形状 = 短索引 `MEMORY.md`(一行一条指针)+ 一事一文件(带 frontmatter `name/description/type`) | 目录实物 |
| 索引装载上限:**200 行或 25KB,先到先截** | 官方文档 memory.md「How it works」 |
| eng-lead 索引今天 **152 行 / 32,998 字节 ⇒ 已超字节上限,后段没进上下文** | `wc -lc` |

### 2.3 「静默截断」到底有多静默(实测,修正 PRD 一句话)

用 `claude -p --model haiku --settings '{"autoMemoryDirectory": <临时目录>}'` 造两份超限索引:

| 造的索引 | 模型看到的 | 结论 |
|---|---|---|
| 218 行 / 12KB(行数超) | 首条可见,末条不可见;上下文里有 `MEMORY.md is 218 lines (limit: 200). Only part of it was loaded.` | 行数超限**对模型不静默** |
| 153 行 / 32.7KB(字节超) | 首条可见,末条不可见;上下文里有 `WARNING: MEMORY.md is 31.7KB (limit: 24.4KB) — index entries are too long. Only part of it was loaded.` | 字节超限**对模型也不静默** |

⇒ **修正**:在 Claude Code 2.1.259 上,超限时**模型**会收到一条 WARNING(PRD 写的「不报错」是旧版本或旧观察)。
但仍然成立的三点,正是 B0 要补的:
1. **运维 / Lead 看不到**——WARNING 只在模型上下文里,不进任何日志、事件、台账;Lead 索引超限 8.5KB 这件事今天没有任何人被通知。
2. **没有东西阻止它发生**——上限是装载侧的,写入侧只在「这次写会超」时报错,已超的存量每次静默丢后段。
3. **WARNING 不说丢了哪几条**——模型只知道「部分加载」,不知道是从第几行起没了。

### 2.4 spawn 链路的注入点(读代码)

```
Bridge runs-route ─► Blueprint.execute(ctx)
   ├─ 角色文本:generalized ⇒ ctx.workflowAgentContent(nodeId 来自 registry.yaml)
   │            legacy      ⇒ dispatchResult.agentName + agentFile
   ├─ 拼 appendSystemPrompt = "## Agent Role" + 角色文本 + "## Baseline Rules" + 基线
   └─ adapter.execute(AdapterExecutionContext)          ← 类型在 packages/core/src/adapter-types.ts
        └─ TmuxAdapter.buildClaudeArgs(ctx)             ← 11 个参数在这里生成
             --session-id · --permission-mode · --append-system-prompt-file · --model · --effort
             --allowed-tools · --settings(JSON,已在用) · --no-chrome · --name · [prompt] · (+ Agent Team 身份 flag)
        └─ appendPaneEnv(FLYWHEEL_EXEC_ID / FLYWHEEL_PROJECT_NAME / FLYWHEEL_LEAD_ID …)
```

关键发现:**`--settings` 这个参数已经在用**(`buildNonLeadClaudeSettings` 合并 enabledPlugins),而 Claude Code 官方文档给了一个设置键 `autoMemoryDirectory`(接受绝对路径或 `~/`),可在任意 settings 作用域生效。

**实测**(本机 2.1.259,`claude -p --model haiku`):
- 对照组(不带该键):模型报告记忆目录 = `~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/`
- 带 `--settings '{"autoMemoryDirectory": "<scratch>/flywheel/qa"}'`:模型报告记忆目录 = 那个 scratch 路径
- 目录不需要预先有 `MEMORY.md`,Claude Code 不会自动建索引文件(目录跑完仍为空)

⇒ **「挂记忆目录」这个能力在 CLI 侧已经存在,缺的只是 Flywheel 在 spawn 时把它算出来、传进去、守住边界。**

## 3. 目标与验收(把 PRD §做到什么样 B 翻成可测句子)

| PRD B 验收 | 可测形式 |
|---|---|
| runner 起来能读到「它这个角色 + 这个项目」的记忆,不是空的 | 第二次 spawn 同 (project, role) 时,system prompt 里的记忆索引含第一次写下的那一行 |
| 第二次跑读得到第一次写的 | 同上 |
| 换 issue、换工作目录读到的还是同一份 | 目录路径只由 (project, role) 决定,不含 executionId / issueId / cwd |
| 工作目录清掉之后写下的东西还在 | 目录不在 worktree 内,也不在 `~/.claude/projects/<worktree-slug>/` |
| (Issue 追加)注入面有界且可见 | 索引超过预算时:Bridge 日志一行 + runner prompt 一行(含从第几行起没进);索引没超时日志同样一行写明「n 行 / m 字节 / 预算内」 |

## 4. 能走的几条路

### 路 A(推荐)· 原生挂载 + Flywheel 守卫

spawn 时 Blueprint 算出 `<root>/<project>/<role>/`,通过**已有的** `--settings` 加一个键 `autoMemoryDirectory` 传给 Claude CLI;Claude Code 自己负责「短索引自动进上下文 + 正文按需翻 + 写入侧格式与超限报错」——**与 Lead 侧完全同一套机制**。
Flywheel 在 spawn **前**多做一件事:读该目录 `MEMORY.md`,按预算(行数 + 字节)判一次,把结果写进日志,并在超限时往 prompt 里加一行**说清从第几行起不会被加载**。

- 优点:代码最少(一个键 + 一段守卫);形状天然与 Lead 对齐;runner 只有**一个**写入目标,不会被两套记忆说明搞糊涂;Claude Code 写入侧的格式指导免费拿到。
- 代价:runner 的默认记忆从「项目共享那 573 条」切到「角色专属目录」——项目共享那份对 runner 不再自动进上下文(见 §5 Q2)。
- 只覆盖 Claude 系 runner;Codex runner 没有这个设置(见 §5 Q3)。

### 路 B · Flywheel 自己注入(不动 Claude Code 记忆)

保留原生项目记忆不变,Flywheel 另读 `<root>/<project>/<role>/MEMORY.md`,自己截到预算内,作为 `## Runner Memory` 段拼进 appendSystemPrompt,并在 prompt 里再写一遍「怎么写记忆、写到哪」。

- 优点:字面上「注入面完全由我们控制」;Codex runner 也能吃到同一段文本。
- 缺点:runner 同时有两个记忆目录、两套写入说明(Claude Code 原生的那段仍在),**第十次来的 QA 到底写哪边没有单一答案**;要自己重写一遍 Claude Code 已经做好的格式/写入侧守卫;多一份需要维护的镜像词汇。
- 否决理由:违背「一个真相源」,且 PRD 明确要求「与 Lead 侧形状对齐」——Lead 用的正是原生机制。

### 路 C · 用 `claude --agent <project>-<role>` 走 agent 记忆

给每个 (project, role) 生成一份 agent 定义(`memory: user`)放进 `~/.claude/agents/`,spawn 时 `--agent`。

- 否决理由:要往机器级 `~/.claude/agents/` 写文件(触碰全局配置,项目规则禁止);`--agent` 会整体替换 system prompt / tools / permissionMode,与现有 `--append-system-prompt-file` 角色注入互相打架;`--agent` 主会话下项目记忆是否还加载,官方未定义。

### 路 D · 目录放进项目仓 `.flywheel/memory/<role>/` 并提交

- 否决理由:并行 runner 在各自分支写同一批文件 = 共享写点,合一个就让其余在飞分支全部冲突(CLAUDE.md 里程碑表已实测 100%);且记忆内容含大量内部判断,不该进公开仓。

### 目录根的选择(路 A 内部)

| 候选 | 取舍 |
|---|---|
| `~/.claude/agent-memory/<project>--<role>/` | 借 A 线私有仓备份顺路覆盖;但混进 Claude Code 自己管理的 Lead 目录树,「一个 Lead 一个文件夹」的说法被污染,且名字空间可能与 Lead id 撞 |
| **`~/.flywheel/runner-memory/<project>/<role>/`**(推荐) | Flywheel 自有、厂商中立(将来 Codex 可挂同一目录)、两级路径直接表达「项目 + 角色」;A 线备份多加一个根即可 |
| `~/.flywheel/memories/…` | 已被 3 月建的 memory-service 历史库占名,避免混淆 |

根可由 `FLYWHEEL_RUNNER_MEMORY_ROOT` 覆盖(隔离 Bridge / 529 台架用,与 `FLYWHEEL_STATE_DIR` 同一套「四件套」习惯)。

## 5. 未决问题(已非阻塞发给 Lead,按下面的默认继续)

| # | 问题 | 我的默认 |
|---|---|---|
| Q1 | 默认对所有 Claude runner 开,还是先 opt-in? | 我原默认「默认开 + `FLYWHEEL_RUNNER_MEMORY=off` 回退」。**Lead 裁定(2026-09-03)**:默认开,但**不留开关**(founder 直令:不加旋钮,写死);回退 = 代码回滚。plan 按裁定写 |
| Q2 | runner 切到角色目录后,项目共享那 573 条不再自动进上下文,可接受? | 可接受:prompt 里加**一行**指针「项目级共享记忆在 `<路径>`,需要时自己翻,不要往那里写」——有界(一行)、可见。存量不动、不迁移 |
| Q3 | Codex runner(implement 节点默认 codex)怎么办? | B0 只做 Claude 系:Codex runner 拿到同样的 `FLYWHEEL_RUNNER_MEMORY_DIR` 环境变量 + prompt 里同一行指针,不做原生挂载;PRD 已把 C1「查清 Codex 那边」划到后面 |
| Q4 | 写入时机(PRD B2「一个 issue 写一次」倾向) | 不写死进引擎:守卫文本里建议「收工前写,一次 ≤ 5 条,只写可复用的判断」;引擎不做写入回执 |

「别的角色该不该读到」——PRD 明说没讨论过;B0 不做访问控制(同一机器同一用户,盘上本来互相可见),注入面只给本角色那份。

**追加(2026-09-03,Codex 设计评审 R4 + Lead 裁定)**:挂载失败或没有身份的 Claude runner **不**退回项目共享记忆,而是 fail-closed(本次执行关掉自动记忆);否则 Q2「共享份只留只读指针」在失败路径上悄悄失效。代价是无 projectName 的 legacy 执行从此没有自动记忆,Lead 已接受。详见 plan §0.5「行为删除声明」。

## 6. 本 issue 明确不做

- 不迁移 / 不拆分现有 573 条项目记忆;不改 Lead 侧任何东西。
- 不做记忆备份到远端(A 线);只保证目录根稳定、可被 A 线的同步多加一行覆盖。
- 不做 Codex 原生记忆挂载(C1)。
- 不做跨角色读写策略、不做记忆内容质量审计。
