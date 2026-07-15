# Exploration: Role-based 执行 Agent Files（一个 Tadashi 罩多角色）— FLY-604

**Issue**: FLY-604 (Setup role-based 执行 agent files — 一个 Tadashi 罩多角色，学 GeoForge3D)
**Date**: 2026-06-26
**Status**: Draft（plan-first / founder-facing — 等 Annie 正式确认 3-role 再 ship）

---

## 1. 目标（Annie 2026-06-26）

让 **Tadashi（Flywheel Eng Lead）像 GeoForge3D 的 Peter 一样：一个 Lead 罩多种角色**。按 FLY issue 的 label，Tadashi 起对应**角色 Runner**。**不开新 Lead，只加几个 agent file + config 路由。** 草稿先过 Annie，OK 才生效。

**角色集（Annie 收窄：5 → 3）**：
1. **engineer**（backend + frontend 合并，一个工程师罩全栈）
2. **qa**
3. **product-designer**（PM + Designer 合一；UX 优先、美观度需求低，不单设 Designer）

## 2. 学 GeoForge3D 的「结构」，但内容是 Flywheel 自己的

学到的结构（已核实代码）：`.flywheel/config.yaml` 的 `agents:` block（FLY-137）→ 每 role 一个 `.flywheel/agents/<dept>/<role>-executor.md` → `AgentDispatcher` 三步选：dept+label match → 顶层 catch-all → shipped generic fallback；`match.labels` 大小写不敏感、可多 alias。

**但不照抄 GeoForge3D 的 agent file 内容**：GeoForge3D 的 executor 全建在 `.claude/orchestrator/track.sh` + SQLite（`state.sh`）这套**重型编排**上，而 **Flywheel 的 Runner pipeline 根本不用它**（走 `flywheel-comm` / Bridge 驱动）。照抄会引用一堆 Flywheel 不存在的 `track.sh` / `.claude/domains/<role>.md` / 项目专属 skill，全是死引用。

→ 所以 3 个 role file 写成**精简版**，对齐 Flywheel 现有的 executor 风格（flywheel-comm 回报、FLY-270 self-hosting ship 纪律、`codex:rescue` review、全仓 `pnpm lint` + `pnpm -r build`），只是按角色分工。skills frontmatter 只列 Flywheel 真实存在的全局 skill。

## 3. 关键决定 ① —— 文件夹放 `engineering/`，不是 `product/`（Tadashi 已批）

Issue 原话写「放 `.flywheel/agents/product/`」。**但那样 label 路由不会生效**：

- `AgentDispatcher` step-2a（dept label match）**只遍历 `parsedDept(agent_file) === owningDept` 的 agent**。
- `owningDept` 来自**哪个 Lead 命中这个 issue**（`DepartmentRegistry.getDepartmentForIssue`）。Flywheel 的工程 Lead 是 Tadashi，他在 `~/.flywheel/projects.json` 里 `department: "engineering"`。
- 所以 FLY issue 的 `owningDept` 永远是 `engineering`。放 `product/` 的 agent，`parsedDept = "product" ≠ "engineering"` → step-2a 永远轮不到 → 只能靠显式 `agentName` 起，**永远不被 label 自动路由**。

> GeoForge3D 用 `product/` 是因为它的 product Lead（Peter）dept 解析成 `product`。**文件夹名 == 起它的 Lead 的 department**，是隐藏不变式。Flywheel 的那个 Lead 是 engineering。

**决定：3 个 role file 放 `.flywheel/agents/engineering/`**。Tadashi 已批。

## 4. 关键决定 ② —— REPLACE（不是 augment）：一执行器一角色、零重叠（Tadashi 已定）

Tadashi 拍：3 个角色**替换**旧的 coarse `code` / `docs`，不是并存（并存会让旧 code/docs 跟新 role 重叠成一堆，正是 Annie「收窄到 3」要消的乱）：

| 旧 → 新 | 关系 |
|---------|------|
| **engineer** ← `code-executor` | 重命名 + 合并 frontend（一个工程师罩全栈实现） |
| **product-designer** ← `docs-executor` | 重命名 + 加 UX/product/PM 定位（产品/设计/文档合一） |
| **qa** | 新建（独立验证，不写产品代码） |
| **general** | 保留（顶层 catch-all，仅 `agentName:"general"` 显式起） |

