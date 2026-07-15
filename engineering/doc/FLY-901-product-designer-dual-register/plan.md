# FLY-901 产品/设计执行器 dual-register — 实施计划

Issue: FLY-901 (https://linear.app/geoforge3d/issue/FLY-901/产品-lead-派活路由问题product-部门-lead-自动派活够不着产品设计执行器角色)
日期: 2026-07-06
基于: research.md

## Goal

`product-designer` 执行器角色在 **engineering + product 两个 dept 的自动派活（标签路由）下都命中**：新增可选配置字段 `agents.<name>.departments: string[]`（显式注册 dept 集合），`AgentDispatcher` step-2a 按集合成员判定。角色文件不挪家、未声明该字段的 agent 字节兼容、不放宽任何未列出 dept 的匹配、不碰 `canSpawnRunners` 与 dispatcher 其他逻辑。

（方向 Annie 已批 dual-register；方案① Tadashi brainstorm gate 已批——见 exploration.md「Decision」。）

## Non-goals

- 三段式 phase 换手不传 owningDept 的既有形态（FLY-830 相邻，见 research §5 R3）。
- 产品 pipeline 形状 / `no-three-stage` / `no-qa`（FLY-830）。
- 同 dept 标签冲撞检测、dispatchByName 语义、step-2b/3、保留名 generic/qa。
- projects.json（Lead 注册）任何改动。

## Changes（4 文件 + 测试）

### C1. `packages/config/src/types.ts` — AgentConfig 加字段

`AgentConfig` 新增可选 `departments?: string[]`，JSDoc 写清合同：显式注册的 owning-dept 集合；缺省 = 路径派生单 dept（字节兼容）；仅 dept-owned agent 可声明；必须包含路径派生 home dept；FLY-901。

### C2. `packages/config/src/ConfigLoader.ts` — 校验（挂在 :681-698 单数 department 校验同段）

对每个声明了 `departments` 的 agent，按序校验、逐条报错（错误信息风格对齐既有 `agents.<name>.xxx` 前缀）：

| # | 规则 | 报错条件 |
|---|------|---------|
| V1 | 类型 | 非数组 / 空数组 / 含非字符串项 |
| V2 | token 合法 | 任一项不匹配 `^[a-z0-9-]+$`（对齐 default_department 的 path-safety） |
| V3 | 去重 | 有重复项 |
| V4 | 仅 dept-owned | `parseAgentDept(agent_file) === null`（顶层 agent）却声明了 departments |
| V5 | 含 home dept | 路径派生 dept ∉ departments |

单数 `department` 的既有校验一字不动（其与路径的双向一致 + V5 传递保证三者一致）。

### C3. `packages/edge-worker/src/AgentDispatcher.ts` — step-2a 集合化

新增模块级 helper（导出，供测试直测）：

```ts
/** FLY-901: an agent's registered owning-dept set. Top-level (catch-all) agents return null. */
export function registeredDepts(cfg: AgentConfig): string[] | null {
    const home = parsedDept(cfg.agent_file);
    if (home === null) return null; // 顶层 agent 不参与 step-2a，departments 由 ConfigLoader 拒绝
    return cfg.departments ?? [home];
}
```

step-2a 改一行（:206）：

```ts
// before: if (parsedDept(cfg.agent_file) !== owningDept) continue;
const depts = registeredDepts(cfg);
if (!depts || !depts.includes(owningDept)) continue;
```

其余（step-2b/3a/3b、dispatchByName、labelsMatch、entries 顺序）零改动。step-2a 命中结果 `department: owningDept`（既有行为）语义在 dual-register 下天然正确，不动。

### C4. `.flywheel/config.yaml` — product-designer 注册进两个 dept

```yaml
  product-designer:
    agent_file: .flywheel/agents/engineering/product-designer-executor.md
    department: engineering        # home（不变）
    # FLY-901 dual-register: 产品 Lead（owningDept=product）的自动派活也命中此角色。
    departments: [engineering, product]
    match:
      labels: ["doc", "docs", "design", "product", "pm", "ux", "designer"]
```

engineer / qa / general 的配置值一字不动。**同步改 agents block 前言注释**（Codex R1 #1）：现注释写「dept 必须等于 spawning Lead 的 department 才 route」，dual-register 后对 product-designer 局部失真——改为「默认按路径派生 home dept；声明 departments 时 step-2a 用显式 owning-dept 集合；未声明者保持路径单注册」。

## TDD 顺序（RED → GREEN → REFACTOR）

1. **C1 先落（type-only compile-enabler，Codex R1 #2）**：`AgentConfig` 没有 `departments` 字段时，typed fixture 会先撞 excess-property 编译红而非行为红——先落 C1 这个纯类型改动（自身零行为），让 RED 用例能跑到「现状返回 shipped-generic」的行为断言。
2. **RED-1（dispatcher）**：`AgentDispatcher.test.ts` 新用例——config 含 `departments: ["engineering","product"]` 的 product-designer 形态，`dispatch({issueLabels:["product"], owningDept:"product"})` 期望命中（现状返回 shipped-generic → 红）。
3. **RED-2（ConfigLoader）**：V1a/V1b/V1c + V2-V5 各一条报错用例 + 一条合法通过用例（现状：未知字段被静默接受 → 校验用例红）。
4. **GREEN**：按 C2 → C3 实现到全绿。
5. **REFACTOR**：确认 :206 旧比对无残留调用点；JSDoc/注释按仓库风格补齐。
6. **C4 最后落**：engine 测试全绿后再改 config.yaml（含 agents block 前言注释同步；config 校验先行，防先改配置把现网 ConfigLoader 弄红——现状未知字段虽被忽略，纪律上仍 engine 先行）。

## Test matrix（验收合同，Lead 指令的三条覆盖逐条对号）

### A. 新增 dispatcher 用例（AgentDispatcher.test.ts）

| # | 场景 | 断言 |
|---|------|------|
| T1 | **product Lead 派产品活**：owningDept=product，labels 含 product（或 pm/ux/design 任一） | 命中 product-designer，matchMethod=label，department=product，agentFileRoot=project |
| T2 | **eng 派 design/doc**：owningDept=engineering，labels 含 doc（或 design） | 命中 product-designer，department=engineering（零回归） |
| T3 | 未列出 dept 不放宽：owningDept=ops，labels 含 product | 不命中 2a → 掉 shipped-generic（隔离不糊的显式反例） |
| T4 | owningDept=product + labels 只有 code | product-designer 标签不命中、engineer 因 dept 不含 product 不命中 → shipped-generic（无跨 dept 泄漏） |
| T5 | owningDept="multiple" / undefined + departments 存在 | 2a 照旧整段跳过（既有语义不被新字段激活） |
| T6 | departments 缺省的 agent（engineer）在 owningDept=engineering 下照旧命中 | 字节兼容抽查 |
| T7 | registeredDepts 直测：缺省→[home]；显式→原数组；顶层→null | helper 合同 |
| T8 | 首配优先在 dual-register 下不变：两个 agent 都在 product 命中同标签 → 先配置者赢 | 既有语义延续 |

### B. 新增 ConfigLoader 用例（ConfigLoader.test.ts，仿 :607-637 形态）

V1 拆三个独立负例（Codex R1 #3——三个 malformed shape 是不同分支）：V1a `departments: product`（非数组）、V1b `departments: []`（空数组）、V1c `departments: [engineering, 7]`（含非字符串项）；再加 V2（非法 token）/V3（重复项）/V4（顶层 agent 声明）/V5（不含 home dept）各一条报错 + 「departments: [engineering, product] 且 department: engineering 并存」合法通过一条。

### C. 回归（一条不改）

- AgentDispatcher.test.ts 既有 30 用例、ConfigLoader.test.ts 既有全部用例：**原样通过**（departments 缺省字节兼容的证明）。
- `scripts/__tests__/test-pm-executor-contract.sh`（FLY-880 契约，16 断言）：不改、照跑（文件未挪家）。
- 全仓 `pnpm lint` + 受影响两包 vitest 全绿。

### D. 独立 QA（三段式 QA 段 / auto-QA 承接，不由实现者自验）

真机行为验证建议脚本化断言（QA 段自行裁量）：以 reviewed commit 构造 AgentDispatcher（读真实 .flywheel/config.yaml + 真实 projects.json 派生的 owningDept 值）跑 T1/T2/T3 等价场景；有条件时走一次真 dispatch（Honey Lemon 对带 product 标签的测试 issue 派活）确认 Runner 拿到 product-designer 的 agentContext。

## Ship / rollout

- 单 PR：C1-C4 + 测试 + 本三件套文档（docs travel with branch）。
- 生效路径（Codex R1 #4 已核实为事实，非开放风险）：`run-infra.ts:596-604` 在 per-project runtime setup（Bridge startup）时读 `.flywheel/config.yaml`，`:662-668` 构造 AgentDispatcher 且 `flywheelConfig?.agents` **无字段白名单直接透传**——engine 代码与 config.yaml 都要经 **一次 Bridge 重启**才进入已初始化 runtime（攒批，遵守「多 PR 攒成一次重启」纪律）；真机 QA 负责验证重启后的真实 dispatch。
- 回滚：revert 单 PR 即回原形态（新字段缺省即旧行为，无数据迁移、无 schema 变更）。
- founder ship gate：PR 建好走 approve_to_ship 流程 hold，绝不自 ship。

## Risks

| 风险 | 等级 | 处置 |
|------|------|------|
| dept 名笔误静默不可达（research R1） | 低 | V2 token 校验 + T1 用真实 dept 名端到端断言；跨文件互验结构上不可行，接受 |
| 未来 product dept 第二个 agent 与 product-designer 标签冲撞 | 低 | 既有首配优先语义 + T8 钉住；检测器超 scope 不做 |

（原风险「run-infra 白名单滤掉 departments」经 Codex R1 实读 run-infra.ts:601-668 排除：agents 直接透传进 AgentDispatcher 构造器，无过滤——已从风险表移除。）

## Design review record

- Round 1（2026-07-06，Codex xhigh）：**APPROVED**。4 条非阻塞建议全部采纳并已折进本文档：#1 config.yaml agents block 前言注释同步（C4）；#2 C1 先落作 compile-enabler 的 TDD 顺序（TDD §1）；#3 V1 拆三个独立负例（Test matrix §B）；#4 run-infra 读取时机由开放风险改为已核实事实（Ship/rollout + Risks）。

## Acceptance（Annie 视角）

Honey Lemon 对带 `Flywheel-Product` + `product`/`pm`/`ux`/`design` 标签的 issue 自动派活，Runner 拿到「产品/设计」执行器角色（不再掉 generic、不再需要 `agentName` 手工绕）；Tadashi 派 doc/design 活一切照旧；其他项目 / 其他 dept / 未声明 departments 的 agent 零感知。
