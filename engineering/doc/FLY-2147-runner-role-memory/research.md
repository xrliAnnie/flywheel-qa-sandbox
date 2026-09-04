# FLY-2147 runner 按角色+项目挂记忆目录 — 调研
Issue: FLY-2147 (https://linear.app/geoforge3d/issue/FLY-2147/2132b0-引擎能力runner-spawn-挂记忆目录角色项目)
日期: 2026-09-03
基于: exploration.md

> 本文是「改哪里、靠什么、会撞到什么」的代码级事实清单。每条标 【读代码】/【实测】/【文档】。
> 行号以本分支 HEAD `4c9466015` 为准。

---

## 1. 官方能力(Claude Code 2.1.259)

| 能力 | 事实 | 来源 |
|---|---|---|
| 重定向记忆目录 | settings 键 `autoMemoryDirectory`,绝对路径或 `~/` 开头,任意 settings 作用域可设 | 【文档】code.claude.com/docs/en/settings-reference.md;【实测】`--settings` 内联 JSON 生效,见 exploration §2.4 |
| 关闭记忆 | `autoMemoryEnabled: false` 或 env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`(本单不用) | 【文档】memory.md |
| 索引装载上限 | `MEMORY.md` 前 200 行或前 25KB(实测文案写 24.4KB),先到先截;只自动装载 `MEMORY.md`,正文文件按需读 | 【文档】memory.md;【实测】exploration §2.3 |
| 超限可见性 | 装载侧:给**模型**注入一条 WARNING(行数超:`MEMORY.md is N lines (limit: 200)…`;字节超:`WARNING: MEMORY.md is 31.7KB (limit: 24.4KB) — index entries are too long…`);**不进日志 / 事件**。写入侧:这次写会超时报错要求重写索引 | 【实测】两次 haiku 探针;【文档】memory.md |
| 目录初始化 | Claude Code 不预建 `MEMORY.md`;目录可为空 | 【实测】探针后目录仍为空 |
| slug 派生 | 按 git 仓库派生,同仓所有 worktree 共用一份 | 【文档】memory.md「Storage location」;【实测】231 个 worktree 目录 0 条 |
| `--agent` 主会话 | 会整体套用 agent 的 system prompt / tools / model / permissionMode / memory;与项目记忆是否共存**未文档化** | 【文档】cli 帮助;子代理调研 |

⇒ 结论:**用 `autoMemoryDirectory`**,不用 `--agent`,不自造注入。

## 2. spawn 链路注入点【读代码】

### 2.1 角色身份从哪来

| 派工形态 | 角色 id 来源 | 项目名来源 | 代码 |
|---|---|---|---|
| generalized(DAG 节点) | `ctx.generalizedExecutionContext.nodeId`(= `.flywheel/agents/registry.yaml` 的节点键:`eng_design` / `implement` / `qa` / `pm` / …) | `ctx.projectName`(runs-route 已用 `resolveCanonicalProjectName` 归一) | `Blueprint.ts:1725`, `runs-route.ts:1100` |
| legacy(label 派工) | `dispatchResult.agentName`(项目 agents 键;shipped 兜底为 `generic` / `qa`) | 同上 | `AgentDispatcher.ts:146-173` |

两者都是**已有的稳定标识**,不新造词表。generalized 与 legacy 的 `qa` 同名 ⇒ 同一目录,这正是 PRD 要的「所有在 flywheel 做 QA 的共用一份」。

### 2.2 prompt 装配处

`Blueprint.ts:2622-2681`:`agentContext = "## Agent Role" + 角色文本(≤40,000 字)`,然后 `systemPrompt = agentContext + "\n## Baseline Rules\n" + baseSystemPrompt`(`:2683`)。
守卫文本插在 `## Agent Role` 与 `## Baseline Rules` 之间,作为独立的 `## Runner Memory` 段——**只有有界的几行**(路径、行数/字节/预算、超限提示、项目共享记忆指针),索引正文由 Claude Code 原生装载,不经我们的 prompt。

### 2.3 adapter 上下文与 CLI 参数

- `packages/core/src/adapter-types.ts:133` `AdapterExecutionContext` —— 加 `runnerMemoryDir?: string`(第 12 个启动参数)。
- `Blueprint.ts:2796-2835` `adapter.execute({...})` —— 传 `runnerMemoryDir`。
- `TmuxAdapter.ts:1183` `buildClaudeArgs` —— `--settings` 已是唯一一处 settings JSON(`buildNonLeadClaudeSettings({enabledPlugins})`,`:1270`);在同一个 JSON 里加 `autoMemoryDirectory`。`buildNonLeadClaudeSettings` 是 deepMerge,不会丢已有键。
- `TmuxAdapter.ts:547` `appendPaneEnv(name, value)` —— 同时把名字加进 `allowedEnvNames`(正向环境边界),加 `FLYWHEEL_RUNNER_MEMORY_DIR` 即可;`CodexTmuxAdapter.ts:2144` 另有一处 env 装配,同样加一行。
- `--settings` 是内联 argv:值进入 tmux 命令预算(`TMUX_COMMAND_BUDGET_BYTES`,测试 `TmuxAdapter.test.ts:273-360`);路径约 60 字节,加上键名约 90 字节;`:1346` 断言 totalArgv < 6,000。需把 `FLYWHEEL_RUNNER_MEMORY_DIR` 加进 `:275` 那份「完整生产 allowlist」名单,否则那条预算测试不再代表生产形状。

### 2.4 现有同类模式(照抄的对象)

| 模式 | 代码 | 借鉴点 |
|---|---|---|
| commDbPath 由 `HOME/.flywheel/comm/<project>/comm.db` 派生 | `Blueprint.ts:2691-2701` | 根 = `process.env.HOME`,两级路径表达项目;缺 projectName 就不派生 |
| 隔离台架覆盖根目录 | `getStateDir()` 读 `FLYWHEEL_STATE_DIR` | 记忆根同样提供 env 覆盖 `FLYWHEEL_RUNNER_MEMORY_ROOT` |
| 一键回退 | `FLYWHEEL_RUNNER_DEFAULT_MODEL=off`(`:1224`) | **不照抄**:Lead 裁定(2026-09-03,founder 直令「不加旋钮,写死」)不留运行时开关;回退 = 代码回滚 |
| 非致命降级 + 日志 | `:1163-1168` transport 失败不阻断 spawn | 记忆目录建不了 / 索引读不了 ⇒ 不挂载、日志一行、prompt 一行说明,spawn 照常;但 Claude 侧**不退回**项目共享记忆,而是关掉自动记忆(fail-closed,见 §3) |

## 3. 有界与可见:守卫的具体口径

| 项 | 值 | 依据 |
|---|---|---|
| 硬上限(装载侧事实) | 200 行 / 25,000 字节 | Claude Code 文档;超过就丢后段 |
| 软预算(本单守卫阈值,写死常量) | **160 行 / 20,000 字节**,不提供 env 覆盖(Lead 裁定不加旋钮) | 留 20% 余量:让写入侧「这次写会超」的原生报错先于装载侧丢弃发生;eng-lead 今天 152 行/33KB 说明字节先爆,行数是次要维度 |
| 超软预算时 | 日志 `warn` 一行 + prompt 一行「索引 N 行 / M 字节,预算 160 行 / 20,000 字节;若超 200 行 / 25KB,第 K 行起不会被加载;开工第一步先把索引压回预算内(搬正文,不删条目)」 | Issue 硬约束「超界要说出来」;K 由我们按 25,000 字节 / 200 行两个维度算出**较早**的那个截断行 |
| 未超时 | 日志 `info` 一行(项目 / 角色 / 目录 / 行数 / 字节 / 预算内) | 「可见」不只在坏情况下可见 |
| 索引不存在(首跑) | 建目录 + 写一份 3 行的空索引头(标题 + 一行说明);日志写 `first_run` | 让「第一次跑」也留痕;不预填内容 |
| 挂载失败 / 没有身份 | **fail-closed(Lead 裁定 2026-09-03)**:Claude runner 按启动传 `autoMemoryEnabled:false`,本次没有任何自动记忆;日志 `warn`/`info` 带 `reason=`,prompt 一行 `NOT mounted … auto memory is DISABLED`,adapter 上下文 `runnerMemory.status="disabled"`。spawn 照常 | 我原稿写「退回项目共享记忆」,Codex R4 指出这让「共享份只留只读指针」的不变量在失败路径失效,Lead 裁定改为 fail-closed。代价:无 projectName 的 legacy 执行从此没有自动记忆 |

**不做的**:不由 Flywheel 截断索引再注入(那是路 B);不自动整理别人的索引;不把 WARNING 转成 Discord 告警(日志 + prompt 已双面可见,告警是另一单的判断)。

## 4. 目录布局与命名(设计定案)

```
~/.flywheel/runner-memory/                 ← 根;FLYWHEEL_RUNNER_MEMORY_ROOT 可覆盖
└── <project>/                             ← 归一后的 projectName(如 flywheel)
    └── <role>/                            ← nodeId 或 agentName(如 qa / eng_design / implement / generic)
        ├── MEMORY.md                      ← 短索引,Claude Code 原生装载(≤200 行/25KB)
        └── <type>_<slug>.md               ← 一事一文件,frontmatter name/description/type(与 Lead 侧同形)
```

标识合法性:`project` 与 `role` 都必须匹配 `^[a-z0-9][a-z0-9_.-]{0,63}$`(registry 键与 agents 键今天全部满足;`.`/`..` 被首字符规则排除);不匹配 ⇒ 不挂载 + 可见说明。路径只用 `path.join(root, project, role)`,不接受任何外部拼接。

显示标签:prompt 与日志里统一写 `<project>/<role>`,不另起中文别名(registry 的 `label` 是给菜单看的,不进这里,避免第二套词汇)。

## 5. 迁移 / 回滚 / 并发

- **迁移**:无。目录按需创建;既有项目共享记忆(573 条)原样不动,只在 prompt 留一行只读指针。
- **回滚边界**:代码回滚(去掉那一个键)⇒ CLI 回到项目共享记忆;目录里已写的内容留在盘上不删;无状态需要清理。没有运行时开关(Lead 裁定)。
- **并发**:同角色多 runner 同时写同一目录——正文一事一文件天然不冲突;`MEMORY.md` 由各自的 Edit 追加一行,存在极小的丢行窗口,与 Lead 侧今天单写者相比是新的暴露面。B0 接受并写进边界;不做锁(引擎加锁 = 长机制)。

## 6. Codex runner(C1 之前的最小处理)

`CodexTmuxAdapter` 不经 `buildClaudeArgs`,没有 `--settings`;它有自己的 `memories_1.sqlite`(PRD 已测:Lead 家全 0 条,runner 临时家跑完即删)。B0 只做:同一个 `FLYWHEEL_RUNNER_MEMORY_DIR` env + prompt 里同一段 `## Runner Memory`(路径 + 指针),让 Codex runner 至少**能翻**同角色的 Claude 记忆;不做原生挂载。

## 7. 测试锚点

| 层 | 文件 | 验什么 |
|---|---|---|
| 单元 | `packages/edge-worker/src/runner-memory.ts` 新 + `__tests__/runner-memory.test.ts` | 身份解析(generalized / legacy / 缺 projectName / 非法字符)、目录创建、首跑空索引、行数与字节两维截断行计算、预算内 / 超预算文案、根不可写降级 |
| 单元 | `packages/edge-worker/src/__tests__/Blueprint.fly2147-runner-memory.test.ts` | mock adapter 收到 `runnerMemoryDir`;prompt 含 `## Runner Memory` 段且位于 Agent Role 与 Baseline Rules 之间;`off` 时 prompt 与 ctx byte-identical |
| 单元 | `packages/claude-runner/test/TmuxAdapter.test.ts` | `--settings` JSON 含 `autoMemoryDirectory`;pane env 含 `FLYWHEEL_RUNNER_MEMORY_DIR`;FLY-1869 allowlist 名单与预算仍过 |
| 单元 | `packages/claude-runner/test/CodexTmuxAdapter.test.ts` | env 含该变量;FLY-1643 逐字 env 名单同步 |
| 隔离 | `packages/edge-worker/test/setup.ts` | 每个测试唯一临时 `FLYWHEEL_RUNNER_MEMORY_ROOT`(默认开的文件系统副作用不能落进 `~/.flywheel`) |
| 共享文法 | `packages/core/src/safe-identifier.ts` + `ProjectConfig.ts` 机械改引 | 标识文法只有一个定义;ProjectConfig 既有测试零改动 |
| 集成(真 CLI) | `scripts/` 或 test 里的 `claude -p --model haiku` 探针(两次 spawn 同 role,第二次读到第一次写的 marker) | PRD B 四条验收的直接证据;需要账号,标为 QA 节点跑 |

## 8. 撞到的既有事实(别踩)

- `appendPaneEnv` 自动进正向边界,但 `TmuxAdapter.test.ts:275` 的「完整生产 allowlist」是**手抄名单**,不加就是测试形状与生产形状分叉(FLY-1869 教训)。
- `--settings` 是内联 argv,长路径会吃 tmux 命令预算;根路径若被 `FLYWHEEL_RUNNER_MEMORY_ROOT` 指到很深的隔离目录,预算测试要覆盖「长根」形状。
- Claude Code 写入侧报错只在「本次写会超」时触发;存量已超的索引不会自动修——所以守卫文案要求 runner 开工先压索引,而不是等它写的时候才发现。
- `~/.flywheel/memories/` 已存在(memory-service 历史库位置,空),根目录名刻意用 `runner-memory` 避开。