**铁律（Tadashi 强调）**：现有 issue 的 `code`/`docs` label **必须仍能 route** —— 全部迁到 engineer/product-designer，一个都不漏。最终 label 映射：

| Role | Labels | Agent file |
|------|--------|------------|
| **engineer** | code / feat / fix / refactor / test / infra / tooling / bug（← 旧 code）+ backend / frontend / api / server / ui / web / be / fe / eng（新技术域）+ **research / plan**（技术研究/实现计划，← 旧 docs） | engineering/engineer-executor.md |
| **qa** | qa / testing | engineering/qa-executor.md |
| **product-designer** | doc / docs / design（← 旧 docs，design = UX 设计）+ product / pm / ux / designer（新产品/UX） | engineering/product-designer-executor.md |
| **general** | （空，仅 agentName:"general"） | general-executor.md |

零冲突核对：engineer / qa / product-designer 三组 label 互斥（同 dept 内 first-match 无碰撞）。

### research / plan 的语义归属 —— Tadashi 定：整体归 engineer（Option B）

`research` / `plan` 旧属 docs。Flywheel 的 research/plan **大多是技术性**的（如「research Codex long-running work」「写实现 plan」），所以 Tadashi 拍：**这两个 label 整体归 `engineer`**（技术研究 + 实现计划）。若默认放 product-designer，裸 `research` 会把技术研究误路到产品/设计角色。

`product-designer` 保留 product / pm / ux / designer + doc / docs + **design**（design = UX 设计归它）。即：**技术 research/plan → engineer；产品/UX 探索 + 设计 spec + 一般文档 → product-designer**。

## 5. 关键决定 ③（回答 Annie 的「谁做的」）—— plan-generator / general / qa-plan-generator

- **general-executor.md** —— **Flywheel 里有**，是项目自己的**顶层 catch-all**（`match.labels: []`，赢不了 label 路由，只能 `agentName:"general"` 显式起；它和 Flywheel 内置的 `agents/generic-executor.md` step-3 兜底是两回事）。**保留不动**。
- **plan-generator-executor.md** —— **Flywheel 里没有**。它是 **GeoForge3D 的 Orchestrator skill 模板带进来的** executor，由 **dag-orchestrator 直接 spawn**（不经 AgentDispatcher 选），且它自己的 frontmatter 写着 **DEPRECATED**（已被 designer → Linear issue → engineering agent 流程替代）。Flywheel pipeline 不用 → **不移植**。
- **qa-plan-generator-executor.md** —— 同样 **Flywheel 里没有**，GeoForge3D 专属、orchestrator 直接 spawn（从 QA 报告生成修复 plan），绑死在 `.claude/orchestrator/` + SQLite 上。Flywheel 不用 → **不移植**。

> 一句话：plan-generator / qa-plan-generator 是 **GeoForge3D Orchestrator 模板的产物**，不是可派发的角色 agent，也不在 Flywheel 的 Runner pipeline 里。Flywheel 的 `.claude/orchestrator/` 目录残留了一点模板脚手架（state.sh 等），但**没接进 Runner pipeline**，是 vestigial。

## 6. 交付物 & 生效路径

变更：
- **新增** `.flywheel/agents/engineering/{engineer,qa,product-designer}-executor.md`
- **删除** `.flywheel/agents/engineering/{code,docs}-executor.md`（被 engineer/product-designer 取代）
- **改** `.flywheel/config.yaml` 的 `agents:` block（engineer/qa/product-designer/general，迁全部旧 label）
- **改** `.flywheel/agents/general-executor.md`（指针从 code/docs-executor 改到 engineer/product-designer-executor）
- 本 exploration 文档（founder-facing 中文说明）

路径：草稿 → 报 Tadashi → 转 Annie 过目 → **她正式确认 3-role + OK 后**才开 PR → `approve_to_ship` gate 再过 Annie → merge → 随常规 deploy 生效（config 在 Bridge boot 时读）。

## 7. 设计取舍

- **REPLACE**：一执行器一角色、零重叠（Annie 要消乱的本意）；铁律保旧 label 不掉。
- **精简优先**：role file 对齐 Flywheel 现有 executor 风格，不引入 GeoForge3D 的 track.sh/SQLite 重型编排。
- **founder-facing**：角色定义 = 「活怎么干」，所以过 Annie 才生效。
- **一个待你定**：research/plan 的语义归属（§4 末）。
