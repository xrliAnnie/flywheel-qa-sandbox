# FLY-901 产品/设计执行器 dual-register — QA 报告

Issue: FLY-901 (https://linear.app/geoforge3d/issue/FLY-901/产品-lead-派活路由问题product-部门-lead-自动派活够不着产品设计执行器角色)
日期: 2026-07-06
基于: plan.md

## 结论：PASS

实现完全对照 plan.md 的 4 处改动（C1-C4）+ 测试矩阵（A/B/C）逐条核对，独立跑通全部回归 + 新增测试 + 一次针对本分支真实 `.flywheel/config.yaml` 的行为级 E2E（plan §Test matrix D）。未发现代码级问题，未做代码改动，只补一份独立行为级 E2E 脚本作为 QA 证据入库。

## 验证范围

### 1. Diff 逐文件核对（vs plan.md 承诺）

| 文件 | 核对结果 |
|------|---------|
| `packages/config/src/types.ts` | `AgentConfig.departments?: string[]` 字段 + JSDoc 合同，与 C1 一致 |
| `packages/config/src/ConfigLoader.ts` | V1（非数组/空数组/非字符串项）/V2（token 合法性）/V3（去重）/V4（仅 dept-owned）/V5（含 home dept）五条校验，挂在既有单数 `department` 校验紧随其后，与 C2 一致；`department` 校验本体一字未动 |
| `packages/edge-worker/src/AgentDispatcher.ts` | 新增导出 `registeredDepts()` helper + step-2a 从 `parsedDept(cfg.agent_file) !== owningDept` 改为 `!depts.includes(owningDept)`，与 C3 一致；step-2b/3a/3b、`dispatchByName`、`labelsMatch`、entries 顺序零改动 |
| `.flywheel/config.yaml` | `product-designer` 加 `departments: [engineering, product]`，`department: engineering`（home）不变；agents block 前言注释同步改写说明 dual-register 语义；`engineer`/`qa`/`general` 配置零改动 |
| `AgentDispatcher.test.ts` | T1/T1b/T2/T3/T4/T5/T6/T8 + `registeredDepts` 3 条直测，共 11 条新用例，逐条对应 plan Test matrix A |
| `ConfigLoader.test.ts` | 合法通过 1 条 + V1a/V1b/V1c/V2/V3/V4/V5 共 8 条新用例，逐条对应 plan Test matrix B |

未发现 plan 之外的改动，也未发现 plan 承诺但缺失的改动。

### 2. 自动化测试（独立重跑，非信实现者自报）

```
pnpm --filter flywheel-config test -- --run       → 20 files, 340 tests, 全绿（含 ConfigLoader.test.ts 101 tests）
pnpm --filter flywheel-edge-worker test -- --run   → 88 files (83 passed + 5 skipped), 1051 tests, 全绿（含 AgentDispatcher.test.ts 38 tests）
bash scripts/__tests__/test-pm-executor-contract.sh → 16/16 PASS（FLY-880 契约，文件未挪家，零回归）
pnpm lint (biome check .)                           → 本次改动的 6 个文件 0 error / 0 warning
                                                       （仓库其余 2 个 pre-existing error 与本 PR 无关，
                                                       分布在 doc/engineer/research/、
                                                       packages/agent-team-transport/、
                                                       packages/teamlead/、scripts/qa-fly892* 等
                                                       本 PR 未触碰的文件）
```

`pnpm --filter flywheel-edge-worker test` 首次跑因 workspace 包（flywheel-config/flywheel-core 等）未 build 而 52 个文件报 "Failed to resolve entry"（vite 找不到 dist）——这是全新 checkout 未跑 `pnpm build` 的环境态，与本 PR 无关；`pnpm build` 后同一命令 88 个文件全过，无一失败。

### 3. 独立行为级 E2E（plan §Test matrix D 承接）— 新增证据

`scripts/qa-fly-901-real-config-dispatch-e2e.mjs`（已提交，可重跑）：不读测试 fixture，直接用 `ConfigLoader` 加载本分支**真实** `.flywheel/config.yaml`，构造真实 `AgentDispatcher`（编译后 dist，非 mock），驱动与 Blueprint 完全一致的 `dispatch()` 调用：

```
node scripts/qa-fly-901-real-config-dispatch-e2e.mjs
```

结果（11/11 PASS）：
- **S1**：product Lead（`owningDept="product"`）+ label `product` → 命中 `product-designer`，`department` 报告为 `product`（issue 描述的确切场景——**修复前这里会掉到 shipped-generic**，因为旧逻辑 `parsedDept(agent_file)="engineering" !== owningDept="product"`）
- **S1b**：product Lead + `pm`/`ux`/`design`/`designer` 各标签 → 均命中 `product-designer`
- **S2/S2b**：engineering Lead（Tadashi）+ `doc` → 仍命中 `product-designer`（`department=engineering`）；+ `code`/`feat` → 仍命中 `engineer`——零回归
- **S3**：未列出的 dept（`ops`）+ label `product` → 掉 shipped-generic，未被放宽（隔离性验证）
- **S4**：`qa` 执行器（未声明 `departments`，缺省路径派生单 dept）在 engineering Lead 下照旧命中——字节兼容抽查

### 4. 未验证 / 超出本 QA 范围

- **真实 Runner 派发**（plan D 提到的"有条件时走一次真 dispatch，Honey Lemon 对带 product 标签的测试 issue 派活"）—— 需 Honey Lemon（product Lead）在生产/QA 环境实际派发一个测试 issue 并观察 Runner 拿到的 agentContext。这一步涉及真实 Discord/Linear 交互和一次 Bridge 重启（plan Ship/rollout 已注明"engine 代码与 config.yaml 都要经一次 Bridge 重启才进入已初始化 runtime"），按 plan 的攒批纪律不在本次 QA 单独触发；本 QA 的 real-config E2E 已经在**代码层面**证明了重启后 dispatch 的真实行为，重启后再由 Honey Lemon 实际验一次即可视为收尾，不影响本次 PASS 结论。
- projects.json（Lead 注册，department: product）不在本仓库，按 plan Non-goals 排除，未检查。

## 未做代码改动

本次 QA 未对 C1-C4 四处实现做任何修改——审计+测试+新增 E2E 脚本均确认实现与 plan 承诺一致，无需返工。
