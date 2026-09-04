# FLY-2147 runner 按角色+项目挂记忆目录 — 实施计划
Issue: FLY-2147 (https://linear.app/geoforge3d/issue/FLY-2147/2132b0-引擎能力runner-spawn-挂记忆目录角色项目)
日期: 2026-09-03
基于: research.md

> **For agentic workers:** 在 TURN 持有的共享 worktree 内按批次 RED→GREEN 执行,每批一次 commit/push/progress。
> 本 plan 是被 pin 的设计;实现节点不得改写 plan 正文,发现偏差写 `design-correction.md` 附录。

**Goal:** Claude runner 在 spawn 时获得一个只由 **(project, role)** 决定的持久记忆目录;Claude Code 原生把该目录的短索引装进上下文、正文按需翻(与 Lead 侧同一机制);Flywheel 在 spawn 前对索引做**有界且可见**的守卫(预算内也留痕,超预算在日志与 prompt 两面说清从第几行起不会被加载);**没有运行时开关**(Lead 裁定 2026-09-03,founder 直令「不加旋钮,写死」),回退 = 代码回滚。

**Architecture:** 一个新纯函数模块 `packages/edge-worker/src/runner-memory.ts` 负责「身份解析 → 目录准备 → 索引度量 → 文案与日志行」;`Blueprint` 在拼 prompt 处调用它,把结果作为 `## Runner Memory` 段插进 Agent Role 与 Baseline Rules 之间,并把处置经 `AdapterExecutionContext.runnerMemory`(第 12 个启动参数:`mounted` 带目录 / `disabled` 带原因)交给 adapter;`TmuxAdapter` 把它写进已有的 `--settings` JSON(`autoMemoryDirectory`,或 fail-closed 的 `autoMemoryEnabled:false`)与 pane env(`FLYWHEEL_RUNNER_MEMORY_DIR`);`CodexTmuxAdapter` 只加 env。不新建服务、不加锁、不迁移任何存量记忆。

**Tech stack:** TypeScript(pnpm monorepo, vitest)、Claude Code 2.1.259 `autoMemoryDirectory` settings 键、既有 `buildNonLeadClaudeSettings` deepMerge、既有 `appendPaneEnv` 正向环境边界。

---

## 0. 不变量与文件地图

### 0.1 修改 / 新增的文件

| 文件 | 动作 | 内容 |
|---|---|---|
| `packages/edge-worker/src/runner-memory.ts` | 新增 | 身份解析、根解析、目录准备、有界索引度量、按 backend 分形的 prompt 段与日志行生成(纯函数 + 同步 fs;测试用真 fs + 临时根,不注入 fs) |
| `packages/core/src/safe-identifier.ts` + `packages/core/src/index.ts` | 新增 + 改 | `export const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/`(**逐字等于** `ProjectConfig.ts` 今天的局部 `SAFE_ID`),并从 core 根 index 再导出(core 只暴露根 index,不加就 import 不到) |
| `packages/teamlead/src/ProjectConfig.ts` | 改(机械) | 删局部 `const SAFE_ID = …`,改为 `import { SAFE_IDENTIFIER_RE } from "flywheel-core"` 并在原两处使用;正则字面量不变 ⇒ 既有 ProjectConfig 测试零改动、零行为变化。一个真相源,不做「平价测试」 |
| `packages/edge-worker/test/setup.ts` | 改 | 每个测试 `beforeEach` 设唯一临时 `FLYWHEEL_RUNNER_MEMORY_ROOT` 与临时 `HOME`、`afterEach` 清理(§2.1 Codex R1 #4:默认开的文件系统副作用必须与既有 Blueprint 套件隔离)。managed 路径无法用 HOME 重定向,由 Blueprint 的 `runnerMemoryPreparer` 注入缝解决:FLY-1188 与 FLY-2147 的确定性 harness 注入 `(input) => prepareRunnerMemoryMount({ ...input, managedSettings: { managedFile: <tmp>/absent.json, managedDropinDir: <tmp>/absent.d } })`;其它既有 Blueprint 测试不改(它们不断言记忆段),`runner-memory.test.ts` 继续用真文件系统 + 临时 managed 文件测扫描器本身 |
| `packages/edge-worker/src/__tests__/Blueprint.fly1188-codex-prompt.test.ts` + `.snap` | 改(快照有意更新) | 该 fixture 有 `projectName: "proj"` 但**没有任何角色来源**(无 `generalizedExecutionContext`、Blueprint 不带 `AgentDispatcher` ⇒ `dispatchResult` 为 null;`ctx.runnerName` 不在身份合同里;backend 默认 claude-tmux)⇒ `skipped reason=no_role`,而 fail-closed 政策(Lead 裁定)下 Claude 的 skipped **要出段**。所以快照**有意更新**,diff 只能多出确定性的 fail-closed 段(无机器路径);断言默认 Claude fixture 含 `NOT mounted (proj/-): no_role`、`auto memory is DISABLED`,adapter 收到 `{status:"disabled", reason:"no_role"}`;该文件里无身份的 Codex 调用也会多出 Codex 版 NOT-mounted 段——加一条聚焦断言(含 NOT-mounted 措辞、不含 Claude 设置词)。R3 时我写「快照不更新」是在 fail-closed 裁定之前,已被 Codex R5 #2 抓出矛盾,以本行为准 |
| `packages/edge-worker/src/__tests__/runner-memory.test.ts` | 新增 | §1.1 单元 RED 清单 |
| `packages/edge-worker/src/__tests__/runner-memory.encoding.test.ts` | 新增 | §1.1(4) 证明式单射测试(读仓内 registry / `.lead` 目录 + 固定样本 + 穷举 + 随机) |
| `packages/edge-worker/src/__tests__/fixtures/fly1188-prompt-before-fly2147.txt` | 新增(RED 批) | 改前捕获的 FLY-1188 默认 Claude fixture 完整 prompt;§2.1(10) 「diff 只多出 fail-closed 段」断言的尺子 |
| `packages/edge-worker/src/__tests__/fixtures/fly2147-prompt-golden-unsupported-backend.txt` | 新增(RED 批) | 改前捕获的「generalized qa、projectName `flywheel`、`runnerBackend: "antigravity-tmux"`」完整 prompt;§2.1(3) byte-identical 断言的尺子(未触碰 backend 的守卫)。**不留** no-project 金样本:fail-closed 后 Claude 的 no-project prompt 有意改变,用聚焦断言覆盖 |
| `packages/edge-worker/src/__tests__/Blueprint.fly2147-runner-memory.test.ts` | 新增 | §2.1 Blueprint 装配 RED 清单 |
| `packages/core/src/adapter-types.ts` | 改 | `AdapterExecutionContext` 加 `runnerMemory?: { status: "mounted"; dir: string } \| { status: "disabled"; reason: string }`(JSDoc 注明 FLY-2147、fail-closed 语义、undefined 只用于未触碰的 backend) |
| `packages/edge-worker/src/Blueprint.ts` | 改 | 构造函数**尾位**新增可选依赖 `runnerMemoryPreparer: typeof prepareRunnerMemoryMount = prepareRunnerMemoryMount`(Codex R7 #2:Blueprint 默认读真实 `/Library/Application Support/ClaudeCode/…`,测试台无法用 HOME 重定向它,必须有注入缝)。**Lead 裁定(2026-09-03)写死:这个缝只许测试台架用,生产组合永远传默认值;不得由 env / 配置 / CLI 参数选择,不得成为运行时开关**——§2.1(13) 的生产组合测试就是锁这一句的;在 `runInner` 的 `this.getAdapter(ctx.runnerBackend ?? "claude-tmux")` 处**引入** `const backend = …`(今天 runInner 里是重复表达式,没有这个常量)并复用;锚点 `const systemPrompt = agentContext ? …` 之前调用 runner-memory 并插段;锚点 `adapter.execute({` 调用里传 `runnerMemory`(挨着 `projectName: ctx.projectName`) |
| `packages/claude-runner/src/TmuxAdapter.ts` | 改 | `buildClaudeArgs` `--settings` JSON 加 `autoMemoryDirectory`;`appendPaneEnv("FLYWHEEL_RUNNER_MEMORY_DIR", …)` |
| `packages/claude-runner/src/CodexTmuxAdapter.ts` | 改 | `:2144` 旁加 `env.FLYWHEEL_RUNNER_MEMORY_DIR` |
| `packages/claude-runner/test/TmuxAdapter.test.ts` | 改 | §3.1:settings 键、pane env、FLY-1869 allowlist 名单加一项 |
| `packages/claude-runner/test/CodexTmuxAdapter.test.ts` | 改 | env 断言;**FLY-1643 那份逐字 `FLYWHEEL_*` env 名单加入 `FLYWHEEL_RUNNER_MEMORY_DIR`**(只加正向断言会让该名单测试变红) |
| `engineering/doc/milestones/FLY-2147.md` | 新增(PR 内) | 里程碑一文件(按 `engineering/doc/milestones/README.md` 单写者合同) |

### 0.2 明确不改

- 不改 Lead 侧任何东西(`~/.claude/agents/*`、`claude-lead.sh`、`agent-memory/`)。
- 不改 `~/.claude/settings.json` 等机器级配置;`autoMemoryDirectory` 只经 per-launch `--settings` 传。
- 不迁移 / 不拆 `~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/` 的 573 条。
- 不做 Codex 原生记忆挂载(C1);不做跨角色访问控制;不做索引自动整理;不把超限转成 Discord 告警。
- 不给 `antigravity-tmux` / `kimi-tmux` backend 挂载(它们不是 claude CLI,拿不到 settings 键):Blueprint 对这两种 backend **不算身份、`runnerMemory` 为 undefined、不输出段**——于是基类也不会加 env 或 settings 键。要不要给它们手工指针,留 Lead 另裁。

### 0.3 稳定标识(identifier contract)

| 标识 | 形态 | 归属 | 说明 |
|---|---|---|---|
| `role` | `ctx.generalizedExecutionContext.nodeId`(DAG)/ `dispatchResult.agentName`(legacy) | 既有 | **不新造词表**;两者同名即同目录(`qa` 与 `qa`) |
| `project` | `ctx.projectName`(runs-route 已归一) | 既有 | 缺失 ⇒ `skipped reason=no_project` |
| 标识合法字符 | `SAFE_IDENTIFIER_RE`(`flywheel-core`,= `ProjectConfig.ts` 今天的 `SAFE_ID`)+ 本模块常量 `RUNNER_MEMORY_ID_MAX_LENGTH = 128` | 共享 + 新 | 文法只有一个定义;128 上限是 runner-memory 自己的规则(NAME_MAX 之内),不改 ProjectConfig 的接受范围。project 在 ProjectConfig 边界已按此文法校验;**role 今天没有**——`.flywheel/agents/registry.yaml` 节点键、workflow manifest 节点 id、项目 agents 键在加载器里只校验非空(Codex R4 #3 实测)。**决定(Lead 裁定 2026-09-03):本单不改这三处加载器(范围纪律),例外文档化**:不合文法或超 128 的 role ⇒ `skipped reason=invalid_role`,fail-loud 可见(§0.4 日志 + §0.7 的 prompt 行与 adapter 上下文;`session_started` 事件不带它),Claude 执行按 fail-closed 关记忆;「默认对全部 Claude runner 开」的例外集合就是这些 role,**今天为空集由 §1.1(4) 的证明式测试先行断言**(仓内发现的全部 registry / Lead id 都合法,否则测试红)。承接去处:在三处加载器加同一文法校验另开 issue,由 Lead 开单;本单 §7 列为边界。`..`/`/` 被文法排除 |
| 盘上目录名编码 | `encodeMemoryPathComponent(name)`(可逆、单射、大小写折叠稳定):**直通集** = 全小写且不含 `--` 的名字,原样;**其余**(含大写,或含 `--`)⇒ `${name.toLowerCase()}--${mask}`,`mask` = 大写字符位置位图的小写十六进制(bit i = 第 i 个字符是大写;无大写时 `0`)。例:`sub` → `sub`;`Sub` → `sub--1`;`QA` → `qa--3`;`GeoForge3D` → `geoforge3d--209`;`a--b` → `a--b--0` | 新 | **Codex R2 #1 + R3 #1**:生产 macOS 卷大小写不敏感,`ProjectConfig` 又允许 `Sub` 与 `sub` 同时配置,role 也可能 `QA` / `qa`。R2 版的哈希后缀不是单射(`sub-21c1eb89` 本身是合法小写名,会撞 `Sub` 的编码),已废。现在:编码输出**总含** `--`,直通输出**不含** `--`,两个集合不交;编码输出可按「最后一个 `--`」切开还原原名,故单射。最长 128 + 2 + 32 = 162 < NAME_MAX。prompt / 日志的 `project=` `role=` 仍显示原名,`dir=` 显示编码后的真实路径 |
| 目录 | `<root>/<enc(project)>/<enc(role)>/` | 新 | `root` = `FLYWHEEL_RUNNER_MEMORY_ROOT`(**必须非空且 `path.isAbsolute`**,否则 `failed reason=invalid_root_override`,不回落)否则 `join(HOME.trim(), ".flywheel", "runner-memory")`,HOME 缺失/空 ⇒ `no_home`,HOME 非绝对 ⇒ `invalid_home`;只用 `path.join`,结果必为绝对路径 |
| 索引文件 | `MEMORY.md` | Claude Code 原生 | 首跑由我们写 3 行头(见 §0.6) |
| ctx 字段 | `AdapterExecutionContext.runnerMemory?: { status: "mounted"; dir: string } \| { status: "disabled"; reason: string }` | 新 | **不用一个可选字符串同时表达「未挂载」和「保持旧行为」**(Codex R4 #1)。`mounted`:dir 为绝对路径;`disabled`:**Flywheel 向 CLI 请求的启动处置**(传 `autoMemoryEnabled:false`),不是观测到的有效状态——除 `policy_conflict` 外它就是有效状态,`policy_conflict` 时有效状态**未知**(Rule A 不求解,Codex R7 #1);`reason` = skip/fail 原因(`no_project` / `fs:…` / `policy_conflict:…`);**undefined 只出现在 unsupported backend**(antigravity / kimi),表示对该 backend 一切不变 |
| settings 键 | mounted ⇒ `{ autoMemoryDirectory: dir, autoMemoryEnabled: true }`;disabled ⇒ `{ autoMemoryEnabled: false }`;undefined ⇒ 两键皆无 | Claude Code 原生 | 只在 `buildClaudeArgs` 的那一个 `--settings` JSON 里出现。**mounted 必须显式 `autoMemoryEnabled: true`**(Codex R5 #1):`autoMemoryDirectory` 只选位置,不开开关;若机器 / 项目级 settings 里有人关了自动记忆,`--settings` 只覆盖它提供的键,挂载会静默变成「有目录、不装不写」。这是处置的固定后果,不是旋钮。**边界**:managed settings 优先级高于 `--settings`,本机制赢不了它,也**不试图求解**它——每次 claude-tmux spawn 做一次「存在即冲突」探测(§0.8 `probeAutoMemoryPolicy`,Lead 裁定 A):官方文件型来源里出现任何 `autoMemory*` 键或 `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` ⇒ `failed reason=policy_conflict:<json>`(fail-closed 尽力传 false + fail-loud 带路径,prompt 明说有效状态未知)。不做合并、不做优先级求解、不加开关 |
| pane env | `FLYWHEEL_RUNNER_MEMORY_DIR` | 新 | 只在 `mounted` 时设;Claude 与 Codex runner 都有;hooks / 脚本可用 |
| fail-closed 处置 | claude-tmux 且非 mounted ⇒ `{ autoMemoryEnabled: false }` | Lead 裁定 2026-09-03 | 写死的失败处理,不是旋钮。Q2 的不变量「项目共享份只留只读指针」在失败路径上也成立;不许退回原生可读可写的项目共享记忆 |
| 运行时开关 | **无** | Lead 裁定 | founder 直令「不加旋钮,写死」;默认对所有 Claude runner 生效,回退只能代码回滚 |
| 软预算常量 | `RUNNER_MEMORY_DEFAULT_BUDGET = { lines: 160, bytes: 20_000 }` | 新 | 写死,不提供 env 覆盖 |
| 硬上限常量 | `RUNNER_MEMORY_HARD_LIMIT = { lines: 200, bytes: 25_000 }` | 新(转述文档) | Claude Code 装载侧事实;超过就不装 |
| 扫描上限常量 | `RUNNER_MEMORY_SCAN_CEILING_BYTES = 65_536` | 新 | Flywheel 守卫**最多读这么多字节**(Codex R1 #3):字节数用已打开描述符的 `fs.fstatSync(fd).size` 取精确值,行数只在「累计读入 == size」时精确,否则报 `>=N`;K 的计算只需前 201 行 / 25,001 字节,一定落在上限内 |
| backend 分形 | `claude-tmux` / `codex-tmux` / 其它 | 既有(`RoleAdapterResolver` 解析的 backend) | 只有 `claude-tmux` 得到原生挂载(settings 键)+ 完整段;`codex-tmux` 只得 env + 手工指针段;其它 backend 什么都不得 |
| 根覆盖 | `FLYWHEEL_RUNNER_MEMORY_ROOT`(Bridge 进程 env) | 新 | **唯一保留的 env**,且只是测试隔离缝(与 `FLYWHEEL_STATE_DIR` 同族:隔离 Bridge / 529 台架不许写进生产根),不是行为旋钮 |
| prompt 段标题 | `## Runner Memory` | 新 | 位于 `## Agent Role` 之后、`## Baseline Rules` 之前 |
| 状态词 | `mounted` / `skipped` / `failed` | 新 | skipped 原因:`no_project` `no_role` `invalid_project` `invalid_role` `unsupported_backend`;failed 原因:`invalid_root_override` `no_home` `invalid_home` `policy_conflict:<json>` `fs:<err.message>`;mounted 附加可见字段:`settings_unreadable=<json>`(非 managed 来源读不了/不是 JSON 对象/超 1MB 时列出;managed 来源读不了直接算 conflict)。`<json>` = 紧凑 JSON 数组字符串(路径可含空格,k=v 单行里只有 JSON 编码是无歧义的) |

### 0.4 显示标签(日志,逐字;测试 grep 这些串)

```
[Blueprint] runner-memory mounted backend=<b> project=<p> role=<r> dir=<abs> index=<L|>=L>L/<B>B budget=160L/20000B hard=200L/25000B first_run=<true|false> over_budget=false[ settings_unreadable=<json>]
[Blueprint] runner-memory OVER BUDGET backend=<b> project=<p> role=<r> dir=<abs> index=<L|>=L>L/<B>B budget=160L/20000B hard=200L/25000B first_dropped_line=<K|none>[ settings_unreadable=<json>]
[Blueprint] runner-memory skipped reason=<no_project|no_role|invalid_project|invalid_role|unsupported_backend> backend=<b> project=<p|-> role=<r|->[ settings_unreadable=<json>]
[Blueprint] runner-memory failed backend=<b> project=<p|-> role=<r|-> dir=<abs|-> reason=<reason> (no role memory this session)[ settings_unreadable=<json>]
```
- `<L|>=L>`:文件 ≤ 扫描上限时是精确行数(如 `152L`),否则是 `>=412L`(扫描到上限为止的行数,前缀 `>=`)。
- `dir=-`:根还没算出来就失败(`invalid_root_override` / `no_home` / `invalid_home` / `policy_conflict`)时的形态。`dir=` 永远是编码后的真实路径;`project=` / `role=` 是原名;身份缺项时显示 `-`。
- `policy_conflict` 的 `reason` 逐字形如 `policy_conflict:["/Library/Application Support/ClaudeCode/managed-settings.json:autoMemoryEnabled","<cwd>/.claude/settings.json:env.CLAUDE_CODE_DISABLE_AUTO_MEMORY"]`(每项 `<来源路径>:<键路径>`,按探测顺序);`settings_unreadable=` 同样是 JSON 数组。可选字段只在非空时出现,claude 的四种行(mounted / OVER BUDGET / skipped / failed)都带。
- 日志行的读法:它是「k=v 序列 + 末尾内嵌紧凑 JSON 值」,JSON 值内部可含空格,要用括号感知的解析或直接 `JSON.parse` 取 `[` 到行尾——**不是**按空格切分的纯 token 行(Codex R7 #3)。测试用正则 `settings_unreadable=(\[.*\])$` 取值再 `JSON.parse`。
- `mounted` 与 `skipped` 用 `console.info`,`OVER BUDGET` / `failed` 用 `console.warn`。
- prompt 里的显示统一为 `<project>/<role>`,不用 registry 的中文 label。

prompt 段逐字模板(英文,与 Blueprint 其余 prompt 一致;`{}` 为占位,实现用字符串拼接,不用模板引擎)。**段的换行合同**:非空时以 `## Runner Memory\n` 开头、以恰好一个 `\n` 结尾、内部不含空行;空串表示不输出。

**claude-tmux 形态**(原生挂载):
```
## Runner Memory
- Role memory directory ({project}/{role}): {dir}
  This is the persistent memory directory Claude Code loads for you this session. It is shared by every `{role}` runner of project `{project}` across issues, worktrees and executions; it survives worktree deletion.
- Index MEMORY.md: {L} lines / {B} bytes — within budget (160 lines / 20,000 bytes; Claude Code stops loading at 200 lines / 25,000 bytes).
- Write rule: one fact per topic file with frontmatter (name/description/type), one pointer line in MEMORY.md. Prefer writing at the end of your work, at most ~5 durable, reusable judgments per execution. Never store tokens, keys or secrets.
- Project-wide shared memory (all roles + founder sessions; what runners used before FLY-2147): {legacyProjectMemoryDir} — read on demand for project facts; do not write there.
```
超硬上限时第 3 行替换为(其余不变):
```
- ⚠ Index MEMORY.md OVER BUDGET: {L} lines / {B} bytes (budget 160 lines / 20,000 bytes). Claude Code loads only the first 200 lines / 25,000 bytes: entries from about line {K} onward were NOT loaded this session. FIRST TASK before any other work: bring MEMORY.md back under budget — consolidate related topic files and replace or drop superseded index pointers; keep every fact (move detail into topic files), never lose information. Then continue.
```
超软预算、未超硬上限时第 3 行替换为:
```
- ⚠ Index MEMORY.md OVER BUDGET: {L} lines / {B} bytes (budget 160 lines / 20,000 bytes; Claude Code stops loading at 200 lines / 25,000 bytes). Nothing was dropped yet. Before you finish this execution, bring MEMORY.md back under budget the same way (consolidate topic files, replace or drop superseded pointers, keep every fact).
```
- `{L}` 在文件超扫描上限时写成 `>= {N}`。
- 首跑时第 3 行为 `- Index MEMORY.md: first run — the index is empty; write what this role learns here.`
- `legacyProjectMemoryDir` 只在盘上存在时才输出那一行(直接检查,不猜);不存在就整行省略。
- claude-tmux `failed` **或 `skipped`(身份类原因)** 时整段替换为(fail-closed,Lead 裁定):标题 + `- Role memory NOT mounted ({project|-}/{role|-}): {reason}. Claude Code auto memory is DISABLED for this session (fail-closed, FLY-2147): Claude Code will not load or automatically write an auto-memory index this session. Report this line to your Lead in your first status report.` + (可解析时)项目共享记忆的只读指针行(仍是 `read on demand … do not write there`)。措辞只说设置真正做到的事(Codex R5 #3):它不让文件系统写入变临时,也不阻止手工编辑——访问控制不在本单。
- claude-tmux `failed reason=policy_conflict:…` 时第 2 行改为:`- Role memory NOT mounted ({project|-}/{role|-}): {reason}. A Claude Code settings source outside Flywheel's control sets auto-memory policy, so the effective memory state of this session is UNKNOWN (Flywheel passed autoMemoryEnabled:false as a best effort and does not resolve settings precedence). Report this line to your Lead in your first status report.`(不写 DISABLED——我们不知道它是否生效)。

**codex-tmux 形态**(只有 env + 手工指针;不声称任何自动装载):
```
## Runner Memory
- Role memory directory ({project}/{role}): {dir} (also in env FLYWHEEL_RUNNER_MEMORY_DIR). It is shared with the Claude runners of the same project/role. Native loading for Codex is deferred (FLY-1984 C1): nothing from it is loaded automatically — read {dir}/MEMORY.md yourself when you need this role's past lessons, and write new lessons there in the same shape (one fact per topic file, one pointer line in MEMORY.md).
- Project-wide shared memory (all roles + founder sessions): {legacyProjectMemoryDir} — read on demand for project facts; do not write there.
```
- codex 形态**不含**索引行数/预算/K 行(Codex 不装载,说了就是假合同);守卫仍量索引、仍打同样的日志行(可见性是运维侧的)。
- codex `failed` / `skipped`(身份类原因)时:标题 + `- Role memory NOT mounted ({project|-}/{role|-}): {reason}. No role memory directory this session. Report this line to your Lead in your first status report.` + 只读指针行。
- 负向断言(§3.1 / §2.1):codex 输出不含 `Claude Code loads`、不含 `were NOT loaded`、不含 `auto memory is DISABLED`;codex argv 不含 `autoMemoryDirectory` 也不含 `autoMemoryEnabled`。

**其它 backend**(antigravity / kimi):`skipped reason=unsupported_backend`,**不输出段、不传字段**——这是唯一 prompt 与 argv 都与改前 byte-identical 的路径。

### 0.5 迁移与回滚边界

- **迁移**:无。目录按需建;存量项目记忆原样。
- **回滚**:只有代码回滚(revert PR 后重启 Bridge)。没有运行时开关——Lead 裁定,founder 直令。回滚后 CLI 回到项目共享记忆;盘上 `~/.flywheel/runner-memory/` 保留,不清。§2.1 用 unsupported backend 路径锁住「本单没碰的 backend 与改前 byte-identical」。
- **行为删除声明(Lead 裁定 2026-09-03,写在这里防止被当 bug 改回去)**:今天,任何 Claude runner 都自动读写 `~/.claude/projects/-Users-…-Dev-flywheel/memory/`(项目共享记忆)。**本单之后不再有**——挂载成功的 Claude runner 读写自己的角色目录;挂载失败或没有身份(无 projectName / 无 role / 非法标识 / 根不可用)的 Claude runner 按启动传 `autoMemoryEnabled:false`,本次执行**没有任何自动记忆**。**唯一例外**:`policy_conflict`(某份 settings 来源出现了自动记忆相关键)——我们同样传 `false`,但按 Rule A 不判断它是否生效,有效状态**未知**,prompt 与日志明说,由 Lead 处理那台机器。为什么:Q2 的不变量是「项目共享份只留一行只读指针」,若失败路径退回原生可读可写共享记忆,这条不变量就在失败路径上悄悄失效(半开状态),而失败路径恰恰是最容易被忽略的。代价:无 projectName 的 legacy 执行(今天有自动记忆)从此没有——Lead 已接受。要求:这类执行必须 fail-loud——§0.4 日志行带 `reason=`,prompt 段明说 `auto memory is DISABLED`(policy_conflict 时为 UNKNOWN),`runnerMemory.status="disabled"` 可被 adapter 执行上下文与 adapter 测试看到(CommDB 的 `registerSession` 今天不持久化它,不假装);不许静默。
- **前向**:A 线(私有仓备份)只需把 `~/.flywheel/runner-memory` 作为第二个根加进同步;C1(Codex 原生)可复用同一目录与 env。

### 0.6 负向守卫

| 情形 | 行为 | 可见性 |
|---|---|---|
| backend 不是 claude-tmux / codex-tmux | 不算身份、不挂载;prompt / argv / env 与改前 byte-identical | `skipped reason=unsupported_backend` |
| 无 projectName / 无 role | 不挂载;claude-tmux ⇒ `autoMemoryEnabled:false`(fail-closed);prompt 段 `NOT mounted … DISABLED` | `skipped reason=no_project|no_role` |
| 标识含非法字符(含 `..`、`/`、空串、超 128 字符) | 不挂载,不拼路径;claude-tmux ⇒ fail-closed 同上 | `skipped reason=invalid_*` |
| `FLYWHEEL_RUNNER_MEMORY_ROOT` 为空串 / 相对路径 | 不挂载,**不回落到 HOME**(隔离台架设错了必须可见,不能悄悄写进生产根) | `failed reason=invalid_root_override dir=-` |
| HOME 缺失 / 空 / 只有空白(trim 后为空)且无覆盖 | 不挂载 | `failed reason=no_home dir=-` |
| HOME(trim 后)是相对路径且无覆盖 | 不挂载(不能让记忆落进 Bridge cwd 或某个 checkout) | `failed reason=invalid_home dir=-` |
| 仅大小写不同的项目名或角色名(`Sub`/`sub`,`QA`/`qa`),或形如编码输出的原始名(`sub--1`) | 编码单射,各自一份 | `dir=` 里可见 `--<mask>` 后缀 |
| 根不可写 / mkdir 失败 / 索引读取失败 | claude-tmux ⇒ `autoMemoryEnabled:false`,不设 env;codex ⇒ 不设 env;prompt 段 `NOT mounted`;spawn 继续 | `failed reason=fs:…` + prompt |
| 官方文件型 settings 来源里出现任何 `autoMemory*` 键或 `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY`(每次 claude-tmux spawn 探测,在身份判断与任何 fs 副作用之前) | 存在即冲突(Lead 裁定 A):不建目录、不装载;`runnerMemory={status:"disabled", reason}`,尽力传 `autoMemoryEnabled:false`;prompt 段 NOT-mounted 明说有效状态未知;spawn 继续 | `failed reason=policy_conflict:<json> dir=-` |
| managed 来源存在但读不了 / 超 1MB / 不是 JSON 对象 | 同上,算 conflict(排除不了) | `policy_conflict:["<path>:unreadable"]` |
| 非 managed 来源读不了 / 超 1MB / 不是 JSON 对象 | 仍 mounted,说出来 | `mounted … settings_unreadable=<json>` |
| 索引文件超扫描上限(64KB)或发生短读 | 最多读 64KB;字节用 `fs.fstatSync(fd).size`;行数报 `>=N`;K 照常算出;仍挂载 | `OVER BUDGET … index=>=NL/…B first_dropped_line=K` |
| 索引 > 软预算 | 仍挂载(Claude Code 自己会截);prompt 与日志说明 K | `OVER BUDGET … first_dropped_line=K` |
| 索引 > 硬上限 | 同上,K 为按「200 行 / 25,000 字节」两维取**先到**者算出的 1-based 行号 | 同上 |
| 首跑(无 `MEMORY.md`) | 写 3 行头:`# {project}/{role} runner memory index`、空行、`<!-- one pointer line per topic file; keep under 160 lines / 20,000 bytes -->` | `first_run=true` |
| `MEMORY.md` 存在但是目录 / 不可读 | 视为 failed | `failed` |

K 的算法(写进测试):在前缀缓冲(≤ 64KB)上逐行累加 `Buffer.byteLength(line + "\n")`;第一个满足 `index > 200` **或** `累计字节 > 25_000` 的行号即 K;都不满足 ⇒ `none`。这是对装载侧行为的**近似**(Claude Code 未文档化精确切法),prompt 文案用 `about line`。

有界读的机械保证(Codex R1 #3 + R2 #2 + R3 #2/#3),逐字写进实现。`runner-memory.ts` **用默认导入** `import fs from "node:fs"` 并一律经 `fs.` 调用(NodeNext ESM 下 `vi.spyOn(fs, "readSync")` 只能拦截默认对象上的属性,拦不住具名导入的绑定——Codex R3 #3 实测):
```ts
const fd = fs.openSync(indexPath, "r");
try {
  const size = fs.fstatSync(fd).size;                    // 绑定到已打开的对象,不再 stat 路径
  const buf = Buffer.alloc(Math.min(size, RUNNER_MEMORY_SCAN_CEILING_BYTES));
  let filled = 0;
  while (filled < buf.length) {                          // 累计请求 + 累计读入都 ≤ 上限
    const n = fs.readSync(fd, buf, filled, buf.length - filled, filled);
    if (n === 0) break;                                  // 短读 / 并发截短:到此为止
    filled += n;
  }
  return measureIndexPrefix({ prefix: buf.subarray(0, filled), size });
} finally {
  fs.closeSync(fd);                                       // 成功与异常都关
}
```
`measureIndexPrefix({ prefix, size })` 是唯一签名:`bytes = size`(精确);`linesExact = prefix.length === size`(文件 ≤ 上限且没有短读),否则 `lines` 报 `>=N`。测试:① `ftruncate` 造 8MB 稀疏文件(前 1KB 是 300 行短指针)⇒ `overHard=true, K=201, bytes=8_388_608, lines>=300`,`vi.spyOn(fs, "readSync")` 断言**累计**请求长度 ≤ 65_536、`vi.spyOn(fs, "closeSync")` 被调用一次;② `vi.spyOn(fs, "readSync")` 桩成第一次只返回 100 字节、第二次返回 0(强制短读)⇒ 断言桩**确实被调用了两次**,`linesExact=false`,`bytes` 仍 = size;③ `vi.spyOn(fs, "fstatSync")` 抛错 ⇒ `closeSync` 仍被调用且结果为 `failed reason=fs:…`。`fs.readFileSync` 不得用于 `MEMORY.md`。

### 0.7 fail-loud 的三个可见面(Lead 裁定)

| 面 | 载体 | 内容 |
|---|---|---|
| 运维日志 | §0.4 的 k=v 结构化行 | `skipped reason=<…>` / `failed reason=<…>` 含 backend / project / role |
| runner prompt | §0.4 的 `NOT mounted … DISABLED` 行(`policy_conflict` 时是 `… UNKNOWN` 行) | 要求 runner 在第一次状态报告里转述给 Lead |
| adapter 上下文 | `runnerMemory.status === "disabled"` + `reason` | adapter 测试可断言;`session_started` 事件在挂载之前就已发出(`emitStarted` 早于 prompt 装配),**本单不改事件载荷**,不假装事件里有它 |

### 0.8 安全与边界

- **settings 层级:每次 spawn 探测「存在即冲突」,不求语义有效值(Lead 裁定 A,2026-09-03;收回此前「实测有效值」的开放要求——按字面做会长出一个设置优先级求解器)**。写死的口径:
  - **来源(只读官方文件型,按此顺序)**:① macOS managed 基础文件 `/Library/Application Support/ClaudeCode/managed-settings.json`;② 同目录 `managed-settings.d/*.json`(按文件名排序,逐个作为独立来源);③ `<home>/.claude/settings.json`(HOME 可用时);④ `<cwd>/.claude/settings.json`(runner worktree);⑤ `<projectRoot>/.claude/settings.local.json`(worktree 下项目 local 文件在主仓根)。**没有** `~/.claude/settings.local.json`(官方无此文件)。①② 为 managed 类,③④⑤ 为非 managed 类。测试可注入 `{ managedFile, managedDropinDir }` 替换①②的路径。
  - **判定**:每个来源最多读 1MB(§0.6 同形的有界读);不存在 ⇒ 跳过;读到的顶层对象里**任何以 `autoMemory` 开头的键**,或 `env` 对象里含 `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 键 ⇒ 记一条 conflict `<path>:<键路径>`——**不看值**(`true`/`false`/任何目录都算);读不了 / 超 1MB / 不是 JSON 对象:managed 类 ⇒ conflict `<path>:unreadable`,非 managed 类 ⇒ `unreadable` 列表。
  - **处置**:conflict 非空 ⇒ `failed reason=policy_conflict:<json>`(在身份判断与 mkdir 之前;fail-closed 尽力传 `autoMemoryEnabled:false`,prompt 明说有效状态未知);否则照常挂载,`unreadable` 非空时日志追加 `settings_unreadable=<json>`(mounted 与 OVER BUDGET 都带)。
  - **不做**:不合并、不算优先级、不解释 managed 的 `true` 与 `false` 谁赢、不加开关。MDM / 服务器策略 / policy helper 这些非文件型来源**探测不到**,写在 §7 边界,不假装覆盖。
  - 环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY`:Bridge 进程环境经 pane 正向边界不放行(测试断言不在 allowlist);来自 settings `env` 块的那一份由上面的 conflict 规则抓。
  - 测试(`runner-memory.test.ts`,注入临时 managedFile / dropinDir / HOME / cwd / projectRoot):managed 基础文件 `{"autoMemoryEnabled":true}` ⇒ conflict(值为 true 也算);drop-in `zz.json` 含 `autoMemoryDirectory` ⇒ conflict 列出该 drop-in 路径且顺序在基础文件之后;`<cwd>/.claude/settings.json` 含 `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` ⇒ conflict;`<projectRoot>/.claude/settings.local.json` 含 `autoMemoryEnabled:false` ⇒ conflict(worktree 下主仓 local 也在扫);`~/.claude/settings.json` 只有无关键 ⇒ 无 conflict;managed 基础文件 2MB ⇒ conflict `:unreadable`;`<cwd>/.claude/settings.json` 坏 JSON ⇒ mounted + `settings_unreadable=["…"]`;含空格的路径在 JSON 里正确转义;超预算索引 + unreadable ⇒ OVER BUDGET 行也带字段;五个来源全不存在 ⇒ 无可选字段。

- 路径只由白名单字符的两个标识与固定根拼成;根来自 Bridge 进程 env(受信),不来自 HTTP。
- 记忆内容由本机 runner 写、本机 runner 读,信任等级与 Lead 记忆相同;prompt 段只放路径与数字,不把索引内容再经我们的 prompt 二次注入。
- `--settings` 值经 `JSON.stringify`,路径不需要额外转义;tmux 命令预算由既有 FLY-1869 测试覆盖(§3.1 加长根形状)。

---

## 1. 第一批:`runner-memory.ts` 纯函数(RED → GREEN)

### 1.1 RED:`packages/edge-worker/src/__tests__/runner-memory.test.ts`

用 `mkdtempSync` 造根;fs 直接用真 fs(同步)。每条一个 `it`:

1. 常量:`RUNNER_MEMORY_DEFAULT_BUDGET` 严格小于 `RUNNER_MEMORY_HARD_LIMIT`(两维都断言),防止有人以后把预算改到硬上限之上让守卫失效。
2. `resolveRunnerMemoryIdentity({backend, projectName, nodeId, agentName})`:backend 不在 {claude-tmux, codex-tmux} ⇒ `unsupported_backend`(先于其它判断);nodeId 优先于 agentName;两者皆无 ⇒ `no_role`;projectName 缺 ⇒ `no_project`;`../x` / `a/b` / 空串 / 129 字符 ⇒ `invalid_*`;`eng_design` `qa` `generic` `flywheel` `GeoForge3D` `my.project` `A`(单字符)`128 字符` 合法且原名**大小写保留**(显示用)。
3. `resolveRunnerMemoryRoot(env)`:`FLYWHEEL_RUNNER_MEMORY_ROOT` 非空且绝对 ⇒ 用它;为空串或相对路径 ⇒ `{ok:false, reason:"invalid_root_override"}`;未设时 `HOME.trim()` 绝对 ⇒ `join(HOME.trim(), ".flywheel", "runner-memory")`;HOME 缺失 / 空 / 全空白(trim 后为空)⇒ `no_home`;HOME(trim 后)相对(`relative/home`)⇒ `invalid_home`。返回值一定 `path.isAbsolute`。
4. `encodeMemoryPathComponent` / `decodeMemoryPathComponent`(Lead 裁定 2026-09-03:必须是**证明式**测试,不是举例):
   - 例值:`flywheel` ⇒ `flywheel`;`qa` ⇒ `qa`;`Sub` ⇒ `sub--1`;`QA` ⇒ `qa--3`;`GeoForge3D` ⇒ `geoforge3d--209`;`a--b` ⇒ `a--b--0`。
   - **影子对抗**:`const shadow = encode("Sub"); expect(encode(shadow)).not.toBe(shadow)`(`sub--1` 含 `--` ⇒ 编码成 `sub--1--0`)。
   - **单射性证明式测试**(`runner-memory.encoding.test.ts`):样本全集 U = ① 仓内 `.flywheel/agents/registry.yaml` 的全部节点键(测试时真读该文件)∪ ② 仓内 `.lead/*/` 的全部 Lead id 目录名 ∪ ③ 固定写死的 16 个生产 Lead id(`flywheel-eng-lead` … `tidal-echo-cos-lead`,见 PRD 事实底稿)∪ ④ 对抗样本 {`sub`,`Sub`,`SUB`,`sUb`,`sub-21c1eb89`,`sub--1`,`sub--1--0`,`qa`,`QA`,`qa--3`,`GeoForge3D`,`geoforge3d--209`,`A`,`a`、128 字符全大写、128 字符混合、128 字符全小写、含 `..` 但合法的 `a..b`} ∪ ⑤ 对 `sub`、`geoforge3d`、`ab-cd.e` 三个基名**穷举全部 2^n 大小写变体** ∪ ⑥ 用固定种子从文法 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` 生成 5,000 个随机串。**先行断言(Lead 裁定 / Codex R4 #3)**:① ② ③ 里**每一个**仓内发现的真实标识都匹配 `SAFE_IDENTIFIER_RE` 且 ≤ 128——任何一个不合法就让测试红并列出它,**不许**把真实标识当「非法样本」过滤掉(这是「例外集合今天为空」的证明,而不是假设)。然后断言:(a) U 中全部样本两两 `encode` 结果**互不相同**(用 Map 统计,碰撞即列出两方);(b) 对每个 x,`decode(encode(x)) === x` 且 `Buffer.compare` 逐字节相等;(c) 每个输出匹配 `SAFE_IDENTIFIER_RE` 且长度 ≤ 162;(d) 直通集与编码集不交(输出含 `--` 当且仅当输入含大写或含 `--`);(e) 大小写折叠稳定:`encode(x).toLowerCase() === encode(x)`。非法样本(如 `-`、129 字符)单独放在 `resolveRunnerMemoryIdentity` 的拒绝测试里,不混进 U。
   - `prepareRunnerMemoryMount` 对 `Sub`/`sub` 两个项目返回不同 `dir`,且 `project` 字段保留原名。`ProjectConfig.ts` 改为引用 `SAFE_IDENTIFIER_RE` 后,其既有测试零改动全绿(机械替换的证据)。
5. `measureIndexPrefix({prefix, size})`:空文件 ⇒ 0L/0B;3 行普通 ⇒ 正确计数(UTF-8 多字节按字节);K 计算:218 行短行 ⇒ K=201;153 行每行 ~210 字节 ⇒ K 为累计首超 25,000 的那行(用固定 fixture 算出期望值写死);100 行小文件 ⇒ `none`;**218 行全是短指针的合法索引** ⇒ `overHard=true, K=201`(这是 #7 那条文案要能被满足的情形);`size > 65_536` ⇒ `linesAtLeast` 形态。
6. `prepareRunnerMemoryMount(...)`:
   - 首跑:目录被创建(0o700)、`MEMORY.md` 三行头存在、返回 `first_run=true`、`status=mounted`;
   - 第二次:不改写已有 `MEMORY.md`(内容 byte-identical)、`first_run=false`;
   - 索引 170 行 ⇒ `overBudget=true, overHard=false, firstDroppedLine=none`;218 行 ⇒ `overHard=true, K=201`;
   - 根路径是一个普通文件 ⇒ `status=failed`,reason 以 `fs:` 开头;
   - `MEMORY.md` 是目录 ⇒ `failed`;
   - 8MB 稀疏文件 ⇒ 见 §0.6 的有界读断言;
   - `FLYWHEEL_RUNNER_MEMORY_ROOT=""` / `=relative/dir` ⇒ `failed reason=invalid_root_override`,`dir` 为 undefined;HOME 删掉且无覆盖 ⇒ `failed reason=no_home`;`HOME=relative/home` ⇒ `invalid_home`;
   - fd 生命周期与短读:见 §0.6 有界读的三条测试。
   - settings 「存在即冲突」探测:见 §0.8 的测试清单(值为 true 也算、drop-in 顺序、cwd 与主仓 local 两处、managed 超 1MB 算 conflict、非 managed 坏 JSON 只记 unreadable、空格路径 JSON 转义、OVER BUDGET 行带字段、全无来源无字段)。
   - 顺序:conflict 发生在 mkdir 之前 ⇒ 断言 conflict 时目录**不存在**。
7. `buildRunnerMemoryPromptSection(mount, {legacyProjectMemoryDir})`(backend 来自 `mount`,不是 opts):
   - claude mounted+预算内 ⇒ 以 `## Runner Memory\n` 开头、以单个 `\n` 结尾、含 `within budget (160 lines / 20,000 bytes`、dir 逐字、`{project}/{role}` 逐字;
   - claude 超硬 ⇒ 含 `OVER BUDGET` 与 `from about line 201 onward were NOT loaded`、`FIRST TASK`、`replace or drop superseded index pointers`;
   - claude 超软未超硬 ⇒ 含 `Nothing was dropped yet`,不含 `NOT loaded`;
   - claude 首跑 ⇒ 含 `first run — the index is empty`;
   - claude 超扫描上限 ⇒ 含 `>= 300 lines`;
   - `legacyProjectMemoryDir` 不存在 ⇒ 不含 `Project-wide shared memory`;存在 ⇒ 含且路径逐字;
   - claude failed(`fs:` / 根类原因)⇒ 含 `NOT mounted` 与 reason、`auto memory is DISABLED`;claude skipped(`no_project` 等)⇒ 同形,`project|role` 缺的位置显示 `-`;
   - claude failed `policy_conflict:…` ⇒ 含 `NOT mounted`、reason 逐字(含 JSON 数组)、`UNKNOWN`;**不含** `auto memory is DISABLED`、不含 `will not load`(Codex R7 #1:Rule A 不知道它是否生效,不许声称);
   - codex mounted ⇒ 含 `Native loading for Codex is deferred`、`FLYWHEEL_RUNNER_MEMORY_DIR`、dir 逐字;**不含** `Claude Code loads`、`NOT loaded`、`within budget`;
   - codex failed / skipped ⇒ 含 `NOT mounted`,不含 `auto memory is DISABLED`;
   - `unsupported_backend` ⇒ 返回空串(唯一返回空串的情形)。
8. `formatRunnerMemoryLogLine(mount)`:逐字匹配 §0.4 四种形状(用正则锁字段顺序),含 `index=>=300L` 与 `dir=-` 两个变体。
9. `resolveLegacyProjectMemoryDir({repoRoot, home, exists})`:`/Users/x/Dev/flywheel` ⇒ `<home>/.claude/projects/-Users-x-Dev-flywheel/memory`;`exists` 返回 false ⇒ undefined;`home` 为空串 ⇒ undefined(调用方在 HOME 非空时才调用,这里再守一次)。

### 1.2 GREEN:`packages/edge-worker/src/runner-memory.ts`

导出(全部具名、带 JSDoc、`type` 不用 `interface`):

```ts
export const RUNNER_MEMORY_HARD_LIMIT = { lines: 200, bytes: 25_000 } as const;
export const RUNNER_MEMORY_DEFAULT_BUDGET = { lines: 160, bytes: 20_000 } as const;
export const RUNNER_MEMORY_SCAN_CEILING_BYTES = 65_536;
export type RunnerMemoryBackend = "claude-tmux" | "codex-tmux";
export type RunnerMemoryIdentity = { project: string; role: string };
export type RunnerMemorySkipReason = "no_project" | "no_role" | "invalid_project" | "invalid_role" | "unsupported_backend";
export type RunnerMemoryIndexStats = { lines: number; linesExact: boolean; bytes: number; firstRun: boolean; overBudget: boolean; overHard: boolean; firstDroppedLine: number | undefined };
export type RunnerMemoryPolicyProbe = { conflicts: string[]; unreadable: string[] };   // 每项 "<path>:<key-path>" / "<path>:unreadable" / "<path>"
export type RunnerMemoryMount =
  | { status: "mounted"; backend: RunnerMemoryBackend; project: string; role: string; dir: string; index: RunnerMemoryIndexStats; policy?: RunnerMemoryPolicyProbe }
  | { status: "skipped"; reason: RunnerMemorySkipReason; backend: string; project?: string; role?: string; policy?: RunnerMemoryPolicyProbe }
  | { status: "failed"; backend: RunnerMemoryBackend; project?: string; role?: string; dir?: string; reason: string; policy?: RunnerMemoryPolicyProbe };
// policy 的归属合同(Codex R7 #3):claude-tmux 的三种结果**都**带 policy(探测在最前面,结果一路带下去;无发现时为 {conflicts:[],unreadable:[]});
// codex-tmux 与 unsupported_backend 不探测 ⇒ policy 为 undefined。日志:凡 policy.unreadable 非空,mounted / OVER BUDGET / skipped / failed 四种 claude 行都追加 settings_unreadable=<json>。
export function resolveRunnerMemoryIdentity(input: { backend: string; projectName?: string; nodeId?: string; agentName?: string }): { ok: true; backend: RunnerMemoryBackend; identity: RunnerMemoryIdentity } | { ok: false; reason: RunnerMemorySkipReason; project?: string; role?: string };
export const RUNNER_MEMORY_ID_MAX_LENGTH = 128;
export function encodeMemoryPathComponent(name: string): string;   // 直通(全小写且无 "--")或 `${lower}--${uppercaseMaskHex}`;单射、可逆
export function decodeMemoryPathComponent(encoded: string): string; // 按最后一个 "--" 切开还原;只用于测试与运维排障
export function resolveRunnerMemoryRoot(env: NodeJS.ProcessEnv): { ok: true; root: string } | { ok: false; reason: "invalid_root_override" | "no_home" | "invalid_home" };
export function measureIndexPrefix(input: { prefix: Buffer; size: number }): Omit<RunnerMemoryIndexStats, "firstRun">;
export function prepareRunnerMemoryMount(input: { env: NodeJS.ProcessEnv; backend: string; projectName?: string; nodeId?: string; agentName?: string; cwd: string; projectRoot: string; managedSettings?: { managedFile: string; managedDropinDir: string } }): RunnerMemoryMount;
export function buildRunnerMemoryPromptSection(mount: RunnerMemoryMount, opts: { legacyProjectMemoryDir?: string }): string;
export function formatRunnerMemoryLogLine(mount: RunnerMemoryMount): { level: "info" | "warn"; line: string };
export function resolveLegacyProjectMemoryDir(input: { repoRoot: string; home: string; exists: (p: string) => boolean }): string | undefined;
export function toRunnerMemoryDisposition(mount: RunnerMemoryMount): AdapterExecutionContext["runnerMemory"];
export const DEFAULT_MANAGED_SETTINGS = { managedFile: "/Library/Application Support/ClaudeCode/managed-settings.json", managedDropinDir: "/Library/Application Support/ClaudeCode/managed-settings.d" } as const;  // macOS;本单只部署在 macOS
export function probeAutoMemoryPolicy(input: { home?: string; cwd: string; projectRoot: string; managedSettings?: { managedFile: string; managedDropinDir: string } }): RunnerMemoryPolicyProbe;
```
(签名即合同:`prepareRunnerMemoryMount` 的 `cwd` / `projectRoot` / `managedSettings` 与 `probeAutoMemoryPolicy` 一致;`home` 可选——`FLYWHEEL_RUNNER_MEMORY_ROOT` 合法而 HOME 缺失时根解析成功、探测只跳过来源③。)
(`SAFE_IDENTIFIER_RE` 从 `flywheel-core` 引入,不在本模块定义;`measureIndexPrefix({ prefix, size })` 是唯一签名,`linesExact` 由它内部按 `prefix.length === size` 得出;模块用 `import fs from "node:fs"` 默认导入。)

实现要点:
- `prepareRunnerMemoryMount` 内部顺序:backend 门(非 claude/codex ⇒ skipped)→ **claude-tmux 时 `probeAutoMemoryPolicy`(conflicts 非空 ⇒ `failed reason=policy_conflict:<json>`,到此为止,不碰文件系统)** → 身份 → 根 → `dir = join(root, encode(project), encode(role))` → `mkdirSync(dir, {recursive: true, mode: 0o700})` → `MEMORY.md` 存在性(`lstatSync`;不是常规文件 ⇒ failed)→ 首跑写头(`writeFileSync(..., {flag: "wx", mode: 0o600})`,`wx` 保证并发首跑不互相覆盖;EEXIST 视为非首跑重读)→ §0.6 的 `openSync`/`fstatSync`/循环 `readSync`/`finally closeSync` 读 ≤ 64KB 前缀 → `measureIndexPrefix`。任何 fs 异常 ⇒ `failed`(reason = `fs:` + `err.message`,不带堆栈)。
- 不打日志、不读 `process.env` 以外的全局;日志由 Blueprint 打。
- `resolveLegacyProjectMemoryDir` 的 slug 规则(`/` → `-`)是**观察值**,注释写明「未文档化;仅在 exists 为真时使用」。

提交:`feat(edge-worker): add runner-memory mount helpers (FLY-2147)`。

## 2. 第二批:Blueprint 装配 + adapter 类型(RED → GREEN)

### 2.1 RED:`Blueprint.fly2147-runner-memory.test.ts`

照 `Blueprint.fly859-qa-phase-prompt.test.ts` 的 mock 骨架(mock adapter 捕获 ctx 与 appendSystemPrompt),`HOME` 与 `FLYWHEEL_RUNNER_MEMORY_ROOT` 指向 `mkdtempSync`:

0. **金样本先行**(Codex R1 #1 / R4 #4):在改 Blueprint 之前,用现有代码对「generalized qa + projectName `flywheel` + `runnerBackend: "antigravity-tmux"`」这一种执行(mock adapter 由 `getAdapter` 回调按名返回同一个 mock)捕获一份 `appendSystemPrompt` 存为 `__tests__/fixtures/fly2147-prompt-golden-unsupported-backend.txt`(commit 进 RED 批);byte-identical 断言(第 3 条)比对**这份金样本**,不比对「从新输出剔除段」的派生值(那把尺子会在空白漂移后仍然绿)。只留这一份金样本:claude / codex 的所有路径(含 skipped / failed)都会**有意**带段(fail-loud),没有 byte-identical 断言可做。
1. generalized 节点 `qa` + projectName `flywheel` + backend claude-tmux ⇒ adapter 收到 `runnerMemory` = `{status:"mounted", dir: join(root, "flywheel", "qa")}`;`appendSystemPrompt` 含 `## Runner Memory`,且 `indexOf("## Agent Role") < indexOf("## Runner Memory") < indexOf("## Baseline Rules")`,并且断言实际序列为 `…ROLE 末行\n\n## Runner Memory\n…\n\n## Baseline Rules`(段前后各恰好一个空行;Codex R2 #7)。
2. legacy 派工(`dispatchByName("generic")` 或 label 命中的 agent)⇒ role 取 `dispatchResult.agentName`。
3. 未触碰的 backend byte-identical:`runnerBackend: "antigravity-tmux"` 的执行,其 `appendSystemPrompt` 与第 0 条金样本**逐字相同**、`runnerMemory` 为 undefined、日志 `skipped reason=unsupported_backend`。
4. claude-tmux 无 projectName ⇒ console.info 收到 `skipped reason=no_project`(spy);prompt 含 `NOT mounted (-/qa): no_project` 与 `auto memory is DISABLED`;adapter 收到 `runnerMemory = {status:"disabled", reason:"no_project"}`(fail-closed)。
5. 根不可写(把 root 指向一个文件)⇒ prompt 含 `NOT mounted` 与 `fs:`、adapter 收到 `{status:"disabled", reason:"fs:…"}`、console.warn 收到 `failed`,且 `execute` 仍被调用(spawn 不中断)。
6. 第二次执行前往目录写一条 `MEMORY.md`(3 行)⇒ 第二次 prompt 含 `3 lines /`(读到的是持久化的那份)。
7. Codex runner(backend codex-tmux,复用 FLY-1188 codex identity 测试骨架)⇒ 含 codex 形态段与 `Native loading for Codex is deferred`;**不含** `Claude Code loads` / `NOT loaded` / `auto memory is DISABLED`;adapter 收到 `runnerMemory = {status:"mounted", dir}`(供 env)。
8. (并入第 3 条。)
9. 既有套件隔离:`test/setup.ts` 的 `beforeEach` 设唯一临时 `FLYWHEEL_RUNNER_MEMORY_ROOT` **和**唯一临时 `HOME`(`afterEach` 还原并 `rmSync`)。隔离证明是密闭的:一个专门测试在临时 HOME 下跑一次挂载,断言写入落在临时根、并且 `<临时HOME>/.flywheel/runner-memory` 不存在;**不**对开发者机器上真实的 `~/.flywheel/runner-memory` 做 mtime / 条目数断言(会与在跑的 Bridge 竞态,不是证明)。
10. `Blueprint.fly1188-codex-prompt.test.ts`:该 fixture 无角色来源 ⇒ `skipped reason=no_role` ⇒ fail-closed 段。快照**有意更新**,并且**「diff 只多出 fail-closed 段」本身是断言**(Lead 裁定,不靠人眼看 diff):在改 Blueprint 之前把该 fixture 的 prompt **经既有 normalize 链**(执行 UUID、`flywheel-comm` 路径、land-status 路径三处替换——抽成 `normalizePromptForSnapshot(prompt)` 辅助函数,快照测试与本测试共用)处理后捕获为 `fixtures/fly1188-prompt-before-fly2147.txt`(commit 进 RED 批;Codex R6 #4:`buildPrompt({})` 每次 `randomUUID()`,原始字节不可复现);新增测试 `it("FLY-2147 only inserts the deterministic fail-closed section")`:取 `normalizePromptForSnapshot(newPrompt)`,用 `## Runner Memory\n` 到下一个 `\n## ` 之间切出段 S,断言 (a) `normalized === before.replace("\n## Baseline Rules", "\n" + S + "\n## Baseline Rules")`(除插入段外逐字节相同),(b) S 逐字等于 `buildRunnerMemoryPromptSection({status:"skipped", reason:"no_role", backend:"claude-tmux", project:"proj"}, {legacyProjectMemoryDir: undefined})`(确定性,不含临时路径),(c) mock adapter 收到 `{status:"disabled", reason:"no_role"}`(`buildPrompt` 改为同时返回捕获到的 adapter ctx,或加一个返回 `{prompt, ctx}` 的伴生 helper)。快照文件随之更新后,`toMatchSnapshot` 与 (a) 双重锁定;段 S 本身不做归一化,逐字节与 (b) 比。该文件里一条无身份的 Codex 调用同样按 (a)(b) 断言 Codex 版段,且不含 `auto memory is DISABLED` / `Claude Code loads`。挂载形态的 codex 覆盖由本文件第 7 条承担;**绝不**用 `ctx.runnerName` 兜底当角色。
11. `Sub` 与 `sub` 两个 projectName 各执行一次 ⇒ 两个 `runnerMemory.dir` 不同,prompt 里 `project=` 显示各自原名。
12. policy_conflict 装配:通过 §2.2 的注入缝给 Blueprint 一个指向临时 managed 文件(内容 `{"autoMemoryEnabled":true}`)的 preparer ⇒ console.warn 收到 `failed … reason=policy_conflict:[…]`、prompt 含 `UNKNOWN` 且不含 `auto memory is DISABLED`、adapter 收到 `{status:"disabled", reason:"policy_conflict:[…]"}`、`execute` 仍被调用、角色目录**未被创建**。
13. 生产组合(Codex R8 #1:ESM 下同模块内部引用不会被 `vi.spyOn` 导出属性替换,所以分两处测):① Blueprint 测试注入一个 spy preparer,断言 Blueprint 传入了 `cwd`、`projectRoot`、`backend`、身份输入,且**没有**传 `managedSettings`(生产组合永远走默认值);② `runner-memory.test.ts` 里直接调用真 `prepareRunnerMemoryMount` 且省略 `managedSettings`,通过已可 spy 的 `fs` 默认对象观察它读取的路径正是 `DEFAULT_MANAGED_SETTINGS.managedFile` 与 `managedDropinDir`;③ 断言 Blueprint 源码里 `runnerMemoryPreparer` 只出现在构造函数尾位参数与那一处调用(grep 计数),不读任何 env / 配置——这是 Lead「只许测试台架用、不许成为运行时开关」那句的机械锁。

### 2.2 GREEN

- `adapter-types.ts`:`runnerMemory?: { status: "mounted"; dir: string } | { status: "disabled"; reason: string }` + JSDoc:`disabled` 是 Flywheel 向 CLI **请求**的启动处置(传 `autoMemoryEnabled:false`),除 `policy_conflict`(有效状态未知,Rule A 不求解)外即为有效状态;undefined 只用于未触碰的 backend。
- `Blueprint.ts` `runInner`(Codex R2 #4:`resolveSkillFrameworkForRun` 里的 `backend` 不在 `runInner` 作用域;`fs` 是默认导入,没有 `existsSync` 绑定):
  - 在 `const adapter = this.getAdapter(ctx.runnerBackend ?? "claude-tmux")` 处引入 `const backend = ctx.runnerBackend ?? "claude-tmux";`,并把该行、`isCodexRunner` 的判断、以及下面的记忆准备都改为用这个 `backend`(三处同一来源,消掉重复的 `?? "claude-tmux"`)。
  - 锚点 `const systemPrompt = agentContext ? …` 之前:

```ts
const memoryMount = this.runnerMemoryPreparer({   // 构造函数尾位注入,默认 prepareRunnerMemoryMount
  env: process.env,
  backend,
  projectName: ctx.projectName,
  nodeId: isGeneralizedExecution ? ctx.generalizedExecutionContext!.nodeId : undefined,
  agentName: dispatchResult?.agentName,
  cwd,                                      // runner worktree(来源④)
  projectRoot,                              // 主仓根(来源⑤;`run()` 的参数)
  // managedSettings 省略 ⇒ DEFAULT_MANAGED_SETTINGS
});
const memoryLog = formatRunnerMemoryLogLine(memoryMount);
(memoryLog.level === "warn" ? console.warn : console.info)(memoryLog.line);
const home = process.env.HOME?.trim();
const legacyProjectMemoryDir = home && path.isAbsolute(home)
  ? resolveLegacyProjectMemoryDir({ repoRoot: projectRoot, home, exists: fs.existsSync })
  : undefined;
const memorySection = buildRunnerMemoryPromptSection(memoryMount, { legacyProjectMemoryDir });
```
  `projectRoot` = `Blueprint.run(node, projectRoot, ctx)` 的参数(项目主仓路径,worktree 由它派生);HOME 缺失/空/相对 ⇒ 不输出指针行(直接检查原则:没有就不说)。
- 拼接(既有 `\n## Baseline Rules` 分隔符原样保留;段非空时在段前补一个 `\n`,让段前也有一个空行——Codex R1 #1 + R2 #7):
```ts
const memoryBlock = memorySection ? `\n${memorySection}` : "";
const systemPrompt = agentContext
  ? `${agentContext}${memoryBlock}\n## Baseline Rules\n${baseSystemPrompt}`
  : memorySection
    ? `${memorySection}\n## Baseline Rules\n${baseSystemPrompt}`
    : baseSystemPrompt;
```
  `agentContext` 以 `\n` 结尾;`memorySection` 为空串时 `memoryBlock` 为空,表达式与现行 `${agentContext}\n## Baseline Rules\n${baseSystemPrompt}` 逐字相同;非空时得到 `ROLE\n\n## Runner Memory\n…\n\n## Baseline Rules`(段前:agentContext 的 `\n` + 补的 `\n`;段后:段自带的 `\n` + 外层 `\n`)。
- `adapter.execute({... runnerMemory: toRunnerMemoryDisposition(memoryMount) })`,其中 `toRunnerMemoryDisposition`(runner-memory.ts 导出):`mounted` ⇒ `{status:"mounted", dir}`;`failed` ⇒ `{status:"disabled", reason}`;`skipped` 且 reason ≠ `unsupported_backend` ⇒ `{status:"disabled", reason}`;`skipped reason=unsupported_backend` ⇒ `undefined`。

提交:`feat(edge-worker): mount runner memory by project+role at spawn (FLY-2147)`。

## 3. 第三批:adapter 落地(RED → GREEN)

### 3.1 RED:`TmuxAdapter.test.ts` / `CodexTmuxAdapter.test.ts`

1. `buildClaudeArgs` 在 ctx 带 `runnerMemory={status:"mounted",dir}` 时:`--settings` 后的 JSON 解析出 `autoMemoryDirectory === dir` **且 `autoMemoryEnabled === true`**(默认开写死,压过用户/项目级的关闭),`enabledPlugins` 里 FLY-1715 的两项 discord 仍为 false(deepMerge 没丢)。
2. `runnerMemory={status:"disabled",reason}` 时:JSON 含 `autoMemoryEnabled === false` 且**无** `autoMemoryDirectory`(fail-closed);`runnerMemory` 为 undefined 时:两个键都不含(byte-identical)。
3. pane env 含 `FLYWHEEL_RUNNER_MEMORY_DIR=<dir>` 仅当 mounted;disabled / undefined 时不含。
4. FLY-1869 「完整生产 allowlist」名单加入 `FLYWHEEL_RUNNER_MEMORY_DIR`,预算断言仍过;另加一个**最坏路径形状**:root 120 字符 + 编码后的 project 162 字符 + 编码后的 role 162 字符(即 `runnerMemory.dir` ≈ 446 字符,同时出现在 `--settings` JSON 与 pane env 里)仍在预算内(Codex R4 #4)。
5. `:1346` totalArgv < 6,000 仍过。
6. Codex:mounted 时 env 含 `FLYWHEEL_RUNNER_MEMORY_DIR`,disabled 时不含;argv 不含 `autoMemoryDirectory` 也不含 `autoMemoryEnabled`;FLY-1643 逐字 `FLYWHEEL_*` env 名单更新后仍过。

### 3.2 GREEN

- `TmuxAdapter.ts` `buildClaudeArgs`:
```ts
const memorySettings =
  ctx.runnerMemory?.status === "mounted"
    ? { autoMemoryDirectory: ctx.runnerMemory.dir, autoMemoryEnabled: true }   // default-on is hardcoded: a lower-scope autoMemoryEnabled:false must not silently defeat the mount
    : ctx.runnerMemory?.status === "disabled"
      ? { autoMemoryEnabled: false }          // fail-closed (Lead ruling): never fall back to the shared project memory
      : undefined;
args.push("--settings", JSON.stringify(buildNonLeadClaudeSettings({ enabledPlugins }, memorySettings)));
```
  env 段(`FLYWHEEL_PROJECT_NAME` 旁):`if (ctx.runnerMemory?.status === "mounted") appendPaneEnv("FLYWHEEL_RUNNER_MEMORY_DIR", ctx.runnerMemory.dir);`
- `CodexTmuxAdapter.ts`(`env.FLYWHEEL_PROJECT_NAME` 旁):`if (ctx.runnerMemory?.status === "mounted") env.FLYWHEEL_RUNNER_MEMORY_DIR = ctx.runnerMemory.dir;`

提交:`feat(claude-runner): pass runner memory dir via --settings and pane env (FLY-2147)`。

## 4. 聚焦与全仓 verification

```
pnpm --filter flywheel-edge-worker test -- runner-memory Blueprint.fly2147
pnpm --filter flywheel-claude-runner test -- TmuxAdapter CodexTmuxAdapter
pnpm lint && pnpm build && pnpm test
```
- 全绿后 push,以**该头**的 CI 结论为准([[feedback_local_green_is_not_that_head_ci_green]])。
- 真 CLI 往返证据(QA 节点执行,需要 Claude 账号;实现节点可先跑一次留证)。要点(Codex R4 #2 / R5 #4):**三次**调用各在独立的临时 cwd 的子 shell 里跑;nonce 一次性随机生成;第一次要求把含 nonce 的**指针行写进 `MEMORY.md`**(启动只装载索引,不装载正文);第二、三次的 prompt 同一份、**不含** nonce,要求模型复述,只有逐字匹配才算证据;第一个 cwd 在核过盘上文件后才删;`EXIT` trap 只清理本脚本 `mktemp` 出来的路径,提前失败也清理。整块可直接粘贴执行:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT=$(mktemp -d); FIRST_CWD=$(mktemp -d); SECOND_CWD=$(mktemp -d); THIRD_CWD=$(mktemp -d)
trap 'rm -rf "$ROOT" "$FIRST_CWD" "$SECOND_CWD" "$THIRD_CWD"' EXIT
NONCE=$(openssl rand -hex 8); DIR="$ROOT/flywheel/qa"
SETTINGS="{\"autoMemoryDirectory\":\"$DIR\",\"autoMemoryEnabled\":true}"     # 与 TmuxAdapter mounted 形态逐字同形
RECALL_PROMPT='Without using any tools: your memory index contains a pointer line titled probe-2147 ending with "nonce <hex>". Reply with ONLY that hex value, or NONE if it is not in your context.'
# 1) 第一次(独立 cwd):把 nonce 写进索引指针行
( cd "$FIRST_CWD" && claude -p --model haiku --settings "$SETTINGS" \
  "Save one memory now: create topic file probe_2147.md (type: reference) whose body is 'probe for FLY-2147', and add ONE pointer line to MEMORY.md that reads exactly: - [probe-2147](probe_2147.md) — nonce $NONCE. Reply DONE." ) > "$ROOT/run1.txt"
grep -F -- "nonce $NONCE" "$DIR/MEMORY.md" || { echo "FAIL: index pointer missing on disk"; exit 1; }
# 2) 第二次(另一个 cwd;prompt 不含 nonce):只靠启动装载的索引复述
( cd "$SECOND_CWD" && claude -p --model haiku --settings "$SETTINGS" "$RECALL_PROMPT" ) > "$ROOT/run2.txt"
grep -qx -- "$NONCE" "$ROOT/run2.txt" || { echo "FAIL: cross-cwd recall"; cat "$ROOT/run2.txt"; exit 1; }
# 3) 删掉第一个 cwd 后在第三个 cwd 再问一次,仍须逐字匹配
rm -rf "$FIRST_CWD"
( cd "$THIRD_CWD" && claude -p --model haiku --settings "$SETTINGS" "$RECALL_PROMPT" ) > "$ROOT/run3.txt"
grep -qx -- "$NONCE" "$ROOT/run3.txt" || { echo "FAIL: survival after cwd deletion"; cat "$ROOT/run3.txt"; exit 1; }
for f in run1 run2 run3; do echo "--- $f ---"; cat "$ROOT/$f.txt"; done     # 证据在 trap 清理之前打印出来
echo "--- MEMORY.md ---"; cat "$DIR/MEMORY.md"
claude --version
echo "PASS nonce=$NONCE"                                                        # 最后一行
```
PR 里贴脚本完整 stdout(含三段 `--- runN ---`、`MEMORY.md`、`claude --version`);验收证据 = 最后一行 `PASS nonce=<hex>` 且 run2、run3 各恰好一行等于该 hex(Codex R6 #6:输出文件在 ROOT 下会被 trap 删掉,所以先打印再退出)。
- 生产形状核验(部署后由 QA 节点做,本单不部署):从一个真实 runner pane 读 `env | grep FLYWHEEL_RUNNER_MEMORY_DIR`、`ps -o args` 里 `--settings` 含 `autoMemoryDirectory`、Bridge 日志有 `runner-memory mounted` 行。

## 5. Code review、milestone 与 PR

- PR 标题:`feat: mount runner memory by project+role at spawn (FLY-2147)`;body 含变更摘要、测试计划(§4 命令 + 真 CLI 往返输出)、`## Linear Issue` 段。
- `engineering/doc/milestones/FLY-2147.md` 按 README 合同新建;**不写**回 CLAUDE.md 表格。
- Codex code review 走既有 `/codex-code-review` 门。

## 6. 逐项完成审计(实现节点收工前逐条打勾)

- [ ] §0.3 每个标识在代码里只出现一处定义(常量 / 类型),测试引用常量而非重复字面量(日志形状除外,那是显示合同)。
- [ ] 「不挂载时 byte-identical」测试比对的是 commit 进仓的金样本文件,且通过;`grep -rn "FLYWHEEL_RUNNER_MEMORY\b\|FLYWHEEL_RUNNER_MEMORY=\|RUNNER_MEMORY_INDEX_BUDGET" packages/` 为 0(允许且必须存在的只有 `FLYWHEEL_RUNNER_MEMORY_ROOT` 与 `FLYWHEEL_RUNNER_MEMORY_DIR`)。
- [ ] `readFileSync` 没有用于 `MEMORY.md`;稀疏 8MB fixture 测试通过。
- [ ] codex 形态负向断言(不含 `Claude Code loads` / `NOT loaded` / `auto memory is DISABLED`)存在且通过;antigravity/kimi 为 `unsupported_backend` 且 argv/prompt/env byte-identical。
- [ ] fail-closed 三态 settings 测试(mounted ⇒ `autoMemoryDirectory`;disabled ⇒ `autoMemoryEnabled:false`;undefined ⇒ 两者皆无)通过;claude `no_project` 与 `fs:` 失败两条路径都断言了 `runnerMemory.status === "disabled"` 与 prompt 的 `DISABLED` 行;`policy_conflict` 路径断言 `UNKNOWN` 且**不含** `DISABLED`。
- [ ] Blueprint 构造函数尾位的 `runnerMemoryPreparer` 缝存在;FLY-1188 / FLY-2147 harness 注入了不存在的临时 managed 路径;生产组合测试断言默认 preparer 用 `DEFAULT_MANAGED_SETTINGS`。
- [ ] §0.5 行为删除声明原样保留在 plan 里,PR body 里复述一遍。
- [ ] `ProjectConfig.ts` 已改为引用 `SAFE_IDENTIFIER_RE`,仓里 `SAFE_ID` 局部定义为 0,ProjectConfig 既有测试零改动全绿。
- [ ] `encodeMemoryPathComponent` 的影子对抗与**证明式单射测试**(registry 键 + Lead id + 对抗样本 + 穷举大小写变体 + 5,000 随机串;编码无碰撞、解码逐字节还原)通过;`fs.openSync` 的 `finally fs.closeSync` 与短读测试通过(桩被调用的断言在)。
- [ ] FLY-1188 codex-prompt 快照的 diff **只多出**确定性的 fail-closed 段——由 §2.1(10) 的 (a)(b)(c) 断言证明(before 金样本 + 段生成函数逐字比对),不是人眼看 diff;一条无身份 Codex 调用同样断言。
- [ ] 「存在即冲突」探测测试清单(§0.8)全部通过;conflict 时目录不存在的断言在;`CLAUDE_CODE_DISABLE_AUTO_MEMORY` 不在 pane env allowlist 的断言在;`runner-memory.ts` 里没有任何按值判断 `autoMemory*` 的分支(grep `autoMemoryEnabled ===` 为 0)。
- [ ] mounted 三态测试同时断言 `autoMemoryDirectory === dir` **和** `autoMemoryEnabled === true`;CLI 往返脚本的 `SETTINGS` 含 `"autoMemoryEnabled":true`,脚本最后一行是 `PASS nonce=…`。
- [ ] `runner-memory.ts` 只用 `fs.` 默认导入调用,无具名 `openSync/readSync/closeSync/fstatSync` 导入。
- [ ] 四种日志形状各有一条测试逐字 grep。
- [ ] `first_dropped_line` 两维(行 / 字节)各有 fixture。
- [ ] FLY-1869 allowlist 名单已加项。
- [ ] 真 CLI 往返输出(三次调用;run2 与 run3 各恰好一行等于 nonce;末行 `PASS nonce=…`)贴在 PR 测试计划里,含 `claude --version`。
- [ ] PRD B 四条验收逐条对应到某个测试或往返步骤(在 PR body 列表)。

## 7. 诚实边界(本设计做什么、不做什么)

**做**:Claude runner 的记忆目录只由 (project, role) 决定;索引由 Claude Code 原生装载(与 Lead 同机制);spawn 前的有界可见守卫(预算内留痕、超限说明起始行);Codex runner 拿到目录 env 与说明段。**没有运行时开关**(Lead 裁定),回退 = 代码回滚。**挂载失败 / 没有身份的 Claude runner 本次执行没有任何自动记忆(fail-closed,Lead 裁定)**,且三面可见(日志、prompt、adapter 上下文);唯一例外是 `policy_conflict`——同样传 `false`,但有效状态按 Rule A 不判定,标为 UNKNOWN 并上报。

**不做 / 不能保证(续)**:
- 不在 registry.yaml / workflow manifest / 项目 agents 键的加载器里加标识文法校验(Lead 裁定不扩范围);不合文法的 role 会 `skipped reason=invalid_role` 并 fail-closed。今天这个例外集合为空由证明式测试断言;承接:Lead 另开 issue 在三处加载器加同一文法。
- `session_started` 事件不携带记忆处置(它早于挂载发出);fail-loud 的载体是日志行、prompt 行、adapter 上下文三面。
- **settings 冲突只做「存在即冲突」,不求解**(Lead 裁定 A):Claude Code 的 managed 层优先级高于 `--settings`,本单赢不了它,也不试图算出「最终谁赢」——任何官方文件型来源里出现 `autoMemory*` 键或 `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` 就 fail-closed + fail-loud,由 Lead 处理那台机器。**探测不到的**:MDM / 注册表策略、服务器下发策略、policy helper 等非文件型来源——写在这里,不假装覆盖;也不覆盖 Claude Code 以后新增的层级。
- 「DISABLED」只表示 Claude Code 不装载、不自动写自动记忆索引;它不让文件系统写入变临时,也不阻止 runner 手工编辑任何目录——跨角色访问控制不在本单。

**不做 / 不能保证**:
- 不改变 Claude Code 装载侧的截断行为本身,只让它在发生前被看见;K 是近似值。
- 同角色并行 runner 同时追加 `MEMORY.md` 有极小丢行窗口(一事一文件的正文不受影响),不加锁。
- 项目共享那 573 条不再自动进 runner 上下文,只留一行只读指针(Lead 若裁定相反,改为不设 `autoMemoryDirectory` 而走路 B——那是另一份 plan)。
- Codex runner 没有原生记忆挂载(C1);它的 prompt 段只说「目录在这、自己翻、自己写」,不声称任何自动装载。implement 节点默认 codex,因此 implement 角色的记忆在 C1 之前主要由 Claude 系 implement runner 写、Codex runner 只能翻。
- antigravity / kimi backend 本单不挂载、不给指针(`unsupported_backend`);要不要给,Lead 另裁。
- 守卫的行数在索引超过 64KB 或发生短读时是「至少 N 行」,不是精确值;字节永远精确。
- 盘上目录名对含大写(或含 `--`)的标识会带 `--<掩码>` 后缀(`Sub` → `sub--1`);这是为大小写不敏感文件系统付的代价,prompt 与日志里仍显示原名。全小写的常见名(`flywheel/qa`)不受影响。
- 不备份到远端(A 线);不做跨角色读写策略;不整理任何人的索引。
