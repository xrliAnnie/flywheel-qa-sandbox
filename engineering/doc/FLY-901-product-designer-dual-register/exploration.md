# FLY-901 产品/设计执行器 dual-register — 探索

Issue: FLY-901 (https://linear.app/geoforge3d/issue/FLY-901/产品-lead-派活路由问题product-部门-lead-自动派活够不着产品设计执行器角色)
日期: 2026-07-06
基于: 无

## Problem

Honey Lemon（产品 Lead，`department: product`，认领标签 `Flywheel-Product`）按标签自动派产品活时，Runner 拿不到「产品/设计」执行器角色（`product-designer-executor.md`，FLY-880 建的带产品共创 + PM 技能的角色），掉回 shipped-generic 兜底。

复现链路（全部已在代码 + 生产配置里核实）：

1. `Flywheel-Product` issue → `DepartmentRegistry.getDepartmentForIssue` 恰好命中一个 Lead（Honey Lemon）→ `owningDept = "product"`（`packages/teamlead/src/department-registry.ts:146`，生产 `~/.flywheel/projects.json` 里 flywheel-product-lead 的 dept 确为 `product`、`canSpawnRunners: true`）。
2. `AgentDispatcher.dispatch()` step-2a 逐个 agent 比对 `parsedDept(cfg.agent_file) !== owningDept`（`packages/edge-worker/src/AgentDispatcher.ts:206`）。dept 是**从文件路径派生的单值**——`product-designer` 的 `agent_file` 在 `.flywheel/agents/engineering/` 下 → dept = `engineering` ≠ `product`，不命中。项目里没有任何 agent 的 dept = `product`。
3. step-2b 顶层 catch-all：`general` 的 `match.labels` 为空数组，永不按标签命中。
4. step-3a：flywheel 项目未配 `default_agent` → step-3b shipped-generic 兜底。

临时绕法是派发时显式传 `agentName:"product-designer"`（`dispatchByName` 绕过 dept 匹配）——补丁，非正解。

## Why solve

Annie 的诉求是「产品和工程各自独立派活、互不影响」。该角色的**能力**同时服务两个部门（eng 的 doc/design 活 + product 的产品共创活），但注册机型是单 dept 的，产品 Lead 的自动派活够不到本该属于自己的执行器。

**已批方向（Annie + Tadashi，lead-instruction 458fbb9f）**：dual-register——让该角色在 eng + product 两个 dept 都够得到。**不是**从 eng 挪走，**不是**放宽 dept 匹配糊掉隔离。

## Options

### 方案① 显式多 dept 注册字段 `agents.<name>.departments`（选定）

给 `AgentConfig` 加可选字段 `departments: string[]`——该 agent 显式注册到的 dept 集合。缺省时行为字节不变（dept = 路径派生单值）。dispatcher step-2a 的比对从「路径 dept === owningDept」改为「owningDept ∈ (departments ?? [路径 dept])」。config.yaml 给 `product-designer` 声明 `departments: [engineering, product]`。

- 单一角色文件、单一注册项、单一 agentName——FLY-880 的 250 行行为契约不复制。
- 隔离不糊：只有**显式列出的** dept 命中；没列的 dept 行为与今天完全一样。
- 缺省字节兼容：不声明 `departments` 的 agent（现有全部）路径一条不变。
- 改动半径小：`AgentDispatchResult.department` 在 dispatcher/测试之外没有消费者（全仓 grep 核实），step-2a 命中时本来就返回 `department: owningDept`（AgentDispatcher.ts:213），语义自然正确。

### 方案② 第二个注册项 + `.flywheel/agents/product/` 下第二份文件（否决）

零引擎代码改动（纯 config + 文件），但：

- **内容漂移**：角色文件是 FLY-880 精心写的 ~250 行行为契约（五条铁律 + Mode A/B），拷贝两份必然漂移；symlink 在 git 里可行但对工具链脆（`readAgentFile`、review、grep 都容易踩）。
- **第二个 agentName**：`product-designer` 之外多出一个名字，`dispatchByName` 调用方（Lead 的 agentName 覆盖、auto-QA、retry 持久化的 `agent_name` 列）全都要多认一个别名。
- FLY-880 守卫测试 `scripts/__tests__/test-pm-executor-contract.sh:15` 钉死 engineering 路径，双文件形态会让守卫只守一半。

### 方案③ 放宽 dept 匹配（如 step-2a 失配后跨 dept 兜底）（边界外，否决）

Lead 指令明确排除：「不是放宽 dept 匹配糊隔离」。跨 dept 兜底会让**任何** dept 的 issue 都可能摸到别的 dept 的 agent，破坏「各自独立派活、互不影响」这个诉求本身。

## Decision

**方案①**。BRAINSTORM GATE 已过——Lead（Tadashi）原话：「方向对、批方案①（agents.<name>.departments 显式数组）：只放宽显式声明的 dept 集合、未声明字节兼容、角色文件不挪家、canSpawnRunners 不动；②的拷贝/symlink 漂移否得对。测试矩阵齐。」

## Out of scope（已核实、记录、不碰）

- **三段式 phase 换手不带派活上下文**：`PhaseOrchestrator` 的 handoff `start()` 不传 `agentName`/`issueLabels`/`owningDept`（phase-orchestrator.ts:101-112），Implement/QA phase-session 的 agent 解析对**所有 dept 一致地**退化。这是既有形态、与本 fix 正交；产品 issue 目前按约定带 `no-three-stage` 走单 session。归 FLY-830 相邻问题。
- **产品正规 pipeline 形状**（three_stage / auto-QA 对产品 issue 的波及，`no-three-stage` / `docs` / `no-qa` 标签）= FLY-830。
- `canSpawnRunners`（Honey Lemon 已为 true）不动。
- dispatcher 其他逻辑（step-2b/step-3、首配优先、`dispatchByName`、reserved `generic`/`qa`）不动。
